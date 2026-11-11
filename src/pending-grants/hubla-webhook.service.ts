import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
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
 *
 * Autenticação (TKT-036): a Hubla não assina o webhook, então exigimos um token compartilhado em `?token=` ou no
 * header `x-hubla-token`, igual a Greenn/Cartpanda. Diferente delas, aqui é FAIL-CLOSED: sem HUBLA_WEBHOOK_TOKEN no
 * env, nada é processado. Antes, qualquer POST com "invoice.paid" e um e-mail criava acesso de graça.
 */
@Injectable()
export class HublaWebhookService {
  private readonly logger = new Logger(HublaWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly pendingGrantsService: PendingGrantsService,
    private readonly webhookLogs: WebhookLogsService,
  ) {}

  async handle(
    payload: any,
    headers?: Record<string, string>,
    queryToken?: string,
  ): Promise<{ processed: boolean; reason?: string }> {
    this.verifyToken(queryToken, headers);
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

  private verifyToken(queryToken: string | undefined, headers?: Record<string, string>): void {
    const expected = this.configService.get<string>('HUBLA_WEBHOOK_TOKEN')?.trim();
    if (!expected) {
      this.logger.warn('HUBLA_WEBHOOK_TOKEN não configurado: webhook da Hubla recusado (fail-closed)');
      throw new UnauthorizedException('Hubla webhook disabled');
    }
    const received = (queryToken ?? headers?.['x-hubla-token'] ?? headers?.['X-Hubla-Token'] ?? '').trim();
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid Hubla token');
    }
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
