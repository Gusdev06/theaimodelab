import { BrandKey, brandKeyFor, resolveBrand } from '../brand/brand';
import { Injectable, ConflictException, UnauthorizedException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';
import * as bcrypt from 'bcrypt';
import { User } from '@prisma/client';
import { randomBytes, createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { LocaleContext } from '../common/utils/locale.util';
import { t } from '../common/i18n/t';
import { PendingGrantsService } from '../pending-grants/pending-grants.service';
import { TrackingDto } from './dto/tracking.dto';
import { MetaConversionsService, MetaRequestContext } from '../meta/meta-conversions.service';
import { WelcomeCreditsService } from './welcome-credits.service';
import { accountDisabledException } from './strategies/jwt.strategy';
import { ReferralsService } from '../referrals/referrals.service';
import { accessTokenAllowed, googleAudiences } from './google-clients';
import { mailLocaleFor } from '../email/brand-email';
import { NoAccountPurchasesClaimer } from '../pending-grants/no-account-purchases.claimer';

const SIGNUP_BONUS_CREDITS = 50;

function mapTrackingToUserFields(tracking?: TrackingDto) {
  if (!tracking) return {};
  const fields: Record<string, string | undefined> = {
    utmSource: tracking.utm_source,
    utmMedium: tracking.utm_medium,
    utmCampaign: tracking.utm_campaign,
    utmContent: tracking.utm_content,
    utmTerm: tracking.utm_term,
    fbclid: tracking.fbclid,
    fbp: tracking.fbp,
    fbc: tracking.fbc,
    gclid: tracking.gclid,
    referrer: tracking.referrer,
    landingPage: tracking.landing_page,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v != null && v !== ''),
  );
}

function mapTrackingToMetaContext(tracking?: TrackingDto) {
  if (!tracking) return undefined;
  return {
    eventId: tracking.event_id,
    eventSourceUrl: tracking.event_source_url,
    fbp: tracking.fbp,
    fbc: tracking.fbc,
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly pendingGrantsService: PendingGrantsService,
    private readonly metaConversionsService: MetaConversionsService,
    private readonly welcomeCreditsService: WelcomeCreditsService,
    private readonly referralsService: ReferralsService,
    @Optional() private readonly noAccountPurchases?: NoAccountPurchasesClaimer,
  ) { }

  /**
   * Verifica se email já está em uso
   */
  /** Marca do e-mail deste pedido: o site que pediu vence a marca gravada na conta (src/brand/brand.ts). */
  private emailBrand(requestBrand: BrandKey | null | undefined, storedBrand: string | null | undefined) {
    return resolveBrand(brandKeyFor(requestBrand, storedBrand));
  }

  /**
   * Conta antiga sem marca gravada que aparece por um site reconhecido (hoje só a Funvmake): grava a marca para
   * os e-mails sem pedido (cron, pagamento) saírem no site certo. Só preenche vazio; nunca troca nem atrasa o login.
   */
  private rememberBrand(user: { id: string; signupBrand?: string | null }, brand: BrandKey | null | undefined): void {
    if (!brand || user.signupBrand) return;
    this.prisma.user
      .updateMany({ where: { id: user.id, signupBrand: null }, data: { signupBrand: brand } })
      .catch((err: Error) => this.logger.warn(`rememberBrand ${user.id}: ${err.message}`));
  }

  async checkAvailability(email?: string): Promise<{ emailTaken: boolean }> {
    let emailTaken = false;

    if (email) {
      const existing = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      emailTaken = !!existing;
    }

    return { emailTaken };
  }

  /**
   * Registra um novo usuário
   */
  async register(
    registerDto: RegisterDto,
    locale?: LocaleContext,
    requestContext?: MetaRequestContext,
    brand?: BrandKey | null,
  ): Promise<AuthResponseDto> {
    const { email, password, name, referralCode, tracking } = registerDto;

    // Verifica se o email já está em uso (conta desativada também: o e-mail é único e a criação daria erro 500)
    const existingUser = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: t('errors.auth.EMAIL_ALREADY_EXISTS'),
        code: 'EMAIL_ALREADY_EXISTS',
      });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, 10);

    // Cria o usuário e o saldo de créditos em uma transação
    const user = await this.prisma.$transaction(async (tx) => {
      // Cria o usuário
      // Validar código de referral se fornecido
      let validReferralCode: string | undefined;
      if (referralCode) {
        const affiliate = await tx.affiliate.findUnique({
          where: { code: referralCode.toUpperCase() },
          select: { isActive: true },
        });
        if (affiliate?.isActive) {
          validReferralCode = referralCode.toUpperCase();
        }
      }

      const newUser = await tx.user.create({
        data: {
          email: email.toLowerCase(),
          name,
          passwordHash: hashedPassword,
          isActive: true,
          role: 'USER',
          ...(brand && { signupBrand: brand }),
          ...(validReferralCode && { referredByCode: validReferralCode }),
          ...(locale?.country && { country: locale.country }),
          ...(locale && { currency: locale.currency, locale: locale.locale }),
          ...mapTrackingToUserFields(tracking),
        },
      });

      // Busca o plano Free
      const freePlan = await tx.plan.findFirst({
        where: { slug: 'free' },
      });

      if (!freePlan) {
        throw new BadRequestException('Plano Free não encontrado. Por favor, execute o seed do banco de dados.');
      }

      // Cria a assinatura Free
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      await tx.subscription.create({
        data: {
          userId: newUser.id,
          planId: freePlan.id,
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
      });

      // Cria o saldo inicial de créditos (Free plan começa com 0 em v5, + bônus de signup)
      await tx.creditBalance.create({
        data: {
          userId: newUser.id,
          planCreditsRemaining: 0,
          bonusCreditsRemaining: SIGNUP_BONUS_CREDITS,
          planCreditsUsed: 0,
          periodStart: now,
          periodEnd: periodEnd,
        },
      });

      // Registra transação do bônus de cadastro
      await tx.creditTransaction.create({
        data: {
          userId: newUser.id,
          type: 'ONBOARDING_BONUS',
          amount: SIGNUP_BONUS_CREDITS,
          source: 'bonus',
          description: 'Bônus de boas-vindas ao criar conta',
        },
      });

      // Consome pending grants (ex: compra de curso na Hubla antes do cadastro)
      await this.pendingGrantsService.consumeForUser(newUser.id, newUser.email, tx);

      return newUser;
    });

    // Créditos de boas-vindas (welcome_credits_amount): no cadastro por e-mail caem na CONFIRMAÇÃO do e-mail
    // (verifyEmail), não aqui. A conta entra no app na hora com os 50 do cadastro; os 150 viram a promessa
    // "confirme e libere sua 1ª foto". Google, que já vem verificado, recebe tudo no cadastro (googleAuth).

    // Indicação entre usuários: só quando o código não é de afiliado ativo (esse vira referredByCode).
    // Nunca lança — falha aqui não quebra o signup.
    if (!user.referredByCode) {
      await this.referralsService.attachOnSignup({
        referredUserId: user.id,
        referredEmail: user.email,
        rawCode: referralCode,
        ipAddress: requestContext?.ipAddress,
      });
    }

    // Envia email de verificação (fire-and-forget)
    const verificationCode = this.generateSixDigitCode();
    const verificationCodeHash = createHash('sha256').update(verificationCode).digest('hex');

    await this.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: verificationCodeHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutos
      },
    });

    const pendingWelcome = await this.welcomeCreditsService.pendingAmountFor(user.id);
    this.emailService
      .sendVerificationEmail(user.email, user.name, verificationCode, this.emailBrand(brand, user.signupBrand), {
        locale: mailLocaleFor(user),
        bonusCredits: pendingWelcome,
      })
      .catch((err) => {
        this.logger.error(`Failed to send verification email: ${err.message}`);
      });

    this.metaConversionsService.trackLead(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        phone: user.phone,
        country: user.country,
        fbp: user.fbp,
        fbc: user.fbc,
      },
      mapTrackingToMetaContext(tracking),
      requestContext,
    ).catch((err) => {
      this.logger.error(`Failed to send Meta Lead event: ${err.message}`);
    });

    // Compra feita antes da conta (plano/pacote): aplica antes de entrar, para o app já abrir com ela.
    await this.claimNoAccountPurchases(user);

    // Gera os tokens
    const tokens = await this.generateTokens(user);

    // Retorna a resposta formatada
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.formatUserResponse(user),
      isNewUser: true,
    };
  }

  /**
   * Gera tokens JWT
   */
  /**
   * Gerações grátis compradas (isca) com o e-mail de uma conta que já existia
   * ficavam presas para sempre (TKT-109). Todo login aplica o que estiver
   * pendente; nunca atrasa nem derruba o login.
   */
  private claimPendingGrants(user: User): void {
    void this.pendingGrantsService
      .consumeForUser(user.id, user.email)
      .catch((error: unknown) =>
        this.logger.warn(
          `Grants pendentes de ${user.id} não aplicadas no login: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  /** Saldo total (plano + bônus) para citar no e-mail de boas-vindas. Falha vira undefined (e-mail sem número). */
  private async totalCredits(userId: string): Promise<number | undefined> {
    try {
      const balance = await this.prisma.creditBalance.findUnique({
        where: { userId },
        select: { planCreditsRemaining: true, bonusCreditsRemaining: true },
      });
      return balance ? balance.planCreditsRemaining + balance.bonusCreditsRemaining : undefined;
    } catch (err) {
      this.logger.warn(`totalCredits(${userId}) falhou: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Boas-vindas no idioma da conta com o saldo real (fire-and-forget: nunca atrasa nem derruba o fluxo). */
  private sendWelcome(user: User, brand: BrandKey | null | undefined): void {
    void this.totalCredits(user.id)
      .then((credits) =>
        this.emailService.sendWelcomeEmail(user.email, user.name, this.emailBrand(brand, user.signupBrand), {
          locale: mailLocaleFor(user),
          credits,
        }),
      )
      .catch((err: Error) => {
        this.logger.error(`Failed to send welcome email: ${err.message}`);
      });
  }

  /**
   * Plano ou pacote pago ANTES de existir conta com este e-mail (B-01): aplica agora, pelo mesmo handler do
   * webhook e com a mesma idempotência do pagamento. Nunca lança nem derruba o cadastro/login.
   */
  private async claimNoAccountPurchases(user: User): Promise<void> {
    if (!this.noAccountPurchases) return;
    try {
      const { applied } = await this.noAccountPurchases.claimForUser(user);
      if (applied > 0) this.logger.log(`${applied} compra(s) feita(s) antes da conta aplicada(s) em ${user.id}`);
    } catch (error) {
      this.logger.warn(
        `Compras sem conta de ${user.id} não aplicadas: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async generateTokens(user: User) {
    this.claimPendingGrants(user);
    // login, refresh e Google: a venda guardada entra em segundo plano (consulta barata pelo índice do e-mail)
    void this.claimNoAccountPurchases(user);
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    // Gera access token (15 minutos)
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: '15m',
    });

    // Gera refresh token (7 dias)
    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('hex');

    // Salva o refresh token no banco
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refreshTokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 dias
      },
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  /**
   * Formata a resposta do usuário
   */
  private formatUserResponse(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl || '',
      role: user.role,
      emailVerified: user.emailVerified,
      hasCompletedOnboarding: user.hasCompletedOnboarding,
      termsAcceptedAt: user.termsAcceptedAt,
      termsVersion: user.termsVersion,
      imageDeclarationAt: user.imageDeclarationAt ?? null,
      createdAt: user.createdAt,
    };
  }

  /**
   * Valida um usuário por email e senha
   */
  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({
      where: {
        email: email.toLowerCase(),
        isActive: true,
      },
    });

    if (!user || !user.passwordHash) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  /**
   * Login do usuário
   */
  async login(email: string, password: string, brand?: BrandKey | null): Promise<AuthResponseDto> {
    const user = await this.validateUser(email, password);

    if (!user) {
      throw new UnauthorizedException(t('errors.auth.INVALID_CREDENTIALS'));
    }

    if (!user.emailVerified) {
      throw new UnauthorizedException({ message: t('errors.auth.EMAIL_NOT_VERIFIED'), code: 'EMAIL_NOT_VERIFIED' });
    }

    this.rememberBrand(user, brand);
    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.formatUserResponse(user),
    };
  }

  /**
   * Login/Cadastro via Google OAuth (verifica ID token ou access token)
   */
  async googleAuthWithToken(
    googleToken: string,
    referralCode?: string,
    locale?: LocaleContext,
    tracking?: TrackingDto,
    requestContext?: MetaRequestContext,
    brand?: BrandKey | null,
  ): Promise<AuthResponseDto> {
    // Primeiro confere o token; só depois entra no login. Assim o erro do login (conta desativada, banco fora)
    // chega como é, em vez de virar "token inválido" ou disparar a 2ª tentativa como access token.
    const profile = await this.verifyGoogleToken(googleToken);
    return this.googleAuth({
      ...profile,
      provider: 'google',
      referralCode,
      tracking,
    }, locale, requestContext, brand);
  }

  /** Confere o token do Google (ID token primeiro, depois access token) e devolve quem é a pessoa. */
  private async verifyGoogleToken(
    googleToken: string,
  ): Promise<{ googleId: string; email: string; name: string; avatarUrl?: string }> {
    try {
      const { OAuth2Client } = await import('google-auth-library');
      // cliente desta API + os extras (GOOGLE_EXTRA_CLIENT_IDS), ex.: o site da Funvmake com o próprio cliente Google
      const audiences = googleAudiences(
        this.configService.get<string>('GOOGLE_CLIENT_ID'),
        this.configService.get<string>('GOOGLE_EXTRA_CLIENT_IDS'),
      );
      const client = new OAuth2Client(this.configService.get('GOOGLE_CLIENT_ID'));

      // Tenta verificar como ID token primeiro
      try {
        const ticket = await client.verifyIdToken({
          idToken: googleToken,
          audience: audiences,
        });

        const payload = ticket.getPayload();

        if (!payload || !payload.email || !payload.sub) {
          throw new Error('Invalid ID token payload');
        }

        return {
          googleId: payload.sub,
          email: payload.email,
          name: payload.name || payload.email.split('@')[0],
          avatarUrl: payload.picture,
        };
      } catch {
        // Se falhar como ID token, tenta como access token.
        // Trava opcional (GOOGLE_ACCESS_TOKEN_AUD_CHECK=true): o token precisa ter sido emitido para um dos clientes
        // aceitos. Sem ela, um token de qualquer app Google em que a pessoa entrou serve para entrar aqui.
        if (this.configService.get('GOOGLE_ACCESS_TOKEN_AUD_CHECK') === 'true') {
          const infoRes = await fetch('https://oauth2.googleapis.com/tokeninfo', {
            method: 'POST',
            body: new URLSearchParams({ access_token: googleToken }),
          });
          const info = infoRes.ok ? await infoRes.json() : null;
          if (!accessTokenAllowed(info, audiences)) {
            throw new UnauthorizedException('Token Google inválido');
          }
        }

        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${googleToken}` },
        });

        if (!response.ok) {
          throw new UnauthorizedException('Token Google inválido');
        }

        const userInfo = (await response.json()) as {
          sub?: unknown;
          email?: unknown;
          name?: unknown;
          picture?: unknown;
        };

        // sem o id do Google, a busca por oauthProviderId viraria filtro vazio e acharia qualquer conta Google
        if (
          typeof userInfo.email !== 'string' ||
          !userInfo.email ||
          typeof userInfo.sub !== 'string' ||
          !userInfo.sub
        ) {
          throw new UnauthorizedException('Token Google inválido');
        }

        return {
          googleId: userInfo.sub,
          email: userInfo.email,
          name:
            typeof userInfo.name === 'string' && userInfo.name
              ? userInfo.name
              : userInfo.email.split('@')[0],
          avatarUrl:
            typeof userInfo.picture === 'string' ? userInfo.picture : undefined,
        };
      }
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Token Google inválido ou expirado');
    }
  }

  /**
   * Login/Cadastro via Google OAuth
   */
  async googleAuth(googleUser: {
    googleId: string;
    email: string;
    name: string;
    avatarUrl?: string;
    provider: string;
    referralCode?: string;
    tracking?: TrackingDto;
  }, locale?: LocaleContext, requestContext?: MetaRequestContext, brand?: BrandKey | null): Promise<AuthResponseDto> {
    // Busca usuário existente por email ou Google ID
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: googleUser.email.toLowerCase() },
          {
            AND: [
              { oauthProvider: 'google' },
              { oauthProviderId: googleUser.googleId }
            ]
          }
        ],
      },
    });

    let isNewUser = false;

    // Conta desativada (bloqueio, guarda legal, exclusão ou a própria pessoa desativou) não entra pelo Google:
    // recusa antes de vincular, criar ou emitir qualquer token
    if (user && !user.isActive) {
      this.logger.warn(`googleAuth: login recusado, conta ${user.id} desativada`);
      throw accountDisabledException();
    }

    if (user) {
      this.rememberBrand(user, brand);
      // Se o usuário existe mas não tinha OAuth, atualiza
      if (!user.oauthProvider) {
        const wasUnverified = !user.emailVerified;
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            oauthProvider: 'google',
            oauthProviderId: googleUser.googleId,
            emailVerified: true, // Google já verifica o email
            avatarUrl: user.avatarUrl || googleUser.avatarUrl,
          },
        });
        // Conta por e-mail que nunca confirmou e agora entrou pelo Google: e-mail confirmado, o bônus pendente cai
        // (idempotente: quem já recebeu não recebe de novo).
        if (wasUnverified) {
          await this.welcomeCreditsService.grantIfEligible(user.id);
        }
      }
    } else {
      isNewUser = true;
      // Cria novo usuário via Google OAuth
      user = await this.prisma.$transaction(async (tx) => {
        // Validar código de referral se fornecido
        let validReferralCode: string | undefined;
        if (googleUser.referralCode) {
          const affiliate = await tx.affiliate.findUnique({
            where: { code: googleUser.referralCode.toUpperCase() },
            select: { isActive: true },
          });
          if (affiliate?.isActive) {
            validReferralCode = googleUser.referralCode.toUpperCase();
          }
        }

        // Cria o usuário
        const newUser = await tx.user.create({
          data: {
            email: googleUser.email.toLowerCase(),
            name: googleUser.name,
            avatarUrl: googleUser.avatarUrl,
            oauthProvider: 'google',
            oauthProviderId: googleUser.googleId,
            emailVerified: true, // Google já verifica o email
            role: 'USER',
            ...(brand && { signupBrand: brand }),
            ...(validReferralCode && { referredByCode: validReferralCode }),
            ...(locale?.country && { country: locale.country }),
            ...(locale && { currency: locale.currency, locale: locale.locale }),
            ...mapTrackingToUserFields(googleUser.tracking),
          },
        });

        // Busca o plano Free
        const freePlan = await tx.plan.findFirst({
          where: { slug: 'free' },
        });

        if (!freePlan) {
          throw new BadRequestException('Plano Free não encontrado. Por favor, execute o seed do banco de dados.');
        }

        // Cria a assinatura Free
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        await tx.subscription.create({
          data: {
            userId: newUser.id,
            planId: freePlan.id,
            status: 'ACTIVE',
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        });

        // Cria o saldo inicial de créditos (Free plan começa com 0 em v5, + bônus de signup)
        await tx.creditBalance.create({
          data: {
            userId: newUser.id,
            planCreditsRemaining: 0,
            bonusCreditsRemaining: SIGNUP_BONUS_CREDITS,
            planCreditsUsed: 0,
            periodStart: now,
            periodEnd: periodEnd,
          },
        });

        // Registra transação do bônus de cadastro
        await tx.creditTransaction.create({
          data: {
            userId: newUser.id,
            type: 'ONBOARDING_BONUS',
            amount: SIGNUP_BONUS_CREDITS,
            source: 'bonus',
            description: 'Bônus de boas-vindas ao criar conta',
          },
        });

        // Consome pending grants (ex: compra de curso na Hubla antes do cadastro)
        await this.pendingGrantsService.consumeForUser(newUser.id, newUser.email, tx);

        return newUser;
      });
    }

    // Envia welcome email para novos usuários Google (fire-and-forget)
    if (isNewUser) {
      // Compra feita antes da conta (plano/pacote): aplica antes de entrar.
      await this.claimNoAccountPurchases(user);

      // Concede créditos de boas-vindas (env WELCOME_CREDITS_AMOUNT; default OFF).
      // Idempotente e à prova de falhas — nunca quebra o login/cadastro Google.
      await this.welcomeCreditsService.grantIfEligible(user.id);

      // Sem IP de propósito: no site, quem chama esta rota é o servidor do Next (callback do
      // Google), então o IP seria o mesmo para todo mundo e jogaria toda indicação na revisão.
      if (!user.referredByCode) {
        await this.referralsService.attachOnSignup({
          referredUserId: user.id,
          referredEmail: user.email,
          rawCode: googleUser.referralCode,
        });
      }

      this.sendWelcome(user, brand);

      this.metaConversionsService.trackLead(
        {
          id: user.id,
          email: user.email,
          name: user.name,
          phone: user.phone,
          country: user.country,
          fbp: user.fbp,
          fbc: user.fbc,
        },
        mapTrackingToMetaContext(googleUser.tracking),
        requestContext,
      ).catch((err) => {
        this.logger.error(`Failed to send Meta Google Lead event: ${err.message}`);
      });
    }

    // Gera os tokens
    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.formatUserResponse(user),
      isNewUser,
    };
  }

  async refreshTokens(refreshToken: string): Promise<AuthResponseDto> {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    const storedToken = await this.prisma.refreshToken.findFirst({
      where: {
        tokenHash,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Token inválido ou expirado');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: storedToken.userId, isActive: true },
    });

    if (!user) {
      throw new UnauthorizedException('Usuário não encontrado');
    }

    // Revoke old token
    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked: true },
    });

    // Generate new tokens
    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.formatUserResponse(user),
    };
  }

  async logout(refreshToken: string): Promise<{ message: string }> {
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');

    await this.prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revoked: true },
    });

    return { message: 'Logout realizado com sucesso' };
  }

  /**
   * Verifica email do usuário usando o token enviado por email
   */
  async verifyEmail(
    code: string,
    brand?: BrandKey | null,
  ): Promise<{ message: string; welcomeCreditsGranted: number }> {
    const tokenHash = createHash('sha256').update(code).digest('hex');

    const verificationToken = await this.prisma.emailVerificationToken.findFirst({
      where: {
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!verificationToken) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: t('errors.auth.INVALID_CODE'),
        code: 'INVALID_CODE',
      });
    }

    // Consome o código de forma atômica: com o bônus caindo aqui, um duplo toque no "Confirmar" (ou duas abas)
    // não pode passar 2× e creditar o welcome em dobro. Só a chamada que virou o `used` segue.
    const consumed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.emailVerificationToken.updateMany({
        where: { id: verificationToken.id, used: false },
        data: { used: true },
      });
      if (count === 0) return false;

      await tx.user.update({
        where: { id: verificationToken.userId },
        data: { emailVerified: true },
      });
      return true;
    });

    if (!consumed) {
      // A outra chamada já confirmou e já cuida do bônus e do e-mail de boas-vindas.
      return { message: 'Email verificado com sucesso', welcomeCreditsGranted: 0 };
    }

    // A indicação desta conta pode estar só esperando o e-mail confirmado (tryReward nunca lança).
    void this.referralsService.tryReward(verificationToken.userId);

    // Cadastro por e-mail: os créditos de boas-vindas caem agora (idempotente; nunca lança). O site usa o número
    // devolvido para mostrar "+150 créditos" na hora.
    const welcomeCreditsGranted = await this.welcomeCreditsService.grantIfEligible(verificationToken.userId);

    // Busca o usuário para enviar welcome email
    const user = await this.prisma.user.findUnique({
      where: { id: verificationToken.userId },
    });

    if (user) {
      this.rememberBrand(user, brand);
      this.sendWelcome(user, brand);
    }

    return { message: 'Email verificado com sucesso', welcomeCreditsGranted };
  }

  /**
   * Reenvia email de verificação para o usuário pelo email
   */
  async resendVerificationEmail(email: string, brand?: BrandKey | null): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase(), isActive: true },
    });

    // Não revela se o email existe para evitar enumeração de contas
    if (!user || user.emailVerified) {
      return { message: 'Se o email existir e não estiver verificado, um novo link será enviado' };
    }

    // Rate limit: verifica se o último token foi criado há menos de 1 minuto
    const lastToken = await this.prisma.emailVerificationToken.findFirst({
      where: { userId: user.id, used: false },
      orderBy: { createdAt: 'desc' },
    });

    if (lastToken && lastToken.createdAt.getTime() > Date.now() - 60 * 1000) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: t('errors.auth.RESEND_WAIT'),
        code: 'RESEND_WAIT',
      });
    }

    // Invalida tokens anteriores
    await this.prisma.emailVerificationToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // Gera novo código
    const verificationCode = this.generateSixDigitCode();
    const tokenHash = createHash('sha256').update(verificationCode).digest('hex');

    await this.prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutos
      },
    });

    const pendingWelcome = await this.welcomeCreditsService.pendingAmountFor(user.id);
    this.emailService
      .sendVerificationEmail(user.email, user.name, verificationCode, this.emailBrand(brand, user.signupBrand), {
        locale: mailLocaleFor(user),
        bonusCredits: pendingWelcome,
      })
      .catch((err) => {
        this.logger.error(`Failed to send verification email: ${err.message}`);
      });

    return { message: 'Se o email existir e não estiver verificado, um novo link será enviado' };
  }

  /**
   * Solicita reset de senha — gera token e retorna (dev) ou envia email (prod)
   */
  async forgotPassword(email: string, brand?: BrandKey | null): Promise<{ message: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    const successMessage = 'Se o email existir, instruções de reset serão enviadas';

    // A resposta ao cliente é sempre a mesma (não revela se o email existe,
    // é conta OAuth ou está inativa), mas cada caso é logado internamente
    // para diagnosticar "envios fantasma" — emails que nunca chegam.
    if (!user) {
      this.logger.warn(`forgotPassword: nenhum usuário ativo com email ${normalizedEmail}`);
      return { message: successMessage };
    }

    if (!user.isActive) {
      this.logger.warn(`forgotPassword: conta inativa para ${normalizedEmail} (id=${user.id})`);
      return { message: successMessage };
    }

    if (!user.passwordHash) {
      // Conta criada via OAuth (Google) — não há senha para resetar.
      // Em vez de silêncio, envia email informativo para o usuário entender.
      this.logger.warn(
        `forgotPassword: conta OAuth-only para ${normalizedEmail} (id=${user.id}) — enviando email de login Google`,
      );
      this.emailService.sendOAuthLoginInfoEmail(user.email, user.name, this.emailBrand(brand, user.signupBrand)).catch((err) => {
        this.logger.error(`Failed to send OAuth login info email: ${err.message}`);
      });
      return { message: successMessage };
    }

    // Invalida tokens de reset anteriores
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // Gera novo token de reset
    const resetToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');

    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutos
      },
    });

    // Envia email de reset (fire-and-forget)
    this.emailService.sendPasswordResetEmail(user.email, user.name, resetToken, this.emailBrand(brand, user.signupBrand)).catch((err) => {
      this.logger.error(`Failed to send password reset email: ${err.message}`);
    });

    // Em dev, loga o token para testes
    const isDev = this.configService.get('NODE_ENV') !== 'production';
    if (isDev) {
      this.logger.debug(`Reset token for ${email}: ${resetToken}`);
    }

    return { message: successMessage };
  }

  /**
   * Reseta a senha do usuário usando o token de reset
   */
  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!resetToken) {
      throw new BadRequestException('Token inválido ou expirado');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.$transaction(async (tx) => {
      // Atualiza a senha
      await tx.user.update({
        where: { id: resetToken.userId },
        data: { passwordHash: hashedPassword },
      });

      // Invalida o token de reset
      await tx.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { used: true },
      });

      // Revoga todos os refresh tokens por segurança
      await tx.refreshToken.updateMany({
        where: { userId: resetToken.userId },
        data: { revoked: true },
      });
    });

    return { message: 'Senha alterada com sucesso' };
  }

  private generateSixDigitCode(): string {
    const bytes = randomBytes(4);
    const num = bytes.readUInt32BE(0) % 900000 + 100000;
    return num.toString();
  }
}
