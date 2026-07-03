import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { WebhookLogsService } from '../../webhook-logs/webhook-logs.service';
import { PaymentsService } from '../payments.service';
import { AsaasService } from '../asaas.service';
import { AsaasSubscriptionsService } from '../asaas-subscriptions.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../../email/email.service';

interface AsaasWebhookEnvelope {
  event?: string;
  payment?: {
    id?: string;
    status?: string;
    value?: number;
    pixAutomaticAuthorizationId?: string;
    externalReference?: string | null;
  } & Record<string, unknown>;
  pixAutomatic?: {
    id?: string;
    status?: string;
    externalReference?: string | null;
  };
  pixAutomaticAuthorization?: {
    id?: string;
    status?: string;
    externalReference?: string | null;
  };
}

interface BoostExternalRef {
  userId?: string;
  packageId?: string;
  referredByCode?: string;
}

interface SubscriptionExternalRef {
  userId?: string;
  planSlug?: string;
}

/**
 * Processa webhooks do ASAAS v3.
 *
 * Fluxos:
 * - PAYMENT_RECEIVED/CONFIRMED com externalReference de boost → libera créditos
 * - PAYMENT_RECEIVED/CONFIRMED com pixAutomaticAuthorizationId → renova subscription
 * - PIX_AUTOMATIC_AUTHORIZATION_ACTIVE → ativa subscription TRIALING
 * - PIX_AUTOMATIC_AUTHORIZATION_CANCELED/EXPIRED/REJECTED → cancela subscription
 *
 * Autenticação: header asaas-access-token (constant-time compare).
 * Idempotência: webhook_logs.external_id = `${eventType}:${entityId}`.
 * Anti-forge: revalidamos status no ASAAS antes de qualquer mudança no DB.
 */
@Injectable()
export class AsaasWebhookService {
  private readonly logger = new Logger(AsaasWebhookService.name);

  constructor(
    private readonly webhookLogsService: WebhookLogsService,
    private readonly paymentsService: PaymentsService,
    private readonly asaasService: AsaasService,
    private readonly asaasSubscriptionsService: AsaasSubscriptionsService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async handleWebhook(
    accessToken: string | undefined,
    payload: AsaasWebhookEnvelope,
  ): Promise<void> {
    this.assertSecret(accessToken);

    const eventType = payload.event ?? 'unknown';
    const { kind, entityId } = this.classify(payload);

    if (!entityId) {
      // Log payload COMPLETO pra debug — assim conseguimos descobrir o shape real
      this.logger.warn(
        `Webhook ASAAS sem id reconhecível (event=${eventType}). Payload completo:\n${JSON.stringify(payload, null, 2)}`,
      );
      return;
    }

    const externalId = `${eventType}:${entityId}`;

    const existingLog = await this.webhookLogsService.findByExternalId(externalId);
    if (existingLog?.processed) {
      this.logger.log(`Webhook ${externalId} já processado, ignorando`);
      return;
    }

    const log =
      existingLog ??
      (await this.webhookLogsService.create(
        'asaas',
        eventType,
        externalId,
        payload as unknown as Prisma.InputJsonValue,
      ));

    try {
      if (kind === 'pix_auto_authorization') {
        await this.processAuthorizationEvent(entityId);
      } else if (kind === 'payment') {
        await this.processPaymentEvent(entityId);
      }
      await this.webhookLogsService.markProcessed(log.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await this.webhookLogsService.markFailed(log.id, message);
      this.logger.error(`Falha ao processar webhook ${externalId}: ${message}`);
      throw error;
    }
  }

  private classify(payload: AsaasWebhookEnvelope): {
    kind: 'payment' | 'pix_auto_authorization' | 'unknown';
    entityId: string | null;
  } {
    const event = payload.event ?? '';

    if (event.includes('AUTHORIZATION')) {
      // ASAAS pode usar vários nomes de campo dependendo da versão.
      // Tentamos todos os candidatos conhecidos.
      const envelope = payload as Record<string, unknown>;
      const candidates = [
        'pixAutomatic',
        'pixAutomaticAuthorization',
        'pixAutomaticRecurringAuthorization',
        'recurringAuthorization',
        'authorization',
      ];
      for (const key of candidates) {
        const obj = envelope[key] as { id?: string } | undefined;
        if (obj?.id) {
          return { kind: 'pix_auto_authorization', entityId: obj.id };
        }
      }
      return { kind: 'pix_auto_authorization', entityId: null };
    }

    if (event.startsWith('PAYMENT_') && payload.payment?.id) {
      return { kind: 'payment', entityId: payload.payment.id };
    }

    return { kind: 'unknown', entityId: null };
  }

  private assertSecret(provided: string | undefined): void {
    const expected = this.asaasService.getWebhookSecret();
    if (!expected) {
      this.logger.error('ASAAS_WEBHOOK_SECRET não configurada');
      throw new BadRequestException('Webhook secret não configurada');
    }
    if (!provided) {
      throw new UnauthorizedException('Faltou header asaas-access-token');
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('asaas-access-token inválido');
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Payment events — boost OU cobrança recorrente de subscription
  // ───────────────────────────────────────────────────────────────────

  private async processPaymentEvent(paymentId: string): Promise<void> {
    const payment = await this.asaasService.checkPaymentStatus(paymentId);

    if (payment.status !== 'PAID') {
      this.logger.log(
        `Payment ${paymentId} não está PAID (status=${payment.status}), nada a fazer`,
      );
      return;
    }

    // Se o payment referencia uma autorização PIX Auto, é cobrança recorrente.
    // Senão, é boost (fluxo original).
    const authorizationId = await this.getAuthorizationIdOfPayment(paymentId);

    if (authorizationId) {
      await this.processRecurringChargePaid(
        paymentId,
        authorizationId,
        payment.amountCents,
      );
    } else {
      await this.processBoostPaid(paymentId, payment);
    }
  }

  private async getAuthorizationIdOfPayment(
    paymentId: string,
  ): Promise<string | null> {
    // ASAAS payment retornado por GET /payments/{id} inclui o campo
    // pixAutomaticAuthorizationId quando aplicável. Aqui replicamos a chamada
    // pra ter o dado mais atual (já está sendo feita em checkPaymentStatus,
    // mas o helper retorna shape reduzido). Vou inferir do externalReference por enquanto:
    // o controller que criou a cobrança recorrente colocou { userId, planSlug, authId } no externalReference.
    // Se ASAAS não preservar isso, faremos um GET /payments/{id} aqui depois.
    try {
      const raw = await fetch(
        `${this.asaasBaseUrl()}/payments/${encodeURIComponent(paymentId)}`,
        {
          headers: {
            access_token: this.asaasApiKey(),
            Accept: 'application/json',
          },
        },
      );
      if (!raw.ok) return null;
      const data = (await raw.json()) as { pixAutomaticAuthorizationId?: string };
      return data.pixAutomaticAuthorizationId ?? null;
    } catch {
      return null;
    }
  }

  // Helpers privados pra reusar config do AsaasService
  private asaasBaseUrl(): string {
    return (this.asaasService as unknown as { baseUrl: string }).baseUrl ??
      'https://api-sandbox.asaas.com/v3';
  }
  private asaasApiKey(): string {
    return (this.asaasService as unknown as { apiKey: string }).apiKey ?? '';
  }

  private async processBoostPaid(
    paymentId: string,
    payment: { amountCents: number; externalReference?: string | null },
  ): Promise<void> {
    const ref = this.parseBoostRef(payment.externalReference);
    if (!ref.userId || !ref.packageId) {
      this.logger.error(
        `Payment ${paymentId} sem userId/packageId — não dá pra creditar`,
      );
      return;
    }
    await this.paymentsService.processCreditPurchase(
      ref.userId,
      ref.packageId,
      payment.amountCents,
      paymentId,
      'BRL',
      ref.referredByCode,
      'asaas',
    );
    this.logger.log(`Boost payment ${paymentId} confirmado pro user ${ref.userId}`);
  }

  /**
   * Renovação de subscription: avança o período mensal e reseta créditos.
   * A primeira cobrança (que vem junto com a autorização) também passa por aqui —
   * idempotência cuida de não duplicar a ativação.
   */
  private async processRecurringChargePaid(
    paymentId: string,
    authorizationId: string,
    amountCents: number,
  ): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { asaasAuthorizationId: authorizationId },
      include: { plan: true, user: true },
    });

    if (!subscription) {
      this.logger.warn(
        `Payment ${paymentId} aponta pra autorização ${authorizationId} sem subscription local`,
      );
      return;
    }

    const now = new Date();
    const newPeriodEnd = new Date(now);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);

    await this.prisma.$transaction(async (tx) => {
      // Idempotência: se já existe payment com esse externalPaymentId, skip
      const existing = await tx.payment.findFirst({
        where: { externalPaymentId: paymentId },
      });
      if (existing) {
        this.logger.log(`Payment ${paymentId} já registrado, skip`);
        return;
      }

      await tx.payment.create({
        data: {
          userId: subscription.userId,
          type: 'SUBSCRIPTION',
          amountCents,
          currency: 'BRL',
          status: 'COMPLETED',
          provider: 'asaas',
          externalPaymentId: paymentId,
          subscriptionId: subscription.id,
        },
      });

      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: newPeriodEnd,
          paymentRetryCount: 0,
        },
      });

      await tx.creditBalance.upsert({
        where: { userId: subscription.userId },
        create: {
          userId: subscription.userId,
          planCreditsRemaining: subscription.plan.creditsPerMonth,
          bonusCreditsRemaining: 0,
          planCreditsUsed: 0,
          periodStart: now,
          periodEnd: newPeriodEnd,
        },
        update: {
          planCreditsRemaining: subscription.plan.creditsPerMonth,
          planCreditsUsed: 0,
          periodStart: now,
          periodEnd: newPeriodEnd,
        },
      });

      await tx.creditTransaction.create({
        data: {
          userId: subscription.userId,
          type: 'SUBSCRIPTION_RENEWAL',
          amount: subscription.plan.creditsPerMonth,
          source: 'plan',
          description: `Renovação ${subscription.plan.name} (PIX Auto)`,
        },
      });
    });

    this.logger.log(
      `Subscription ${subscription.id} renovada via PIX Auto pagamento ${paymentId}`,
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // PIX Auto Authorization events
  // ───────────────────────────────────────────────────────────────────

  private async processAuthorizationEvent(authorizationId: string): Promise<void> {
    const auth = await this.asaasSubscriptionsService.getAuthorization(
      authorizationId,
    );

    const subscription = await this.prisma.subscription.findFirst({
      where: { asaasAuthorizationId: authorizationId },
      include: { plan: true },
    });

    if (!subscription) {
      this.logger.warn(
        `Webhook autorização ${authorizationId} sem subscription local`,
      );
      return;
    }

    if (auth.status === 'ACTIVE') {
      await this.paymentsService.activatePixAutoSubscription(subscription.id);
      return;
    }

    if (auth.status === 'CANCELED' || auth.status === 'EXPIRED' || auth.status === 'REJECTED') {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'CANCELED',
          asaasAuthorizationStatus: auth.status,
          cancelAtPeriodEnd: false,
        },
      });
      this.logger.log(
        `Subscription ${subscription.id} cancelada (autorização ${auth.status})`,
      );
    }
  }

  private parseBoostRef(raw: string | null | undefined): BoostExternalRef {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as BoostExternalRef;
      return {
        userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
        packageId: typeof parsed.packageId === 'string' ? parsed.packageId : undefined,
        referredByCode:
          typeof parsed.referredByCode === 'string' ? parsed.referredByCode : undefined,
      };
    } catch {
      return {};
    }
  }
}
