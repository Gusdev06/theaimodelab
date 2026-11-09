import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IMAGE_DECLARATION_VERSION_MESSAGE, ImageDeclarationResponseDto } from './dto/image-declaration.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { isKnownImageDeclarationVersion, recordImageDeclaration } from './image-declaration';
import { resolveShownTermsVersion } from './terms.constants';

function maskTaxId(taxId: string | null): string | null {
  if (!taxId) return null;
  const digits = taxId.replace(/\D/g, '');
  if (digits.length === 11) return `•••.•••.•••-${digits.slice(-2)}`;
  if (digits.length === 14) return `••.•••.•••/••••-${digits.slice(-2)}`;
  return null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) { }

  async getProfile(userId: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isActive: true },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { plan: true },
        },
        creditBalance: true,
        feedback: { select: { id: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const activeSubscription = user.subscriptions[0] || null;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      hasCompletedOnboarding: user.hasCompletedOnboarding,
      termsAcceptedAt: user.termsAcceptedAt,
      termsVersion: user.termsVersion,
      imageDeclarationAt: user.imageDeclarationAt ?? null,
      country: user.country,
      locale: user.locale,
      currency: user.currency,
      timezone: user.timezone,
      plan: activeSubscription
        ? {
          slug: activeSubscription.plan.slug,
          name: activeSubscription.plan.name,
          priceCents: activeSubscription.plan.priceCents,
          maxConcurrentGenerations:
            activeSubscription.plan.maxConcurrentGenerations,
          hasWatermark: activeSubscription.plan.hasWatermark,
          hasApiAccess: activeSubscription.plan.hasApiAccess,
        }
        : null,
      credits: user.creditBalance
        ? {
          planCreditsRemaining:
            user.creditBalance.planCreditsRemaining,
          bonusCreditsRemaining:
            user.creditBalance.bonusCreditsRemaining,
          planCreditsUsed: user.creditBalance.planCreditsUsed,
          periodStart: user.creditBalance.periodStart,
          periodEnd: user.creditBalance.periodEnd,
        }
        : null,
      subscription: activeSubscription
        ? {
          status: activeSubscription.status,
          currentPeriodStart: activeSubscription.currentPeriodStart,
          currentPeriodEnd: activeSubscription.currentPeriodEnd,
          cancelAtPeriodEnd: activeSubscription.cancelAtPeriodEnd,
          paymentProvider: activeSubscription.paymentProvider ?? null,
        }
        : null,
      feedbackSubmitted: !!user.feedback,
      hasTaxIdOnFile: !!user.taxId,
      taxIdMasked: maskTaxId(user.taxId),
    };
  }

  async updateProfile(
    userId: string,
    dto: UpdateUserDto,
  ): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isActive: true },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.avatarUrl !== undefined && { avatarUrl: dto.avatarUrl }),
        ...(dto.country !== undefined && { country: dto.country.toUpperCase() }),
        ...(dto.locale !== undefined && { locale: dto.locale }),
        ...(dto.currency !== undefined && { currency: dto.currency.toUpperCase() }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      },
    });

    return this.getProfile(userId);
  }

  /**
   * Registra o aceite explícito do termo de uso do app (18+, responsabilidade
   * pelo conteúdo, acesso da plataforma ao que é gerado). Grava a versão que o
   * app mostrou (ver `resolveShownTermsVersion`). Idempotente e nunca rebaixa:
   * aceitar de novo a mesma versão (ou uma mais antiga) mantém a gravada e a
   * data original.
   */
  async acceptTerms(userId: string, shownVersion?: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isActive: true },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const version = resolveShownTermsVersion(shownVersion);
    if (!user.termsVersion || version > user.termsVersion) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { termsAcceptedAt: new Date(), termsVersion: version },
      });
    }

    return this.getProfile(userId);
  }

  /**
   * Registra na conta a declaração de responsabilidade pelas imagens (a cliente marca uma vez, na primeira criação
   * com foto). Idempotente: quem já declarou fica com a data e a versão da primeira vez. Depois disso a API deixa de
   * exigir `consent_confirmed` a cada pedido desta conta (ver ContentSafetyInterceptor).
   */
  async declareImages(userId: string, version: string): Promise<ImageDeclarationResponseDto> {
    if (!isKnownImageDeclarationVersion(version)) {
      throw new BadRequestException({
        code: 'IMAGE_DECLARATION_VERSION',
        message: IMAGE_DECLARATION_VERSION_MESSAGE,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId, isActive: true },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const declaration = await recordImageDeclaration(this.prisma, userId, version);
    if (!declaration) {
      throw new NotFoundException('Usuário não encontrado');
    }

    return {
      imageDeclarationAt: declaration.imageDeclarationAt,
      imageDeclarationVersion: declaration.imageDeclarationVersion,
    };
  }

  async completeOnboarding(userId: string): Promise<UserProfileResponseDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isActive: true },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (user.hasCompletedOnboarding) {
      return this.getProfile(userId);
    }

    const ONBOARDING_BONUS_CREDITS = 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { hasCompletedOnboarding: true },
      });

      await tx.creditBalance.upsert({
        where: { userId },
        create: {
          userId,
          planCreditsRemaining: 0,
          bonusCreditsRemaining: ONBOARDING_BONUS_CREDITS,
          planCreditsUsed: 0,
        },
        update: {
          bonusCreditsRemaining: { increment: ONBOARDING_BONUS_CREDITS },
        },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          type: 'ONBOARDING_BONUS',
          amount: ONBOARDING_BONUS_CREDITS,
          source: 'bonus',
          description: 'Bônus por completar o onboarding',
        },
      });
    });

    return this.getProfile(userId);
  }

  async deleteAccount(userId: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, isActive: true },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    await this.prisma.$transaction(async (tx) => {
      // Soft delete
      await tx.user.update({
        where: { id: userId },
        data: { isActive: false },
      });

      // Revoke all refresh tokens
      await tx.refreshToken.updateMany({
        where: { userId },
        data: { revoked: true },
      });
    });

    return { message: 'Conta desativada com sucesso' };
  }
}
