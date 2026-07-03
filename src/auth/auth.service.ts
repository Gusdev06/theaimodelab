import { Injectable, ConflictException, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
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
    gclid: tracking.gclid,
    referrer: tracking.referrer,
    landingPage: tracking.landing_page,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v != null && v !== ''),
  );
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
  ) { }

  /**
   * Verifica se email já está em uso
   */
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
  async register(registerDto: RegisterDto, locale?: LocaleContext): Promise<AuthResponseDto> {
    const { email, password, name, referralCode, tracking } = registerDto;

    // Verifica se o email já está em uso
    const existingUser = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase(), isActive: true },
    });

    if (existingUser) {
      throw new ConflictException(t('errors.auth.EMAIL_ALREADY_EXISTS'));
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

    this.emailService.sendVerificationEmail(user.email, user.name, verificationCode).catch((err) => {
      this.logger.error(`Failed to send verification email: ${err.message}`);
    });

    // Gera os tokens
    const tokens = await this.generateTokens(user);

    // Retorna a resposta formatada
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.formatUserResponse(user),
    };
  }

  /**
   * Gera tokens JWT
   */
  private async generateTokens(user: User) {
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
  async login(email: string, password: string): Promise<AuthResponseDto> {
    const user = await this.validateUser(email, password);

    if (!user) {
      throw new UnauthorizedException(t('errors.auth.INVALID_CREDENTIALS'));
    }

    if (!user.emailVerified) {
      throw new UnauthorizedException({ message: 'Email ou senha inválidos', code: 'EMAIL_NOT_VERIFIED' });
    }

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
  async googleAuthWithToken(googleToken: string, referralCode?: string, locale?: LocaleContext, tracking?: TrackingDto): Promise<AuthResponseDto> {
    try {
      const { OAuth2Client } = await import('google-auth-library');
      const client = new OAuth2Client(this.configService.get('GOOGLE_CLIENT_ID'));

      // Tenta verificar como ID token primeiro
      try {
        const ticket = await client.verifyIdToken({
          idToken: googleToken,
          audience: this.configService.get('GOOGLE_CLIENT_ID'),
        });

        const payload = ticket.getPayload();

        if (!payload || !payload.email) {
          throw new Error('Invalid ID token payload');
        }

        return this.googleAuth({
          googleId: payload.sub,
          email: payload.email,
          name: payload.name || payload.email.split('@')[0],
          avatarUrl: payload.picture,
          provider: 'google',
          referralCode,
          tracking,
        }, locale);
      } catch {
        // Se falhar como ID token, tenta como access token
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${googleToken}` },
        });

        if (!response.ok) {
          throw new UnauthorizedException('Token Google inválido');
        }

        const userInfo = await response.json();

        if (!userInfo.email) {
          throw new UnauthorizedException('Token Google inválido');
        }

        return this.googleAuth({
          googleId: userInfo.sub,
          email: userInfo.email,
          name: userInfo.name || userInfo.email.split('@')[0],
          avatarUrl: userInfo.picture,
          provider: 'google',
          referralCode,
          tracking,
        }, locale);
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
  }, locale?: LocaleContext): Promise<AuthResponseDto> {
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

    if (user) {
      // Se o usuário existe mas não tinha OAuth, atualiza
      if (!user.oauthProvider) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            oauthProvider: 'google',
            oauthProviderId: googleUser.googleId,
            emailVerified: true, // Google já verifica o email
            avatarUrl: user.avatarUrl || googleUser.avatarUrl,
          },
        });
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
      this.emailService.sendWelcomeEmail(user.email, user.name).catch((err) => {
        this.logger.error(`Failed to send welcome email: ${err.message}`);
      });
    }

    // Gera os tokens
    const tokens = await this.generateTokens(user);

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: this.formatUserResponse(user),
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
  async verifyEmail(code: string): Promise<{ message: string }> {
    const tokenHash = createHash('sha256').update(code).digest('hex');

    const verificationToken = await this.prisma.emailVerificationToken.findFirst({
      where: {
        tokenHash,
        used: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!verificationToken) {
      throw new BadRequestException('Código inválido ou expirado');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: verificationToken.userId },
        data: { emailVerified: true },
      });

      await tx.emailVerificationToken.update({
        where: { id: verificationToken.id },
        data: { used: true },
      });
    });

    // Busca o usuário para enviar welcome email
    const user = await this.prisma.user.findUnique({
      where: { id: verificationToken.userId },
    });

    if (user) {
      this.emailService.sendWelcomeEmail(user.email, user.name).catch((err) => {
        this.logger.error(`Failed to send welcome email: ${err.message}`);
      });
    }

    return { message: 'Email verificado com sucesso' };
  }

  /**
   * Reenvia email de verificação para o usuário pelo email
   */
  async resendVerificationEmail(email: string): Promise<{ message: string }> {
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
      throw new BadRequestException('Aguarde 1 minuto antes de solicitar outro email de verificação');
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

    this.emailService.sendVerificationEmail(user.email, user.name, verificationCode).catch((err) => {
      this.logger.error(`Failed to send verification email: ${err.message}`);
    });

    return { message: 'Se o email existir e não estiver verificado, um novo link será enviado' };
  }

  /**
   * Solicita reset de senha — gera token e retorna (dev) ou envia email (prod)
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
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
      this.emailService.sendOAuthLoginInfoEmail(user.email, user.name).catch((err) => {
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
    this.emailService.sendPasswordResetEmail(user.email, user.name, resetToken).catch((err) => {
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