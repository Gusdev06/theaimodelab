import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { WebhookLogsService } from '../webhook-logs/webhook-logs.service';
import {
  DEFAULT_HUBLA_BUNDLE,
  PendingGrantsService,
} from './pending-grants.service';

/**
 * Webhook da Cartpanda (https://www.cartpanda.com).
 *
 * Cartpanda não expõe formato fixo do payload nem oferece "enviar teste" no
 * painel, então o parser abaixo é tolerante e tenta os caminhos mais comuns
 * observados na plataforma (estilo Shopify + variantes próprias):
 *
 *   { event: 'order.paid', order: { customer: { email, first_name } } }
 *   { event: 'order/paid', data: { customer: { email } } }
 *   { topic: 'order.paid', email: 'buyer@x.com', financial_status: 'paid' }
 *   { event_type: 'paid', customer: { email }, ... }
 *
 * O payload completo é sempre gravado em `webhook_logs` antes de processar,
 * então o primeiro recebimento real expõe o formato exato pra refinamento.
 *
 * Autenticação: Cartpanda não assina nativamente; usamos token compartilhado
 * via query string `?token=...` ou header `x-cartpanda-token`, configurado em
 * CARTPANDA_WEBHOOK_TOKEN. Se o env não estiver setado, a checagem é pulada.
 */
@Injectable()
export class CartpandaWebhookService {
  private readonly logger = new Logger(CartpandaWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly pendingGrantsService: PendingGrantsService,
    private readonly webhookLogs: WebhookLogsService,
    private readonly emailService: EmailService,
  ) {}

  async handle(
    payload: any,
    headers?: Record<string, string>,
    queryToken?: string,
  ): Promise<{ processed: boolean; reason?: string }> {
    this.verifyToken(queryToken, headers);

    const eventType = this.extractEventType(payload, headers);
    const externalEventId = this.extractEventId(payload, headers);
    const email = this.extractEmail(payload);

    await this.webhookLogs.create(
      'cartpanda',
      eventType ?? 'unknown',
      externalEventId,
      payload,
    );

    if (!this.isPaidEvent(payload, eventType)) {
      return {
        processed: false,
        reason: `ignored event: ${eventType} (status=${this.extractFinancialStatus(payload) ?? 'n/a'})`,
      };
    }

    if (!email) {
      throw new BadRequestException(
        'Email do comprador não encontrado no payload',
      );
    }

    const { created } = await this.pendingGrantsService.createPending({
      email,
      bundle: DEFAULT_HUBLA_BUNDLE,
      source: 'cartpanda',
      externalEventId,
    });

    this.logger.log(
      `Cartpanda ${eventType} for ${email} — pending grant ${created ? 'created' : 'already existed'}`,
    );

    if (created) {
      const buyerName = this.extractName(payload);
      await this.emailService.sendPendingGrantsEmailEs(email, buyerName);
    }

    return { processed: true };
  }

  // ────────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────────

  private verifyToken(
    queryToken: string | undefined,
    headers?: Record<string, string>,
  ): void {
    const expected = this.configService.get<string>('CARTPANDA_WEBHOOK_TOKEN');
    if (!expected) {
      this.logger.warn(
        'CARTPANDA_WEBHOOK_TOKEN not configured — skipping token check',
      );
      return;
    }

    const received =
      queryToken ??
      headers?.['x-cartpanda-token'] ??
      headers?.['X-Cartpanda-Token'] ??
      headers?.['x-cartpanda-secret'] ??
      headers?.['X-Cartpanda-Secret'] ??
      null;

    if (received !== expected) {
      throw new UnauthorizedException('Invalid Cartpanda token');
    }
  }

  private isPaidEvent(payload: any, eventType: string | null): boolean {
    const normalizedEvent = (eventType ?? '').toLowerCase();
    const financial = this.extractFinancialStatus(payload);

    const eventIsPaid =
      normalizedEvent.includes('paid') ||
      normalizedEvent.includes('approved') ||
      normalizedEvent === 'order.completed' ||
      normalizedEvent === 'order/completed' ||
      normalizedEvent === 'order.create' ||
      normalizedEvent === 'order/create';

    const statusIsPaid =
      financial === 'paid' ||
      financial === 'approved' ||
      financial === 'completed' ||
      financial === 'partially_paid';

    if (eventIsPaid && statusIsPaid) return true;
    if (eventIsPaid && !financial) return true;
    if (
      (normalizedEvent.includes('paid') || normalizedEvent.includes('approved')) &&
      statusIsPaid
    ) {
      return true;
    }
    return false;
  }

  private extractFinancialStatus(payload: any): string | null {
    const candidate =
      payload?.order?.financial_status ??
      payload?.data?.order?.financial_status ??
      payload?.data?.financial_status ??
      payload?.financial_status ??
      payload?.status ??
      payload?.order?.status ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }

  private extractEventType(
    payload: any,
    headers?: Record<string, string>,
  ): string | null {
    const topicHeader =
      headers?.['x-cartpanda-topic'] ??
      headers?.['X-Cartpanda-Topic'] ??
      headers?.['x-shopify-topic'] ??
      null;
    if (topicHeader) return topicHeader;

    return (
      payload?.event ??
      payload?.event_type ??
      payload?.topic ??
      payload?.type ??
      null
    );
  }

  private extractEventId(
    payload: any,
    headers?: Record<string, string>,
  ): string | null {
    const idHeader =
      headers?.['x-cartpanda-webhook-id'] ??
      headers?.['X-Cartpanda-Webhook-Id'] ??
      headers?.['x-cartpanda-event-id'] ??
      headers?.['x-shopify-webhook-id'] ??
      null;
    if (idHeader) return `cartpanda-evt-${idHeader}`;

    const orderId =
      payload?.order?.id ??
      payload?.data?.order?.id ??
      payload?.data?.id ??
      payload?.id ??
      null;

    if (orderId != null) {
      const status = this.extractFinancialStatus(payload) ?? 'unknown';
      return `cartpanda-order-${orderId}-${status}`;
    }

    return null;
  }

  private extractEmail(payload: any): string | null {
    const candidate =
      payload?.order?.customer?.email ??
      payload?.data?.order?.customer?.email ??
      payload?.data?.customer?.email ??
      payload?.customer?.email ??
      payload?.buyer?.email ??
      payload?.order?.email ??
      payload?.data?.email ??
      payload?.email ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }

  private extractName(payload: any): string | null {
    const first =
      payload?.order?.customer?.first_name ??
      payload?.data?.order?.customer?.first_name ??
      payload?.customer?.first_name ??
      payload?.buyer?.first_name ??
      null;

    if (typeof first === 'string' && first.trim().length > 0) {
      return first.trim().split(/\s+/)[0];
    }

    const fullName =
      payload?.order?.customer?.name ??
      payload?.data?.order?.customer?.name ??
      payload?.customer?.name ??
      payload?.buyer?.name ??
      payload?.name ??
      null;

    if (typeof fullName !== 'string') return null;
    const trimmed = fullName.trim();
    return trimmed.length > 0 ? trimmed.split(/\s+/)[0] : null;
  }
}
