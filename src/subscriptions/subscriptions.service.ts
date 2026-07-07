import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { StripeService } from '../payments/stripe.service';
import { AsaasService } from '../payments/asaas.service';
import {
  AsaasSubscriptionsService,
  AsaasPixAutoAuthorization,
} from '../payments/asaas-subscriptions.service';
import { PaymentsService } from '../payments/payments.service';
import { CreditsService } from '../credits/credits.service';
import { SubscriptionResponseDto } from './dto/subscription-response.dto';
import { t } from '../common/i18n/t';
import { MetaConversionsService, MetaRequestContext } from '../meta/meta-conversions.service';
import { MetaEventContextDto } from '../meta/meta-event-context.dto';

const PLAN_ORDER = ['free', 'ultra-basic', 'starter', 'basic', 'creator', 'pro', 'advanced', 'studio'];

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plansService: PlansService,
    private readonly stripeService: StripeService,
    private readonly asaasService: AsaasService,
    private readonly asaasSubscriptionsService: AsaasSubscriptionsService,
    private readonly paymentsService: PaymentsService,
    private readonly creditsService: CreditsService,
    private readonly configService: ConfigService,
    private readonly metaConversionsService: MetaConversionsService,
  ) {}

  async getCurrentSubscription(
    userId: string,
  ): Promise<SubscriptionResponseDto | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'PAST_DUE', 'TRIALING'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true, scheduledPlan: true },
    });

    if (!subscription) {
      return null;
    }

    const dto = this.toResponseDto(subscription);

    // Fetch active discount from Stripe
    if (subscription.externalSubscriptionId) {
      const discount = await this.stripeService.getSubscriptionDiscount(
        subscription.externalSubscriptionId,
      ).catch(() => null);
      if (discount) {
        dto.discount = discount;
      }
    }

    return dto;
  }

  /**
   * Cria sessao do Stripe Billing Portal para o usuario gerenciar cartoes e faturas.
   */
  async createBillingPortalSession(
    userId: string,
  ): Promise<{ portalUrl: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, name: true },
    });

    const customerId = await this.stripeService.getOrCreateCustomer(
      userId,
      user.email,
      user.name,
    );

    const returnUrl = this.configService.get<string>('FRONTEND_URL')?.split(',')[0]?.trim()
      ?? 'http://localhost:3001';

    const portalUrl = await this.stripeService.createBillingPortalSession(
      customerId,
      returnUrl,
    );

    return { portalUrl };
  }

  /**
   * Cria Stripe Checkout Session para assinatura.
   * A subscription local é criada apenas no webhook checkout.session.completed.
   */
  async createSubscription(
    userId: string,
    planSlug: string,
    currencyOverride?: string,
    recoveryPromoCode?: string,
    metaContext?: MetaEventContextDto,
    requestContext?: MetaRequestContext,
  ): Promise<{ checkoutUrl: string }> {
    const plan = await this.plansService.findPlanBySlug(planSlug);

    if (plan.slug === 'free') {
      throw new BadRequestException(
        'Não é possível criar assinatura para o plano Free',
      );
    }

    const existing = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING'] },
        plan: { slug: { not: 'free' } },
      },
      include: { plan: true },
    });

    if (existing) {
      throw new ConflictException(
        'Usuário já possui uma assinatura ativa. Use upgrade ou downgrade.',
      );
    }

    const checkoutUrl = await this.buildCheckoutForPlan(
      userId,
      planSlug,
      0,
      undefined,
      currencyOverride,
      recoveryPromoCode,
      metaContext,
      requestContext,
    );
    return { checkoutUrl };
  }

  async upgrade(
    userId: string,
    planSlug: string,
    currencyOverride?: string,
    metaContext?: MetaEventContextDto,
    requestContext?: MetaRequestContext,
  ): Promise<{ checkoutUrl: string }> {
    const current = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { plan: true },
    });

    const newPlan = await this.plansService.findPlanBySlug(planSlug);
    let discountAmountCents = 0;

    if (current) {
      const currentIdx = PLAN_ORDER.indexOf(current.plan.slug);
      const newIdx = PLAN_ORDER.indexOf(newPlan.slug);

      if (currentIdx === -1 || newIdx === -1) {
        throw new BadRequestException(
          `Plano desconhecido na ordem de upgrade: ${current.plan.slug} → ${newPlan.slug}`,
        );
      }

      if (newIdx === currentIdx) {
        throw new BadRequestException(t('errors.subscriptions.SAME_PLAN'));
      }

      // Desconto = valor real que o usuario esta pagando no plano atual
      // Se tem desconto de retencao ativo, usar o valor com desconto (nao o preco cheio)
      if (newIdx > currentIdx && current.plan.slug !== 'free') {
        let actualPriceCents = current.plan.priceCents;

        if (current.externalSubscriptionId) {
          const discount = await this.stripeService.getSubscriptionDiscount(
            current.externalSubscriptionId,
          ).catch(() => null);

          if (discount?.percentOff && discount.remainingMonths && discount.remainingMonths > 0) {
            actualPriceCents = Math.round(
              current.plan.priceCents * (1 - discount.percentOff / 100),
            );
          } else if (discount?.amountOffCents && discount.remainingMonths && discount.remainingMonths > 0) {
            actualPriceCents = Math.max(
              0,
              current.plan.priceCents - discount.amountOffCents,
            );
          }
        }

        discountAmountCents = actualPriceCents;
      }
    }

    // Redirecionar para Stripe Checkout (com desconto se upgrade de plano pago)
    // A sub antiga NÃO é cancelada aqui — só será cancelada no webhook
    // checkout.session.completed, evitando que o usuário fique sem plano se desistir.
    const oldExternalSubscriptionId = current?.externalSubscriptionId ?? undefined;
    const checkoutUrl = await this.buildCheckoutForPlan(
      userId,
      planSlug,
      discountAmountCents,
      oldExternalSubscriptionId,
      currencyOverride,
      undefined,
      metaContext,
      requestContext,
    );
    return { checkoutUrl };
  }

  async downgrade(
    userId: string,
    planSlug: string,
  ): Promise<SubscriptionResponseDto> {
    const current = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING'] },
      },
      include: { plan: true },
    });

    if (!current) {
      throw new NotFoundException(t('errors.subscriptions.NO_ACTIVE_SUBSCRIPTION'));
    }

    const newPlan = await this.plansService.findPlanBySlug(planSlug);

    const currentIdx = PLAN_ORDER.indexOf(current.plan.slug);
    const newIdx = PLAN_ORDER.indexOf(newPlan.slug);

    if (currentIdx === -1 || newIdx === -1) {
      throw new BadRequestException(
        `Plano desconhecido na ordem de downgrade: ${current.plan.slug} → ${newPlan.slug}`,
      );
    }

    if (newIdx === currentIdx) {
      throw new BadRequestException(t('errors.subscriptions.SAME_PLAN'));
    }

    if (newIdx > currentIdx) {
      throw new BadRequestException(
        `O plano "${newPlan.slug}" não é inferior ao atual. Use upgrade.`,
      );
    }

    // Downgrade para Free = cancelar no fim do período
    if (newPlan.slug === 'free') {
      if (current.externalSubscriptionId) {
        await this.stripeService.cancelSubscription(
          current.externalSubscriptionId,
        );
      }
      const subscription = await this.prisma.subscription.update({
        where: { id: current.id },
        data: {
          cancelAtPeriodEnd: true,
          scheduledPlanId: newPlan.id,
        },
        include: { plan: true, scheduledPlan: true },
      });
      return this.toResponseDto(subscription);
    }

    // Downgrade para plano pago inferior: atualizar price no Stripe (sem proration)
    if (!current.externalSubscriptionId) {
      throw new BadRequestException(t('errors.subscriptions.NO_STRIPE_LINK'));
    }

    const userCurrency = await this.getUserCurrency(userId);
    const resolvedNew = await this.plansService.resolvePlanPrice(newPlan.id, userCurrency);

    await this.stripeService.scheduleSubscriptionPlanChange(
      current.externalSubscriptionId,
      resolvedNew.stripePriceId,
    );

    const subscription = await this.prisma.subscription.update({
      where: { id: current.id },
      data: { scheduledPlanId: newPlan.id },
      include: { plan: true, scheduledPlan: true },
    });

    return this.toResponseDto(subscription);
  }

  async cancel(userId: string): Promise<SubscriptionResponseDto> {
    const current = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
      },
      include: { plan: true },
    });

    if (!current) {
      throw new NotFoundException(t('errors.subscriptions.NO_ACTIVE_SUBSCRIPTION'));
    }

    if (current.cancelAtPeriodEnd) {
      throw new BadRequestException(t('errors.subscriptions.ALREADY_CANCELED'));
    }

    // If a paid downgrade was pending, revert the Stripe price before canceling
    if (current.scheduledPlanId && current.externalSubscriptionId) {
      const userCurrency = await this.getUserCurrency(userId);
      const resolved = await this.plansService.resolvePlanPrice(current.plan.id, userCurrency);
      await this.stripeService.scheduleSubscriptionPlanChange(
        current.externalSubscriptionId,
        resolved.stripePriceId,
      );
    }

    // Cancelar no Stripe (cancel_at_period_end)
    if (current.externalSubscriptionId) {
      await this.stripeService.cancelSubscription(
        current.externalSubscriptionId,
      );
    }

    const subscription = await this.prisma.subscription.update({
      where: { id: current.id },
      data: { cancelAtPeriodEnd: true, scheduledPlanId: null },
      include: { plan: true, scheduledPlan: true },
    });

    return this.toResponseDto(subscription);
  }

  async pause(userId: string, durationDays = 30): Promise<SubscriptionResponseDto> {
    const current = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
        pausedUntil: null,
      },
      include: { plan: true },
    });

    if (!current) {
      throw new NotFoundException(
        'Nenhuma assinatura ativa encontrada para pausar',
      );
    }

    if (current.plan.slug === 'free') {
      throw new BadRequestException(t('errors.subscriptions.CANNOT_PAUSE_FREE'));
    }

    const resumesAt = new Date();
    resumesAt.setDate(resumesAt.getDate() + durationDays);

    // Pausar no Stripe
    if (current.externalSubscriptionId) {
      await this.stripeService.pauseSubscription(
        current.externalSubscriptionId,
        resumesAt,
      );
    }

    const subscription = await this.prisma.subscription.update({
      where: { id: current.id },
      data: { pausedUntil: resumesAt },
      include: { plan: true },
    });

    return this.toResponseDto(subscription);
  }

  async cancelDowngrade(userId: string): Promise<SubscriptionResponseDto> {
    const current = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        scheduledPlanId: { not: null },
      },
      include: { plan: true, scheduledPlan: true },
    });

    if (!current || !current.scheduledPlanId) {
      throw new NotFoundException(
        'Nenhum downgrade agendado encontrado',
      );
    }

    // If downgrade to free (cancel at period end), revert the cancellation in Stripe
    if (current.cancelAtPeriodEnd && current.externalSubscriptionId) {
      await this.stripeService.reactivateSubscription(
        current.externalSubscriptionId,
      );
    }

    // If downgrade to a paid plan, revert the Stripe price back to the current plan
    if (!current.cancelAtPeriodEnd && current.externalSubscriptionId) {
      const userCurrency = await this.getUserCurrency(userId);
      const resolved = await this.plansService.resolvePlanPrice(current.plan.id, userCurrency);
      await this.stripeService.scheduleSubscriptionPlanChange(
        current.externalSubscriptionId,
        resolved.stripePriceId,
      );
    }

    const subscription = await this.prisma.subscription.update({
      where: { id: current.id },
      data: {
        scheduledPlanId: null,
        cancelAtPeriodEnd: false,
      },
      include: { plan: true, scheduledPlan: true },
    });

    return this.toResponseDto(subscription);
  }

  async reactivate(userId: string): Promise<SubscriptionResponseDto> {
    const current = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        cancelAtPeriodEnd: true,
      },
      include: { plan: true },
    });

    if (!current) {
      throw new NotFoundException(
        'Nenhuma assinatura ativa com cancelamento pendente encontrada',
      );
    }

    // Reativar no Stripe
    if (current.externalSubscriptionId) {
      await this.stripeService.reactivateSubscription(
        current.externalSubscriptionId,
      );
    }

    // If there was a pending downgrade, revert Stripe price back to current plan
    if (current.scheduledPlanId && current.externalSubscriptionId) {
      const userCurrency = await this.getUserCurrency(userId);
      const resolved = await this.plansService.resolvePlanPrice(current.plan.id, userCurrency);
      await this.stripeService.scheduleSubscriptionPlanChange(
        current.externalSubscriptionId,
        resolved.stripePriceId,
      );
    }

    const subscription = await this.prisma.subscription.update({
      where: { id: current.id },
      data: { cancelAtPeriodEnd: false, scheduledPlanId: null },
      include: { plan: true, scheduledPlan: true },
    });

    return this.toResponseDto(subscription);
  }

  async acceptOffer(
    userId: string,
    reason: string,
  ): Promise<{ offerType: string; detail: string }> {
    const current = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
      },
      include: { plan: true },
    });

    if (!current) {
      throw new NotFoundException(t('errors.subscriptions.NO_ACTIVE_SUBSCRIPTION'));
    }

    if (current.plan.slug === 'free') {
      throw new BadRequestException('Plano Free nao possui ofertas de retencao');
    }

    // Nao permitir oferta em sub ja marcada para cancelamento
    if (current.cancelAtPeriodEnd) {
      throw new BadRequestException(
        'Nao e possivel aceitar oferta em assinatura marcada para cancelamento.',
      );
    }

    // Nao permitir oferta em sub pausada
    if (current.pausedUntil) {
      throw new BadRequestException(
        'Nao e possivel aceitar oferta em assinatura pausada.',
      );
    }

    // Cada assinatura permite apenas 1 oferta de retencao
    if (current.retentionOfferAcceptedAt) {
      throw new BadRequestException(
        'Voce ja aceitou uma oferta de retencao nesta assinatura.',
      );
    }

    // Marcar ANTES de aplicar (previne race condition em requests concorrentes)
    // updateMany com WHERE atomico garante que apenas 1 request passa
    const claimed = await this.prisma.subscription.updateMany({
      where: {
        id: current.id,
        retentionOfferAcceptedAt: null,
      },
      data: { retentionOfferAcceptedAt: new Date() },
    });

    if (claimed.count === 0) {
      throw new BadRequestException(
        'Voce ja aceitou uma oferta de retencao nesta assinatura.',
      );
    }

    let result: { offerType: string; detail: string };

    try {
      switch (reason) {
        case 'expensive': {
          // 15% OFF por 2 meses
          if (!current.externalSubscriptionId) {
            throw new BadRequestException('Assinatura sem vinculo com Stripe');
          }
          await this.stripeService.applyRetentionDiscount(
            current.externalSubscriptionId,
            15,
            2,
            userId,
            reason,
          );
          this.logger.log(`Retention offer accepted: 15% OFF 2 months for user ${userId}`);
          result = { offerType: 'discount', detail: '15% OFF por 2 meses aplicado' };
          break;
        }

        case 'not_using': {
          // +50 creditos bonus
          await this.creditsService.addBonusCredits(
            userId,
            50,
            'Bonus de retencao: +50 creditos para explorar a plataforma',
          );
          this.logger.log(`Retention offer accepted: +50 bonus credits for user ${userId}`);
          result = { offerType: 'bonus_credits', detail: '+50 creditos bonus adicionados' };
          break;
        }

        case 'quality': {
          // +30 creditos bonus
          await this.creditsService.addBonusCredits(
            userId,
            30,
            'Bonus de retencao: +30 creditos para testar melhorias',
          );
          this.logger.log(`Retention offer accepted: +30 bonus credits for user ${userId}`);
          result = { offerType: 'bonus_credits', detail: '+30 creditos bonus adicionados' };
          break;
        }

        case 'competitor': {
          // +100 creditos bonus para comparar
          await this.creditsService.addBonusCredits(
            userId,
            100,
            'Bonus de retencao: +100 creditos para comparar com concorrentes',
          );
          this.logger.log(`Retention offer accepted: +100 bonus credits for user ${userId}`);
          result = { offerType: 'bonus_credits', detail: '+100 creditos bonus adicionados' };
          break;
        }

        case 'temporary': {
          // Pausa de 30 dias (ja implementado via pause())
          await this.pause(userId);
          result = { offerType: 'pause', detail: 'Assinatura pausada por 30 dias' };
          break;
        }

        default: {
          // 20% OFF na proxima renovacao
          if (!current.externalSubscriptionId) {
            throw new BadRequestException('Assinatura sem vinculo com Stripe');
          }
          await this.stripeService.applyRetentionDiscount(
            current.externalSubscriptionId,
            20,
            1,
            userId,
            reason,
          );
          this.logger.log(`Retention offer accepted: 20% OFF next renewal for user ${userId}`);
          result = { offerType: 'discount', detail: '20% OFF na proxima renovacao aplicado' };
          break;
        }
      }
    } catch (error) {
      // Rollback: se a aplicacao falhar, limpar o claim para permitir nova tentativa
      await this.prisma.subscription.update({
        where: { id: current.id },
        data: { retentionOfferAcceptedAt: null },
      });
      throw error;
    }

    return result;
  }

  private async getUserCurrency(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { currency: true },
    });
    return user.currency;
  }

  /**
   * Cria assinatura via PIX Automático (ASAAS). Diferente do Stripe Checkout
   * que redireciona, aqui retornamos o QR Code direto pro front mostrar no modal.
   *
   * Fluxo:
   * 1. Garante CPF e customer ASAAS
   * 2. Cria autorização PIX Auto (POST /pix/automatic/authorizations)
   * 3. Cria Subscription local em TRIALING aguardando webhook
   *    PIX_AUTOMATIC_AUTHORIZATION_ACTIVE que vai ativar a sub e liberar créditos
   */
  async createPixAutoSubscription(
    userId: string,
    planSlug: string,
    taxId?: string,
  ): Promise<{
    authorizationId: string;
    qrCodePayload: string;
    qrCodeEncodedImage: string;
    expiresAt: string | null;
    status: string;
    isUpgrade: boolean;
    immediateValueCents: number;
    recurringValueCents: number;
  }> {
    const plan = await this.plansService.findPlanBySlug(planSlug);

    if (plan.slug === 'free') {
      throw new BadRequestException(
        'Não é possível criar assinatura para o plano Free',
      );
    }

    const existing = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status: { in: ['ACTIVE', 'TRIALING'] },
        plan: { slug: { not: 'free' } },
      },
      include: { plan: true },
    });

    let isUpgrade = false;
    let immediateValueCents: number | undefined;

    if (existing) {
      const currentIdx = PLAN_ORDER.indexOf(existing.plan.slug);
      const newIdx = PLAN_ORDER.indexOf(plan.slug);

      // Caso 1: TRIALING PIX Auto abandonada → limpa e segue criando nova
      const isStalePixAuto =
        existing.status === 'TRIALING' &&
        existing.paymentMethod === 'pix_auto_asaas' &&
        existing.asaasAuthorizationStatus !== 'ACTIVE';

      // Caso 2: ACTIVE PIX Auto pra plano superior → upgrade na mesma trilha PIX
      const isPixAutoUpgrade =
        existing.status === 'ACTIVE' &&
        existing.paymentMethod === 'pix_auto_asaas' &&
        currentIdx !== -1 &&
        newIdx !== -1 &&
        newIdx > currentIdx;

      // Caso 3: ACTIVE Stripe (cartão) pra plano superior → migração card→PIX
      // O Stripe continua ativo até a nova autorização PIX virar ACTIVE.
      // No momento da ativação, activatePixAutoSubscription cancela o Stripe.
      const isStripeToPixUpgrade =
        existing.status === 'ACTIVE' &&
        existing.paymentMethod !== 'pix_auto_asaas' &&
        currentIdx !== -1 &&
        newIdx !== -1 &&
        newIdx > currentIdx;

      if (isStalePixAuto) {
        if (existing.asaasAuthorizationId) {
          await this.asaasSubscriptionsService
            .cancelAuthorization(existing.asaasAuthorizationId)
            .catch((err) => {
              this.logger.warn(
                `Falha ao cancelar autorização antiga ${existing.asaasAuthorizationId}: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
        await this.prisma.subscription.update({
          where: { id: existing.id },
          data: {
            status: 'CANCELED',
            asaasAuthorizationStatus: 'CANCELED',
          },
        });
        this.logger.log(
          `Limpou subscription TRIALING abandonada ${existing.id} pra criar nova PIX Auto`,
        );
      } else if (isPixAutoUpgrade || isStripeToPixUpgrade) {
        // Diferença CHEIA: paga (novo - atual) agora. NÃO cancela a antiga aqui —
        // só na hora que a nova autorização for ativada (em activatePixAutoSubscription).
        // Isso preserva o acesso do user se ele abandonar o QR Code.
        const newPrice = await this.plansService.resolvePlanPrice(plan.id, 'BRL');
        const diffCents = newPrice.priceCents - existing.plan.priceCents;
        immediateValueCents = Math.max(diffCents, 100);
        isUpgrade = true;
        const kind = isStripeToPixUpgrade ? 'card→PIX' : 'PIX→PIX';
        this.logger.log(
          `Upgrade ${kind} iniciado ${existing.plan.slug} → ${plan.slug}: diff=R$ ${(immediateValueCents / 100).toFixed(2)}, recorrente=R$ ${(newPrice.priceCents / 100).toFixed(2)}. Antiga (${existing.id}) preservada até autorização da nova.`,
        );
      } else if (existing.paymentMethod !== 'pix_auto_asaas') {
        // Bloqueia: mesmo plano via cartão OU downgrade card→PIX
        throw new ConflictException(
          'Você já tem uma assinatura ativa no cartão. Cancele em "Minha conta" antes de assinar via PIX.',
        );
      } else {
        // PIX → PIX em mesmo plano ou downgrade
        throw new ConflictException(
          'Você já tem essa assinatura ativa via PIX. Pra trocar de plano, use a opção de upgrade ou downgrade.',
        );
      }
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        taxId: true,
        asaasCustomerId: true,
      },
    });

    const cpfCnpj = taxId ?? user.taxId;
    if (!cpfCnpj) {
      throw new BadRequestException(
        'CPF ou CNPJ é obrigatório na primeira compra via PIX.',
      );
    }

    const resolved = await this.plansService.resolvePlanPrice(plan.id, 'BRL');

    const customerId = await this.asaasService.getOrCreateCustomer(
      userId,
      user.name,
      user.email,
      cpfCnpj,
    );

    // contractId: identificador único do contrato (max 35 chars).
    // The AI Model Lab + 8 chars do userId + slug do plano (ex: theaimodelab-cmcvabcd-ultra-basic).
    const contractId = `theaimodelab-${userId.slice(-8)}-${plan.slug}`.slice(0, 35);

    const authorization: AsaasPixAutoAuthorization =
      await this.asaasSubscriptionsService.createAuthorization({
        customerId,
        valueCents: resolved.priceCents,
        ...(immediateValueCents ? { immediateValueCents } : {}),
        description: `The AI Model Lab ${plan.name}`,
        externalReference: JSON.stringify({ userId, planSlug, isUpgrade }),
        contractId,
      });

    // Cria subscription local em TRIALING aguardando autorização ser ACTIVE.
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await this.prisma.subscription.create({
      data: {
        userId,
        planId: plan.id,
        status: 'TRIALING',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        paymentProvider: 'asaas',
        paymentMethod: 'pix_auto_asaas',
        asaasAuthorizationId: authorization.id,
        asaasAuthorizationStatus: authorization.status,
      },
    });

    this.logger.log(
      `Created PIX Auto authorization ${authorization.id} for user ${userId}, plan ${planSlug}`,
    );

    return {
      authorizationId: authorization.id,
      qrCodePayload: authorization.qrCodePayload,
      qrCodeEncodedImage: authorization.qrCodeEncodedImage,
      expiresAt: authorization.expiresAt,
      status: authorization.status,
      isUpgrade,
      immediateValueCents: immediateValueCents ?? resolved.priceCents,
      recurringValueCents: resolved.priceCents,
    };
  }

  /**
   * Consulta status atual da autorização PIX Auto (polling no frontend).
   */
  /**
   * [DEV/SANDBOX] Simula ativação de uma autorização PIX Auto sem precisar pagar
   * o QR Code de verdade. Útil pra testar fluxos (incluindo upgrade card→PIX e
   * PIX→PIX) sem depender da simulação de pagamento do ASAAS sandbox (que exige
   * "critical action authorization" no painel).
   *
   * Bloqueado fora de sandbox/dev — em prod o webhook real fica responsável.
   */
  async simulatePixAutoActivation(
    userId: string,
    authorizationId: string,
  ): Promise<{ activated: boolean; subscriptionId: string }> {
    const baseUrl = this.configService.get<string>('ASAAS_BASE_URL', '');
    const isProdEnv = this.configService.get<string>('NODE_ENV') === 'production';
    const isSandboxAsaas = baseUrl.includes('sandbox');
    if (isProdEnv && !isSandboxAsaas) {
      throw new BadRequestException(
        'Endpoint disponível somente em sandbox/dev.',
      );
    }

    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, asaasAuthorizationId: authorizationId },
    });
    if (!subscription) {
      throw new NotFoundException('Autorização não encontrada pra esse user');
    }

    await this.paymentsService.activatePixAutoSubscription(subscription.id);

    return { activated: true, subscriptionId: subscription.id };
  }

  async getPixAutoAuthorizationStatus(
    userId: string,
    authorizationId: string,
  ): Promise<{ status: string; subscriptionActive: boolean }> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, asaasAuthorizationId: authorizationId },
    });

    if (!subscription) {
      throw new NotFoundException('Autorização não encontrada');
    }

    if (subscription.status === 'ACTIVE') {
      return { status: 'ACTIVE', subscriptionActive: true };
    }

    const auth = await this.asaasSubscriptionsService.getAuthorization(
      authorizationId,
    );

    // Fallback: se ASAAS já confirmou ACTIVE mas o webhook ainda não chegou
    // (ngrok caído, retry atrasado, prod sem internet), ativamos aqui mesmo.
    // Idempotente — webhook tardio vai dedup via webhook_logs.
    if (auth.status === 'ACTIVE' && subscription.status === 'TRIALING') {
      await this.paymentsService.activatePixAutoSubscription(subscription.id);
      return { status: 'ACTIVE', subscriptionActive: true };
    }

    return {
      status: auth.status,
      subscriptionActive: false,
    };
  }

  private async buildCheckoutForPlan(
    userId: string,
    planSlug: string,
    discountAmountCents = 0,
    oldExternalSubscriptionId?: string,
    currencyOverride?: string,
    recoveryPromoCode?: string,
    metaContext?: MetaEventContextDto,
    requestContext?: MetaRequestContext,
  ): Promise<string> {
    const plan = await this.plansService.findPlanBySlug(planSlug);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        country: true,
        referredByCode: true,
        currency: true,
        fbp: true,
        fbc: true,
      },
    });
    const targetCurrency = currencyOverride ?? user.currency;
    const resolved = await this.plansService.resolvePlanPrice(plan.id, targetCurrency);
    const customerId = await this.stripeService.getOrCreateCustomer(
      userId,
      user.email,
      user.name,
    );
    const checkoutUrl = await this.stripeService.createSubscriptionCheckout(
      customerId,
      plan.slug,
      plan.name,
      resolved.priceCents,
      userId,
      resolved.stripePriceId,
      resolved.currency,
      discountAmountCents > 0 ? discountAmountCents : undefined,
      oldExternalSubscriptionId,
      user.referredByCode ?? undefined,
      recoveryPromoCode,
    );

    await this.metaConversionsService.trackInitiateCheckout({
      user,
      context: metaContext,
      requestContext,
      contentId: plan.slug,
      contentName: plan.name,
      valueCents: resolved.priceCents,
      currency: resolved.currency,
      checkoutType: 'subscription',
    });

    return checkoutUrl;
  }

  private toResponseDto(
    subscription: any,
  ): SubscriptionResponseDto {
    const dto: SubscriptionResponseDto = {
      id: subscription.id,
      status: subscription.status,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      paymentProvider: subscription.paymentProvider,
      paymentRetryCount: subscription.paymentRetryCount,
      pausedUntil: subscription.pausedUntil ?? null,
      retentionOfferAcceptedAt: subscription.retentionOfferAcceptedAt ?? null,
      createdAt: subscription.createdAt,
      plan: {
        id: subscription.plan.id,
        slug: subscription.plan.slug,
        name: subscription.plan.name,
        priceCents: subscription.plan.priceCents,
        creditsPerMonth: subscription.plan.creditsPerMonth,
        maxConcurrentGenerations: subscription.plan.maxConcurrentGenerations,
        hasWatermark: subscription.plan.hasWatermark,
        galleryRetentionDays: subscription.plan.galleryRetentionDays,
        hasApiAccess: subscription.plan.hasApiAccess,
      },
    };

    if (subscription.scheduledPlan) {
      dto.scheduledPlan = {
        id: subscription.scheduledPlan.id,
        slug: subscription.scheduledPlan.slug,
        name: subscription.scheduledPlan.name,
        priceCents: subscription.scheduledPlan.priceCents,
        creditsPerMonth: subscription.scheduledPlan.creditsPerMonth,
      };
    }

    return dto;
  }
}
