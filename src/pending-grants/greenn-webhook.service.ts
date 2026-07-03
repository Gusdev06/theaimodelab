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
 * Webhook da Greenn (https://gitlab.com/llgod/greenn-webhook).
 *
 * Mesmo modelo de Hotmart/Hubla: a compra do curso na Greenn libera o bundle
 * de gerações grátis (DEFAULT_HUBLA_BUNDLE) por email. Quando o usuário se
 * cadastra com esse email, as gerações são consumidas no signup.
 *
 * Eventos relevantes:
 *   - { type: 'sale',     event: 'saleUpdated',     currentStatus: 'paid' }
 *   - { type: 'contract', event: 'contractUpdated', currentStatus: 'paid' }
 *
 * Outros eventos (waiting_payment, refused, refunded, canceled, lead/checkoutAbandoned)
 * são ignorados por enquanto — só registrados em webhook_logs.
 *
 * Autenticação: a Greenn não assina os webhooks, então usamos um token
 * compartilhado via query string `?token=...` ou header `x-greenn-token`,
 * configurado em GREENN_WEBHOOK_TOKEN.
 */
@Injectable()
export class GreennWebhookService {
  private readonly logger = new Logger(GreennWebhookService.name);

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

    const eventType = this.extractEventType(payload);
    const externalEventId = this.extractEventId(payload);
    const email = this.extractEmail(payload);

    await this.webhookLogs.create(
      'greenn',
      eventType ?? 'unknown',
      externalEventId,
      payload,
    );

    if (!this.isPaidEvent(payload)) {
      return {
        processed: false,
        reason: `ignored event: ${eventType} (status=${payload?.currentStatus ?? 'n/a'})`,
      };
    }

    if (!email) {
      throw new BadRequestException('Email do comprador não encontrado no payload');
    }

    const { created } = await this.pendingGrantsService.createPending({
      email,
      bundle: DEFAULT_HUBLA_BUNDLE,
      source: 'greenn',
      externalEventId,
    });

    this.logger.log(
      `Greenn ${eventType} for ${email} — pending grant ${created ? 'created' : 'already existed'}`,
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
    const expected = this.configService.get<string>('GREENN_WEBHOOK_TOKEN');
    if (!expected) {
      this.logger.warn('GREENN_WEBHOOK_TOKEN not configured — skipping signature check');
      return;
    }

    const received =
      queryToken ??
      headers?.['x-greenn-token'] ??
      headers?.['X-Greenn-Token'] ??
      null;

    if (received !== expected) {
      throw new UnauthorizedException('Invalid Greenn token');
    }
  }

  /** Sale paga ou contrato pago são os únicos status que disparam o bundle. */
  private isPaidEvent(payload: any): boolean {
    const type = payload?.type;
    const status = payload?.currentStatus;
    if (status !== 'paid') return false;
    return type === 'sale' || type === 'contract';
  }

  private extractEventType(payload: any): string | null {
    const type = payload?.type;
    const event = payload?.event;
    if (type && event) return `${type}.${event}`;
    return event ?? type ?? null;
  }

  /** Idempotência: cada combinação contrato+venda+status vira um id único. */
  private extractEventId(payload: any): string | null {
    if (payload?.type === 'sale' && payload?.sale?.id != null) {
      return `greenn-sale-${payload.sale.id}-${payload.currentStatus}`;
    }
    if (payload?.type === 'contract' && payload?.contract?.id != null) {
      const saleId = payload?.currentSale?.id ?? 'na';
      return `greenn-contract-${payload.contract.id}-sale-${saleId}-${payload.currentStatus}`;
    }
    if (payload?.type === 'lead' && payload?.lead?.id != null) {
      return `greenn-lead-${payload.lead.id}`;
    }
    return null;
  }

  private extractEmail(payload: any): string | null {
    const candidate =
      payload?.client?.email ??
      payload?.lead?.email ??
      payload?.buyer?.email ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }

  private extractName(payload: any): string | null {
    const candidate =
      payload?.client?.name ??
      payload?.lead?.name ??
      payload?.buyer?.name ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed.split(/\s+/)[0] : null;
  }
}
