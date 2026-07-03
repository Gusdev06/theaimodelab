import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.stripe = new Stripe(
      this.configService.getOrThrow<string>('STRIPE_SECRET_KEY'),
      { apiVersion: '2026-02-25.clover' },
    );
    this.webhookSecret =
      this.configService.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';
  }

  /**
   * Busca stripeCustomerId do user. Se não existir, cria no Stripe e salva no banco.
   */
  async getOrCreateCustomer(
    userId: string,
    email: string,
    name: string,
  ): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });

    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customer = await this.stripe.customers.create({
      email,
      name,
      metadata: { userId },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customer.id },
    });

    this.logger.log(
      `Created Stripe customer ${customer.id} for user ${userId}`,
    );

    return customer.id;
  }

  /**
   * Cria Checkout Session mode=subscription para assinatura de plano.
   * Usa o stripePriceId do banco quando disponível; cria price inline como fallback.
   */
  async createSubscriptionCheckout(
    customerId: string,
    planSlug: string,
    planName: string,
    priceCents: number,
    userId: string,
    stripePriceId: string,
    currency: string,
    discountAmountCents?: number,
    oldExternalSubscriptionId?: string,
    referredByCode?: string,
    recoveryPromoCode?: string,
  ): Promise<string> {
    const stripeCurrency = currency.toLowerCase();
    const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = {
      price: stripePriceId,
      quantity: 1,
    };

    // Se tem desconto (upgrade), criar cupom one-time para cobrar só a diferença
    let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
    let couponId: string | undefined;
    if (discountAmountCents && discountAmountCents > 0) {
      const coupon = await this.stripe.coupons.create({
        amount_off: discountAmountCents,
        currency: stripeCurrency,
        duration: 'once',
        name: `Upgrade para ${planName}`,
        metadata: { userId, type: 'subscription_upgrade' },
      });
      couponId = coupon.id;
      discounts = [{ coupon: coupon.id }];
    }

    // Cupom da campanha de recuperação (vem do link do email D+7).
    // Prioridade: upgrade > recovery > afiliado.
    let recoveryPromotionCodeId: string | undefined;
    if (!discounts && recoveryPromoCode) {
      recoveryPromotionCodeId = await this.resolveRecoveryPromotionCode(recoveryPromoCode);
      if (recoveryPromotionCodeId) {
        discounts = [{ promotion_code: recoveryPromotionCodeId }];
      }
    }

    // Desconto de afiliado: so aplica se nao houver desconto de upgrade nem recovery.
    let appliedAffiliatePromoCodeId: string | undefined;
    if (!discounts) {
      appliedAffiliatePromoCodeId = await this.resolveAffiliatePromotionCode(
        userId,
        referredByCode,
      );
      if (appliedAffiliatePromoCodeId) {
        discounts = [{ promotion_code: appliedAffiliatePromoCodeId }];
      }
    }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      payment_method_collection: 'if_required',
      line_items: [lineItem],
      ...(discounts ? { discounts } : { allow_promotion_codes: true }),
      metadata: {
        userId,
        planSlug,
        type: 'subscription',
        ...(couponId ? { upgradeCouponId: couponId } : {}),
        ...(recoveryPromotionCodeId
          ? { recoveryPromotionCodeId, recoveryPromoCode: recoveryPromoCode! }
          : {}),
        ...(appliedAffiliatePromoCodeId
          ? { affiliatePromotionCodeId: appliedAffiliatePromoCodeId }
          : {}),
        ...(oldExternalSubscriptionId ? { oldExternalSubscriptionId } : {}),
        ...(referredByCode ? { referredByCode } : {}),
      },
      subscription_data: {
        metadata: {
          userId,
          planSlug,
          ...(referredByCode ? { referredByCode } : {}),
        },
      },
      success_url: this.configService.get<string>('STRIPE_SUCCESS_URL') ??
        'http://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: this.configService.get<string>('STRIPE_CANCEL_URL') ??
        'http://localhost:3000/payment/cancel',
    });

    return session.url!;
  }

  /**
   * Cria Checkout Session mode=payment para compra avulsa de créditos.
   * Usa o stripePriceId do banco quando disponível; cria price inline como fallback.
   */
  async createCreditPurchaseCheckout(
    customerId: string,
    packageId: string,
    packageName: string,
    credits: number,
    priceCents: number,
    userId: string,
    stripePriceId: string,
    referredByCode?: string,
  ): Promise<string> {
    const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = {
      price: stripePriceId,
      quantity: 1,
    };

    const appliedAffiliatePromoCodeId = await this.resolveAffiliatePromotionCode(
      userId,
      referredByCode,
    );
    const discounts = appliedAffiliatePromoCodeId
      ? [{ promotion_code: appliedAffiliatePromoCodeId }]
      : undefined;

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [lineItem],
      ...(discounts ? { discounts } : { allow_promotion_codes: true }),
      payment_intent_data: {
        setup_future_usage: 'off_session',
      },
      metadata: {
        userId,
        packageId,
        type: 'credit_purchase',
        ...(referredByCode ? { referredByCode } : {}),
        ...(appliedAffiliatePromoCodeId
          ? { affiliatePromotionCodeId: appliedAffiliatePromoCodeId }
          : {}),
      },
      success_url: this.configService.get<string>('STRIPE_SUCCESS_URL') ??
        'http://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: this.configService.get<string>('STRIPE_CANCEL_URL') ??
        'http://localhost:3000/payment/cancel',
    });

    return session.url!;
  }

  /**
   * Verifica assinatura do webhook e retorna o evento Stripe.
   */
  async retrieveInvoice(invoiceId: string): Promise<Stripe.Invoice> {
    return this.stripe.invoices.retrieve(invoiceId, {
      expand: ['lines.data', 'parent.subscription_details'],
    });
  }

  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
  }

  /**
   * Faz upgrade de subscription: cria nova sub com cupom (cobra só a diferença)
   * e cancela a antiga. Cria a nova ANTES de cancelar a antiga para segurança.
   */
  async upgradeSubscription(
    customerId: string,
    oldSubscriptionId: string,
    newStripePriceId: string,
    newPlanName: string,
    currentPlanPriceCents: number,
    userId: string,
    newPlanSlug: string,
    currency: string,
  ): Promise<{ stripeSubscriptionId: string; invoiceId: string | null }> {
    // 1. Criar cupom one-time com o valor do plano atual
    const coupon = await this.stripe.coupons.create({
      amount_off: currentPlanPriceCents,
      currency: currency.toLowerCase(),
      duration: 'once',
      name: `Upgrade para ${newPlanName}`,
      metadata: { userId, type: 'subscription_upgrade' },
    });

    try {
      // 2. Buscar payment method da subscription existente
      const oldSub = await this.stripe.subscriptions.retrieve(oldSubscriptionId);
      const defaultPaymentMethod =
        typeof oldSub.default_payment_method === 'string'
          ? oldSub.default_payment_method
          : (oldSub.default_payment_method as Stripe.PaymentMethod)?.id ?? undefined;

      // 3. Criar nova subscription com cupom e payment method explícito
      //    Invoice = newPlanPrice - coupon = diferença
      const subscription = await this.stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: newStripePriceId }],
        discounts: [{ coupon: coupon.id }],
        default_payment_method: defaultPaymentMethod,
        payment_behavior: 'error_if_incomplete',
        metadata: {
          userId,
          planSlug: newPlanSlug,
          type: 'subscription_upgrade',
        },
      });

      // 4. Cancelar subscription antiga imediatamente
      await this.stripe.subscriptions.cancel(oldSubscriptionId);

      // 5. Cleanup: deletar cupom (já usado, evita reuso)
      await this.stripe.coupons.del(coupon.id).catch((err) => {
        this.logger.warn(
          `Failed to delete upgrade coupon ${coupon.id}: ${err instanceof Error ? err.message : err}`,
        );
      });

      const invoiceId =
        typeof subscription.latest_invoice === 'string'
          ? subscription.latest_invoice
          : (subscription.latest_invoice as Stripe.Invoice)?.id ?? null;

      this.logger.log(
        `Upgraded subscription for user ${userId}: old=${oldSubscriptionId}, new=${subscription.id}`,
      );

      return { stripeSubscriptionId: subscription.id, invoiceId };
    } catch (error) {
      // Se a criação da nova sub falhar, deletar o cupom
      await this.stripe.coupons.del(coupon.id).catch(() => { });
      throw error;
    }
  }

  /**
   * Agenda troca de plano (downgrade) para o próximo ciclo.
   * Altera o price da subscription sem gerar proration.
   */
  async scheduleSubscriptionPlanChange(
    externalSubscriptionId: string,
    newStripePriceId: string,
  ): Promise<void> {
    const sub = await this.stripe.subscriptions.retrieve(externalSubscriptionId);
    const itemId = sub.items.data[0]?.id;

    if (!itemId) {
      throw new Error('Subscription has no items');
    }

    await this.stripe.subscriptions.update(externalSubscriptionId, {
      items: [{ id: itemId, price: newStripePriceId }],
      proration_behavior: 'none',
      cancel_at_period_end: false,
    });

    this.logger.log(
      `Scheduled plan change for subscription ${externalSubscriptionId} to price ${newStripePriceId}`,
    );
  }

  /**
   * Cancela subscription no Stripe ao final do período.
   */
  async cancelSubscription(externalSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(externalSubscriptionId, {
      cancel_at_period_end: true,
    });

    this.logger.log(
      `Marked Stripe subscription ${externalSubscriptionId} for cancellation at period end`,
    );
  }

  /**
   * Cancela subscription no Stripe imediatamente (usado no upgrade após checkout concluído).
   */
  async cancelSubscriptionImmediately(externalSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.cancel(externalSubscriptionId);

    this.logger.log(
      `Immediately canceled Stripe subscription ${externalSubscriptionId}`,
    );
  }

  /**
   * Reativa subscription no Stripe (remove cancel_at_period_end).
   */
  async reactivateSubscription(externalSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(externalSubscriptionId, {
      cancel_at_period_end: false,
    });

    this.logger.log(
      `Reactivated Stripe subscription ${externalSubscriptionId}`,
    );
  }

  /**
   * Lista cobranças recentes de um customer (usado pra detectar motivo de falha).
   */
  async listCustomerCharges(customerId: string, limit = 10): Promise<Stripe.Charge[]> {
    const page = await this.stripe.charges.list({ customer: customerId, limit });
    return page.data;
  }

  /**
   * Retorna o cartão default do customer (brand + last4), se houver.
   */
  async getDefaultCard(
    customerId: string,
  ): Promise<{ brand: string; last4: string; expMonth: number; expYear: number } | null> {
    const customer = await this.stripe.customers.retrieve(customerId);
    if (!customer || customer.deleted) return null;

    const defaultPmId = (customer as Stripe.Customer).invoice_settings?.default_payment_method;
    if (!defaultPmId) return null;
    const pmIdStr = typeof defaultPmId === 'string' ? defaultPmId : defaultPmId.id;

    try {
      const pm = await this.stripe.paymentMethods.retrieve(pmIdStr);
      if (!pm.card) return null;
      return {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      };
    } catch {
      return null;
    }
  }

  /**
   * Pausa a cobranca da subscription no Stripe por um periodo.
   * Usa pause_collection com behavior=void (nao gera invoice durante a pausa).
   */
  async pauseSubscription(
    externalSubscriptionId: string,
    resumesAt: Date,
  ): Promise<void> {
    await this.stripe.subscriptions.update(externalSubscriptionId, {
      pause_collection: {
        behavior: 'void',
        resumes_at: Math.floor(resumesAt.getTime() / 1000),
      },
    });

    this.logger.log(
      `Paused Stripe subscription ${externalSubscriptionId} until ${resumesAt.toISOString()}`,
    );
  }

  /**
   * Busca informacoes de desconto ativo em uma subscription no Stripe.
   */
  async getSubscriptionDiscount(
    externalSubscriptionId: string,
  ): Promise<{
    percentOff: number | null;
    amountOffCents: number | null;
    durationMonths: number | null;
    remainingMonths: number | null;
  } | null> {
    try {
      const sub = await this.stripe.subscriptions.retrieve(externalSubscriptionId, {
        expand: ['discounts.coupon'],
      });
      const firstDiscount = sub.discounts?.[0] as any;
      if (!firstDiscount || typeof firstDiscount === 'string') return null;
      const coupon = firstDiscount.coupon as Stripe.Coupon | null;
      if (!coupon) return null;
      if (!coupon.percent_off && !coupon.amount_off) return null;

      let remainingMonths: number | null = null;

      if (coupon.duration === 'repeating' && coupon.duration_in_months) {
        const startTs = firstDiscount.start ? firstDiscount.start * 1000 : Date.now();
        const monthsElapsed = Math.floor((Date.now() - startTs) / (30 * 24 * 60 * 60 * 1000));
        remainingMonths = Math.max(0, coupon.duration_in_months - monthsElapsed);
      } else if (coupon.duration === 'once') {
        remainingMonths = 1;
      }

      return {
        percentOff: coupon.percent_off ?? null,
        amountOffCents: coupon.amount_off ?? null,
        durationMonths: coupon.duration_in_months ?? (coupon.duration === 'once' ? 1 : null),
        remainingMonths,
      };
    } catch {
      return null;
    }
  }

  /**
   * Aplica desconto de retencao a uma subscription existente.
   * Cria um cupom e aplica direto na subscription (sem checkout).
   */
  async applyRetentionDiscount(
    externalSubscriptionId: string,
    percentOff: number,
    durationMonths: number,
    userId: string,
    reason: string,
  ): Promise<string> {
    const duration = durationMonths === 1 ? 'once' as const : 'repeating' as const;

    const coupon = await this.stripe.coupons.create({
      percent_off: percentOff,
      duration,
      ...(duration === 'repeating' ? { duration_in_months: durationMonths } : {}),
      name: `Retencao ${percentOff}% OFF${durationMonths > 1 ? ` (${durationMonths} meses)` : ''}`,
      metadata: { userId, type: 'retention_discount', reason },
    });

    await this.stripe.subscriptions.update(externalSubscriptionId, {
      discounts: [{ coupon: coupon.id }],
    });

    this.logger.log(
      `Applied ${percentOff}% retention discount to subscription ${externalSubscriptionId} for ${durationMonths} month(s)`,
    );

    return coupon.id;
  }

  /**
   * Cria sessao do Stripe Customer Portal para o usuario gerenciar cartoes e faturas.
   */
  async createBillingPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return session.url;
  }

  /**
   * Resume uma subscription pausada no Stripe.
   */
  async resumeSubscription(externalSubscriptionId: string): Promise<void> {
    await this.stripe.subscriptions.update(externalSubscriptionId, {
      pause_collection: '',
    } as any);

    this.logger.log(
      `Resumed Stripe subscription ${externalSubscriptionId}`,
    );
  }

  /**
   * Cria um cupom + promotion_code no Stripe para um afiliado especifico.
   * O promotion_code fica atrelado ao codigo do afiliado (uppercase).
   * Cupom eh `forever` — o desconto acompanha o usuario indicado em toda compra.
   * A logica de "primeira compra vs todas" eh aplicada no momento do checkout,
   * nao no cupom em si.
   */
  async createAffiliateCoupon(
    affiliateId: string,
    affiliateCode: string,
    percentOff: number,
  ): Promise<{ couponId: string; promotionCodeId: string }> {
    const coupon = await this.stripe.coupons.create({
      percent_off: percentOff,
      duration: 'forever',
      name: `Afiliado ${affiliateCode} — ${percentOff}% OFF`,
      metadata: { affiliateId, affiliateCode, type: 'affiliate_discount' },
    });

    const promotionCode = await this.stripe.promotionCodes.create({
      promotion: { type: 'coupon', coupon: coupon.id },
      code: affiliateCode,
      metadata: { affiliateId, affiliateCode, type: 'affiliate_discount' },
    });

    this.logger.log(
      `Created affiliate coupon ${coupon.id} + promotion code ${promotionCode.id} for affiliate ${affiliateId} (${affiliateCode}, ${percentOff}% OFF)`,
    );

    return { couponId: coupon.id, promotionCodeId: promotionCode.id };
  }

  /**
   * Desativa (e tenta deletar) cupom + promotion code de afiliado no Stripe.
   * Promotion codes nao podem ser deletados — sao desativados (active=false).
   * Cupons podem ser deletados. Ambos operadores sao idempotentes (nao lancam
   * se o recurso ja nao existe).
   */
  async removeAffiliateCoupon(
    couponId?: string | null,
    promotionCodeId?: string | null,
  ): Promise<void> {
    if (promotionCodeId) {
      try {
        await this.stripe.promotionCodes.update(promotionCodeId, { active: false });
      } catch (err) {
        this.logger.warn(
          `Failed to deactivate promotion code ${promotionCodeId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (couponId) {
      try {
        await this.stripe.coupons.del(couponId);
      } catch (err) {
        this.logger.warn(
          `Failed to delete coupon ${couponId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /**
   * Ativa ou desativa um promotion code no Stripe (usado quando afiliado
   * eh ativado/desativado no painel admin).
   */
  async setAffiliatePromotionCodeActive(
    promotionCodeId: string,
    active: boolean,
  ): Promise<void> {
    try {
      await this.stripe.promotionCodes.update(promotionCodeId, { active });
    } catch (err) {
      this.logger.warn(
        `Failed to set promotion code ${promotionCodeId} active=${active}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Resolve o `promotion_code` do Stripe a aplicar em um checkout, considerando
   * o afiliado que indicou o usuario e o escopo configurado (FIRST_PURCHASE
   * ou ALL_PURCHASES). Retorna null se nao houver desconto aplicavel.
   */
  private async resolveAffiliatePromotionCode(
    userId: string,
    referredByCode?: string,
  ): Promise<string | undefined> {
    if (!referredByCode) return undefined;

    const affiliate = await this.prisma.affiliate.findUnique({
      where: { code: referredByCode },
      select: {
        isActive: true,
        discountPercent: true,
        discountAppliesTo: true,
        stripePromotionCodeId: true,
      },
    });

    if (
      !affiliate ||
      !affiliate.isActive ||
      !affiliate.discountPercent ||
      !affiliate.stripePromotionCodeId
    ) {
      return undefined;
    }

    if (affiliate.discountAppliesTo === 'FIRST_PURCHASE') {
      const priorPayment = await this.prisma.payment.findFirst({
        where: { userId, status: 'COMPLETED' },
        select: { id: true },
      });
      if (priorPayment) return undefined;
    }

    return affiliate.stripePromotionCodeId;
  }

  /**
   * Resolve o `promotion_code` ID do Stripe para o cupom da campanha de recuperação.
   * Usa env RECOVERY_PROMOTION_CODE_ID se configurado (mais rápido), senão busca
   * na API do Stripe pelo código textual. Cache em memória dura a vida do processo.
   */
  private recoveryPromoCodeCache = new Map<string, string>();
  private async resolveRecoveryPromotionCode(code: string): Promise<string | undefined> {
    if (this.recoveryPromoCodeCache.has(code)) {
      return this.recoveryPromoCodeCache.get(code);
    }

    // 1) Env atalho — preferido
    const envId = this.configService.get<string>('RECOVERY_PROMOTION_CODE_ID');
    if (envId) {
      this.recoveryPromoCodeCache.set(code, envId);
      return envId;
    }

    // 2) Fallback — busca na API
    try {
      const list = await this.stripe.promotionCodes.list({ code, limit: 1, active: true });
      const promo = list.data[0];
      if (!promo) {
        this.logger.warn(`Recovery promotion code "${code}" não encontrado no Stripe`);
        return undefined;
      }
      this.recoveryPromoCodeCache.set(code, promo.id);
      return promo.id;
    } catch (err: any) {
      this.logger.error(`Erro ao buscar recovery promo "${code}": ${err.message}`);
      return undefined;
    }
  }
}
