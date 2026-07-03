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
 * Payload da Hotmart (v2.0.0):
 *
 *   {
 *     id: 'evt_xxx',
 *     event: 'PURCHASE_APPROVED',
 *     version: '2.0.0',
 *     data: {
 *       buyer: { email: '...', name: '...' },
 *       purchase: { transaction: 'HP...', status: 'APPROVED', ... },
 *       ...
 *     },
 *     hottok: 'xxxxx'
 *   }
 *
 * A autenticação é feita comparando o `hottok` (body ou header `x-hotmart-hottok`)
 * com o valor configurado em `HOTMART_HOTTOK`.
 */
@Injectable()
export class HotmartWebhookService {
  private readonly logger = new Logger(HotmartWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly pendingGrantsService: PendingGrantsService,
    private readonly webhookLogs: WebhookLogsService,
    private readonly emailService: EmailService,
  ) {}

  async handle(
    payload: any,
    headers?: Record<string, string>,
  ): Promise<{ processed: boolean; reason?: string }> {
    this.verifyHottok(payload, headers);

    const eventType = this.extractEventType(payload);
    const externalEventId = this.extractEventId(payload, headers);
    const email = this.extractEmail(payload);

    await this.webhookLogs.create(
      'hotmart',
      eventType ?? 'unknown',
      externalEventId,
      payload,
    );

    if (!this.isPaidEvent(eventType)) {
      return { processed: false, reason: `ignored event: ${eventType}` };
    }

    if (!email) {
      throw new BadRequestException('Email do comprador não encontrado no payload');
    }

    const { created } = await this.pendingGrantsService.createPending({
      email,
      bundle: DEFAULT_HUBLA_BUNDLE,
      source: 'hotmart',
      externalEventId,
    });

    this.logger.log(
      `Hotmart ${eventType} for ${email} — pending grant ${created ? 'created' : 'already existed'}`,
    );

    if (created) {
      const buyerName = this.extractName(payload);
      await this.emailService.sendPendingGrantsEmailEs(email, buyerName);
    }

    return { processed: true };
  }

  private extractName(payload: any): string | null {
    const candidate =
      payload?.data?.buyer?.name ??
      payload?.data?.subscriber?.name ??
      payload?.buyer?.name ??
      payload?.name ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    const trimmed = candidate.trim();
    return trimmed.length > 0 ? trimmed.split(/\s+/)[0] : null;
  }

  private verifyHottok(
    payload: any,
    headers?: Record<string, string>,
  ): void {
    const expected = this.configService.get<string>('HOTMART_HOTTOK');
    if (!expected) {
      this.logger.warn('HOTMART_HOTTOK not configured — skipping signature check');
      return;
    }

    const received =
      headers?.['x-hotmart-hottok'] ??
      headers?.['X-Hotmart-Hottok'] ??
      payload?.hottok ??
      null;

    if (received !== expected) {
      throw new UnauthorizedException('Invalid Hotmart hottok');
    }
  }

  private isPaidEvent(eventType: string | null): boolean {
    if (!eventType) return false;
    const normalized = eventType.toUpperCase();
    return (
      normalized === 'PURCHASE_APPROVED' ||
      normalized === 'PURCHASE_COMPLETE'
    );
  }

  private extractEventType(payload: any): string | null {
    return payload?.event ?? payload?.type ?? null;
  }

  private extractEventId(
    payload: any,
    headers?: Record<string, string>,
  ): string | null {
    const idempotencyHeader =
      headers?.['x-hotmart-idempotency'] ??
      headers?.['X-Hotmart-Idempotency'];
    if (idempotencyHeader) return idempotencyHeader;

    return (
      payload?.id ??
      payload?.data?.purchase?.transaction ??
      payload?.event_id ??
      null
    );
  }

  private extractEmail(payload: any): string | null {
    const candidate =
      payload?.data?.buyer?.email ??
      payload?.data?.subscriber?.email ??
      payload?.buyer?.email ??
      payload?.email ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }
}
