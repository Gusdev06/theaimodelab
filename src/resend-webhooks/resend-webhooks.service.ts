import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Webhook, WebhookVerificationError } from 'svix';
import { Prisma, EmailBroadcastDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookLogsService } from '../webhook-logs/webhook-logs.service';

/**
 * Eventos do Resend (https://resend.com/docs/dashboard/webhooks/event-types).
 * Mapeamos cada um pra um status no nosso EmailBroadcastDeliveryStatus.
 */
const STATUS_HIERARCHY: Record<EmailBroadcastDeliveryStatus, number> = {
  PENDING: 0,
  SENT: 1,
  FAILED: 1,
  DELIVERED: 2,
  OPENED: 3,
  CLICKED: 4,
  BOUNCED: 5,
  COMPLAINED: 5,
};

interface ResendWebhookEvent {
  type: string;
  created_at: string;
  data: {
    email_id: string;
    from?: string;
    to?: string[];
    subject?: string;
    [k: string]: unknown;
  };
}

@Injectable()
export class ResendWebhooksService {
  private readonly logger = new Logger(ResendWebhooksService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookLogs: WebhookLogsService,
    private readonly configService: ConfigService,
  ) {
    this.secret = this.configService.get<string>('RESEND_WEBHOOK_SECRET') || '';
    if (!this.secret) {
      this.logger.warn(
        'RESEND_WEBHOOK_SECRET não configurado — webhooks Resend serão rejeitados',
      );
    }
  }

  /**
   * Valida a assinatura Svix e retorna o evento parseado.
   * Lança BadRequestException se a assinatura for inválida.
   */
  verify(rawBody: Buffer, headers: Record<string, string>): ResendWebhookEvent {
    if (!this.secret) {
      throw new BadRequestException('Webhook secret não configurado');
    }

    const wh = new Webhook(this.secret);

    try {
      const payload = wh.verify(rawBody.toString('utf8'), {
        'svix-id': headers['svix-id'],
        'svix-timestamp': headers['svix-timestamp'],
        'svix-signature': headers['svix-signature'],
      });
      return payload as ResendWebhookEvent;
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        this.logger.warn(`Assinatura Svix inválida: ${err.message}`);
      } else {
        this.logger.error(`Erro inesperado validando webhook: ${(err as Error).message}`);
      }
      throw new BadRequestException('Assinatura inválida');
    }
  }

  /**
   * Processa o evento — atualiza recipient + contadores do broadcast.
   * Idempotente: respeita hierarquia de status (não desce, só sobe).
   */
  async handleEvent(event: ResendWebhookEvent): Promise<void> {
    const log = await this.webhookLogs.create(
      'resend',
      event.type,
      event.data.email_id,
      event as unknown as Prisma.InputJsonValue,
    );

    try {
      await this.processEvent(event);
      await this.webhookLogs.markProcessed(log.id);
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.error(`Falha ao processar ${event.type} (${event.data.email_id}): ${msg}`);
      await this.webhookLogs.markFailed(log.id, msg);
      // Não relança — não queremos que Resend reentregue indefinidamente
      // por erro nosso (idempotência já é tratada via STATUS_HIERARCHY).
    }
  }

  private async processEvent(event: ResendWebhookEvent): Promise<void> {
    const newStatus = mapEventToStatus(event.type);
    if (!newStatus) {
      this.logger.log(`Evento ignorado: ${event.type}`);
      return;
    }

    const recipient = await this.prisma.emailBroadcastRecipient.findFirst({
      where: { resendEmailId: event.data.email_id },
      select: { id: true, status: true, broadcastId: true },
    });

    if (!recipient) {
      this.logger.warn(
        `Recipient não encontrado pra resend_email_id=${event.data.email_id} (evento ${event.type})`,
      );
      return;
    }

    const currentRank = STATUS_HIERARCHY[recipient.status] ?? 0;
    const newRank = STATUS_HIERARCHY[newStatus] ?? 0;

    // Sempre carimbamos os timestamps específicos (mesmo que não suba o status)
    const timestampUpdate = timestampForStatus(newStatus);

    if (newRank < currentRank) {
      // Não desce o status, mas atualiza só o timestamp se ainda não tiver
      if (timestampUpdate) {
        await this.prisma.emailBroadcastRecipient.update({
          where: { id: recipient.id },
          data: timestampUpdate,
        });
      }
      return;
    }

    await this.prisma.emailBroadcastRecipient.update({
      where: { id: recipient.id },
      data: {
        status: newStatus,
        ...(timestampUpdate ?? {}),
      },
    });

    this.logger.log(
      `Recipient ${recipient.id} → ${newStatus} (de ${recipient.status})`,
    );
  }
}

function mapEventToStatus(eventType: string): EmailBroadcastDeliveryStatus | null {
  switch (eventType) {
    case 'email.delivered':
      return EmailBroadcastDeliveryStatus.DELIVERED;
    case 'email.opened':
      return EmailBroadcastDeliveryStatus.OPENED;
    case 'email.clicked':
      return EmailBroadcastDeliveryStatus.CLICKED;
    case 'email.bounced':
      return EmailBroadcastDeliveryStatus.BOUNCED;
    case 'email.complained':
      return EmailBroadcastDeliveryStatus.COMPLAINED;
    case 'email.sent':
    case 'email.delivery_delayed':
    default:
      return null;
  }
}

function timestampForStatus(
  status: EmailBroadcastDeliveryStatus,
): Partial<Record<'deliveredAt' | 'openedAt' | 'clickedAt' | 'bouncedAt', Date>> | null {
  const now = new Date();
  switch (status) {
    case EmailBroadcastDeliveryStatus.DELIVERED:
      return { deliveredAt: now };
    case EmailBroadcastDeliveryStatus.OPENED:
      return { openedAt: now };
    case EmailBroadcastDeliveryStatus.CLICKED:
      return { clickedAt: now };
    case EmailBroadcastDeliveryStatus.BOUNCED:
      return { bouncedAt: now };
    default:
      return null;
  }
}
