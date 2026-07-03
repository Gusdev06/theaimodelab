import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WebhookLogsService } from '../../webhook-logs/webhook-logs.service';
import { PaymentsService } from '../payments.service';
import { StripeService } from '../stripe.service';
import Stripe from 'stripe';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly webhookLogsService: WebhookLogsService,
    private readonly paymentsService: PaymentsService,
    private readonly stripeService: StripeService,
  ) {}

  async handleWebhook(payload: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;

    try {
      event = this.stripeService.constructWebhookEvent(payload, signature);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Webhook signature verification failed: ${message}`);
      throw new BadRequestException(
        `Webhook signature verification failed: ${message}`,
      );
    }

    const eventType = event.type;
    const externalId = event.id;

    // Idempotência: tentar criar o log atomicamente.
    // Se já existe e foi processado, pular. Se já existe e falhou, reprocessar.
    const existingLog = await this.webhookLogsService.findByExternalId(externalId);
    if (existingLog?.processed) {
      this.logger.log(`Event ${externalId} already processed, skipping`);
      return;
    }

    // Tentar claim atômico: marcar como processing antes de criar.
    // Se dois webhooks chegam ao mesmo tempo, o segundo vê o log do primeiro.
    let log: { id: string };
    if (existingLog) {
      // Reprocessamento de evento que falhou anteriormente
      log = existingLog;
    } else {
      log = await this.webhookLogsService.create(
        'stripe',
        eventType,
        externalId,
        JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue,
      );

      // Double-check: outro processo pode ter criado entre o findByExternalId e o create.
      // Verificar se existe outro log processado para o mesmo evento.
      const doubleCheck = await this.webhookLogsService.findProcessedByExternalId(externalId);
      if (doubleCheck && doubleCheck.id !== log.id) {
        this.logger.log(`Event ${externalId} already processed by another worker, skipping`);
        return;
      }
    }

    try {
      await this.routeEvent(eventType, event);
      await this.webhookLogsService.markProcessed(log.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      await this.webhookLogsService.markFailed(log.id, message);
      this.logger.error(
        `Failed to process Stripe event ${eventType}: ${message}`,
      );
    }
  }

  private async routeEvent(
    eventType: string,
    event: Stripe.Event,
  ): Promise<void> {
    switch (eventType) {
      case 'checkout.session.completed':
        await this.handleCheckoutSessionCompleted(event);
        break;
      case 'invoice.payment_succeeded':
      case 'invoice_payment.paid':
        await this.handleInvoicePaymentSucceeded(event);
        break;
      case 'invoice.payment_failed':
      case 'invoice_payment.failed':
        await this.handleInvoicePaymentFailed(event);
        break;
      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(event);
        break;
      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(event);
        break;
      case 'charge.refunded':
        await this.handleChargeRefunded(event);
        break;
      default:
        this.logger.log(`Unhandled Stripe event type: ${eventType}`);
    }
  }

  /**
   * Checkout finalizado — cria assinatura ou processa compra de créditos.
   */
  private async handleCheckoutSessionCompleted(
    event: Stripe.Event,
  ): Promise<void> {
    const session = event.data.object as Stripe.Checkout.Session;
    const metadata = session.metadata ?? {};
    const type = metadata.type;

    this.logger.log(
      `Checkout completed: ${session.id}, type: ${type}`,
    );

    if (type === 'subscription') {
      const userId = metadata.userId;
      const planSlug = metadata.planSlug;
      const stripeSubscriptionId =
        typeof session.subscription === 'string'
          ? session.subscription
          : (session.subscription as Stripe.Subscription)?.id;

      if (!userId || !planSlug || !stripeSubscriptionId) {
        this.logger.error(
          `Missing metadata in checkout session: userId=${userId}, planSlug=${planSlug}, subscriptionId=${stripeSubscriptionId}`,
        );
        return;
      }

      await this.paymentsService.processSubscriptionPayment(
        userId,
        planSlug,
        stripeSubscriptionId,
        session.amount_total ?? 0,
        session.payment_intent as string ?? session.id,
        this.requireCurrency(session.currency, `session ${session.id}`),
        metadata.referredByCode,
      );

      // Se é upgrade, cancelar a sub antiga no Stripe agora que a nova foi criada
      const oldExternalSubscriptionId = metadata.oldExternalSubscriptionId;
      if (oldExternalSubscriptionId) {
        await this.stripeService.cancelSubscriptionImmediately(
          oldExternalSubscriptionId,
        ).catch((err) => {
          this.logger.warn(
            `Failed to cancel old subscription ${oldExternalSubscriptionId}: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    } else if (type === 'credit_purchase') {
      const userId = metadata.userId;
      const packageId = metadata.packageId;

      if (!userId || !packageId) {
        this.logger.error(
          `Missing metadata in checkout session: userId=${userId}, packageId=${packageId}`,
        );
        return;
      }

      await this.paymentsService.processCreditPurchase(
        userId,
        packageId,
        session.amount_total ?? 0,
        session.payment_intent as string ?? session.id,
        this.requireCurrency(session.currency, `session ${session.id}`),
        metadata.referredByCode,
      );
    } else {
      this.logger.warn(`Unknown checkout type: ${type}`);
    }
  }

  /**
   * Pagamento de invoice bem-sucedido — renovação de assinatura.
   * Suporta tanto invoice.payment_succeeded (objeto Invoice direto)
   * quanto invoice_payment.paid (objeto InvoicePayment, precisa buscar invoice).
   * Ignorar o primeiro pagamento (billing_reason = subscription_create),
   * pois já foi tratado pelo checkout.session.completed.
   */
  private async handleInvoicePaymentSucceeded(
    event: Stripe.Event,
  ): Promise<void> {
    let invoice: Stripe.Invoice;

    if (event.type === 'invoice_payment.paid') {
      // InvoicePayment object — precisa buscar o invoice completo
      const invoicePayment = event.data.object as any;
      const invoiceId = typeof invoicePayment.invoice === 'string'
        ? invoicePayment.invoice
        : invoicePayment.invoice?.id;

      if (!invoiceId) {
        this.logger.warn(`No invoice ID in invoice_payment ${invoicePayment.id}`);
        return;
      }

      invoice = await this.stripeService.retrieveInvoice(invoiceId);
    } else {
      invoice = event.data.object as Stripe.Invoice;
    }

    // Ignorar o primeiro pagamento — já tratado pelo checkout
    if (invoice.billing_reason === 'subscription_create') {
      this.logger.log(
        `Skipping invoice for subscription_create: ${invoice.id}`,
      );
      return;
    }

    const stripeSubscriptionId = this.extractSubscriptionId(invoice);

    if (!stripeSubscriptionId) {
      this.logger.warn(`No subscription ID in invoice ${invoice.id}`);
      return;
    }

    const periodStart = invoice.lines?.data?.[0]?.period?.start
      ? new Date(invoice.lines.data[0].period.start * 1000)
      : new Date();
    const periodEnd = invoice.lines?.data?.[0]?.period?.end
      ? new Date(invoice.lines.data[0].period.end * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await this.paymentsService.handleSubscriptionRenewal(
      stripeSubscriptionId,
      periodStart,
      periodEnd,
      invoice.amount_paid ?? 0,
      invoice.id,
      this.requireCurrency(invoice.currency, `invoice ${invoice.id}`),
    );
  }

  /**
   * Pagamento de invoice falhou — marcar subscription como PAST_DUE.
   * Suporta tanto invoice.payment_failed quanto invoice_payment.failed.
   */
  private async handleInvoicePaymentFailed(
    event: Stripe.Event,
  ): Promise<void> {
    let invoice: Stripe.Invoice;

    const eventType = event.type as string;
    if (eventType === 'invoice_payment.failed') {
      const invoicePayment = event.data.object as any;
      const invoiceId = typeof invoicePayment.invoice === 'string'
        ? invoicePayment.invoice
        : invoicePayment.invoice?.id;

      if (!invoiceId) {
        this.logger.warn(`No invoice ID in invoice_payment ${invoicePayment.id}`);
        return;
      }

      invoice = await this.stripeService.retrieveInvoice(invoiceId);
    } else {
      invoice = event.data.object as Stripe.Invoice;
    }

    const stripeSubscriptionId = this.extractSubscriptionId(invoice);

    if (!stripeSubscriptionId) {
      this.logger.warn(`No subscription ID in invoice ${invoice.id}`);
      return;
    }

    await this.paymentsService.handlePaymentFailed(
      stripeSubscriptionId,
      invoice.amount_due ?? 0,
      invoice.id,
      this.requireCurrency(invoice.currency, `invoice ${invoice.id}`),
    );
  }

  private requireCurrency(currency: string | null | undefined, context: string): string {
    if (!currency) {
      this.logger.error(`Missing currency in ${context} — Stripe webhook payload invalid`);
      throw new Error(`Missing currency in ${context}`);
    }
    return currency;
  }

  /**
   * Subscription atualizada no Stripe — sincroniza cancel_at_period_end e pause.
   * Cobre cancelamentos feitos pelo Customer Portal do Stripe.
   */
  private async handleSubscriptionUpdated(
    event: Stripe.Event,
  ): Promise<void> {
    const stripeSub = event.data.object as Stripe.Subscription;

    // O portal do Stripe usa cancel_at (data fixa) em vez de cancel_at_period_end.
    // Tratar ambos como indicação de cancelamento agendado.
    const isCanceling = stripeSub.cancel_at_period_end || stripeSub.cancel_at !== null;

    await this.paymentsService.handleSubscriptionUpdated(
      stripeSub.id,
      isCanceling,
      stripeSub.status,
    );
  }

  /**
   * Subscription deletada no Stripe — cancelamento definitivo.
   */
  private async handleSubscriptionDeleted(
    event: Stripe.Event,
  ): Promise<void> {
    const subscription = event.data.object as Stripe.Subscription;

    await this.paymentsService.handleSubscriptionDeleted(subscription.id);
  }

  /**
   * Reembolso emitido — revoga acesso e remove créditos correspondentes.
   */
  private async handleChargeRefunded(event: Stripe.Event): Promise<void> {
    const charge = event.data.object as Stripe.Charge;

    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : (charge.payment_intent as Stripe.PaymentIntent)?.id ?? null;

    const chargeAny = charge as any;
    const invoiceId = typeof chargeAny.invoice === 'string'
      ? chargeAny.invoice
      : (chargeAny.invoice as Stripe.Invoice)?.id ?? null;

    if (!paymentIntentId && !invoiceId) {
      this.logger.warn(`charge.refunded without payment_intent or invoice: ${charge.id}`);
      return;
    }

    await this.paymentsService.handleRefund(paymentIntentId, invoiceId, charge.amount_refunded);
  }

  /**
   * Extrai o subscription ID de um invoice (API v2026+).
   * Na nova API, o campo está em invoice.parent.subscription_details.subscription.
   */
  private extractSubscriptionId(invoice: Stripe.Invoice): string | null {
    const sub = invoice.parent?.subscription_details?.subscription;
    if (!sub) return null;
    return typeof sub === 'string' ? sub : sub.id;
  }
}
