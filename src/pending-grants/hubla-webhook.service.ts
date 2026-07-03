import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { WebhookLogsService } from '../webhook-logs/webhook-logs.service';
import {
  DEFAULT_HUBLA_BUNDLE,
  PendingGrantsService,
} from './pending-grants.service';

/**
 * Formato esperado do payload da Hubla (a API deles evoluiu ao longo do tempo;
 * o parser abaixo tenta achar o email e um id do evento em formatos comuns):
 *
 *   { type: 'invoice.paid', data: { user: { email: '...' }, id: 'evt_xxx' } }
 *   { event: 'NewSale',     user: { email: '...' },        id: 'evt_xxx' }
 *   { type: 'sale.created', customer: { email: '...' },    event_id: 'evt_xxx' }
 */
@Injectable()
export class HublaWebhookService {
  private readonly logger = new Logger(HublaWebhookService.name);

  constructor(
    private readonly pendingGrantsService: PendingGrantsService,
    private readonly webhookLogs: WebhookLogsService,
  ) {}

  async handle(
    payload: any,
    headers?: Record<string, string>,
  ): Promise<{ processed: boolean; reason?: string }> {
    const eventType = this.extractEventType(payload);
    const externalEventId = this.extractEventId(payload, headers);
    const email = this.extractEmail(payload);

    await this.webhookLogs.create('hubla', eventType ?? 'unknown', externalEventId, payload);

    // Só processamos eventos de pagamento aprovado
    if (!this.isPaidEvent(eventType)) {
      return { processed: false, reason: `ignored event: ${eventType}` };
    }

    if (!email) {
      throw new BadRequestException('Email do comprador não encontrado no payload');
    }

    const { created } = await this.pendingGrantsService.createPending({
      email,
      bundle: DEFAULT_HUBLA_BUNDLE,
      source: 'hubla',
      externalEventId,
    });

    this.logger.log(
      `Hubla ${eventType} for ${email} — pending grant ${created ? 'created' : 'already existed'}`,
    );

    return { processed: true };
  }

  private isPaidEvent(eventType: string | null): boolean {
    if (!eventType) return false;
    const normalized = eventType.toLowerCase();
    return (
      normalized.includes('paid') ||
      normalized.includes('approved') ||
      normalized.includes('sale') ||
      normalized.includes('purchase')
    );
  }

  private extractEventType(payload: any): string | null {
    return payload?.type ?? payload?.event?.type ?? payload?.eventType ?? null;
  }

  private extractEventId(
    payload: any,
    headers?: Record<string, string>,
  ): string | null {
    // Prefer Hubla idempotency header (guaranteed unique per event)
    const idempotencyHeader = headers?.['x-hubla-idempotency'];
    if (idempotencyHeader) return idempotencyHeader;

    return (
      payload?.event?.transactionId ??
      payload?.id ??
      payload?.event_id ??
      payload?.eventId ??
      payload?.data?.id ??
      null
    );
  }

  private extractEmail(payload: any): string | null {
    const candidate =
      payload?.event?.userEmail ??
      payload?.user?.email ??
      payload?.customer?.email ??
      payload?.buyer?.email ??
      payload?.data?.user?.email ??
      payload?.data?.customer?.email ??
      payload?.email ??
      null;

    if (!candidate || typeof candidate !== 'string') return null;
    return candidate.trim().toLowerCase();
  }
}
