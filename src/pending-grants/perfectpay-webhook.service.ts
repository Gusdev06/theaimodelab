import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { EmailService } from '../email/email.service';
import { WebhookLogsService } from '../webhook-logs/webhook-logs.service';
import {
  DEFAULT_HUBLA_BUNDLE,
  PendingGrantsService,
} from './pending-grants.service';

/**
 * Webhook do Perfect Pay (https://www.perfectpay.com.br).
 *
 * Mesmo modelo de Hotmart/Hubla/Greenn: a compra libera o bundle de gerações
 * grátis (DEFAULT_HUBLA_BUNDLE) por email. Quando o usuário se cadastra com
 * esse email, as gerações são consumidas no signup.
 *
 * Payload típico (v2.1):
 *
 *   {
 *     token: '<PERFECTPAY_WEBHOOK_TOKEN>',
 *     code: 'PPCPMTB123ABC',
 *     sale_amount: 99.90,
 *     currency_enum: 1,
 *     sale_status_enum: 2,           // 1=pending, 2=approved, 4=completed, 6=refunded ...
 *     sale_status_detail: 'approved',
 *     customer: {
 *       email: 'buyer@x.com',
 *       full_name: 'Buyer Name',
 *       identification_number: '...'
 *     },
 *     product: { code: 'PROD123', name: '...' }
 *   }
 *
 * Status aceitos (libera o bundle):
 *   - 2 (approved)
 *   - 4 (completed)
 *
 * Autenticação: comparação timing-safe entre `payload.token` (ou header
 * `x-perfectpay-token`) e PERFECTPAY_WEBHOOK_TOKEN. Se a env não estiver
 * configurada, a checagem é pulada (com warning), mantendo paridade com os
 * outros providers desse módulo.
 */
@Injectable()
export class PerfectpayWebhookService {
  private readonly logger = new Logger(PerfectpayWebhookService.name);

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
    this.verifyToken(payload, headers, queryToken);

    const eventType = this.extractEventType(payload);
    const externalEventId = this.extractEventId(payload);
    const email = this.extractEmail(payload);

    await this.webhookLogs.create(
      'perfectpay',
      eventType ?? 'unknown',
      externalEventId,
      payload,
    );

    if (!this.isPaidEvent(payload)) {
      return {
        processed: false,
        reason: `ignored event: status=${payload?.sale_status_enum ?? 'n/a'} (${payload?.sale_status_detail ?? 'n/a'})`,
      };
    }

    if (!email) {
      throw new BadRequestException('Email do comprador não encontrado no payload');
    }

    const { created } = await this.pendingGrantsService.createPending({
      email,
      bundle: DEFAULT_HUBLA_BUNDLE,
      source: 'perfectpay',
      externalEventId,
    });

    this.logger.log(
      `Perfectpay ${eventType} for ${email} — pending grant ${created ? 'created' : 'already existed'}`,
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
    payload: any,
    headers?: Record<string, string>,
    queryToken?: string,
  ): void {
    const expected = this.configService.get<string>('PERFECTPAY_WEBHOOK_TOKEN');
    if (!expected) {
      this.logger.warn(
        'PERFECTPAY_WEBHOOK_TOKEN not configured — skipping token check',
      );
      return;
    }

    const received =
      (typeof payload?.token === 'string' ? payload.token : null) ??
      queryToken ??
      headers?.['x-perfectpay-token'] ??
      headers?.['X-Perfectpay-Token'] ??
      null;

    if (!received) {
      throw new UnauthorizedException('Missing Perfectpay token');
    }

    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid Perfectpay token');
    }
  }

  /**
   * 2 = approved, 4 = completed (renovação ou pagamento concluído).
   * Outros status (pending/refund/chargeback/expired) são ignorados.
   */
  private isPaidEvent(payload: any): boolean {
    const status = payload?.sale_status_enum;
    if (status === 2 || status === 4) return true;

    const detail =
      typeof payload?.sale_status_detail === 'string'
        ? payload.sale_status_detail.toLowerCase()
        : null;
    return detail === 'approved' || detail === 'completed';
  }

  private extractEventType(payload: any): string | null {
    const detail = payload?.sale_status_detail ?? null;
    const status = payload?.sale_status_enum ?? null;
    if (detail) return `sale.${String(detail).toLowerCase()}`;
    if (status != null) return `sale.status_${status}`;
    return null;
  }

  /** Idempotência: cada venda+status vira um id único. */
  private extractEventId(payload: any): string | null {
    const code = payload?.code ?? payload?.sale_code ?? null;
    const status = payload?.sale_status_enum ?? 'na';
    if (code) return `perfectpay-sale-${code}-${status}`;
    return null;
  }

  private extractEmail(payload: any): string | null {
    const candidate =
      payload?.customer?.email ??
      payload?.buyer?.email ??
      payload?.email ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }

  private extractName(payload: any): string | null {
    const candidate =
      payload?.customer?.full_name ??
      payload?.customer?.name ??
      payload?.buyer?.name ??
      payload?.name ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed.split(/\s+/)[0] : null;
  }
}
