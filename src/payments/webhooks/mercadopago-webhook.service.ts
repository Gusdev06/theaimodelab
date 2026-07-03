import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookLogsService } from '../../webhook-logs/webhook-logs.service';
import { PaymentsService } from '../payments.service';

@Injectable()
export class MercadoPagoWebhookService {
  private readonly logger = new Logger(MercadoPagoWebhookService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly webhookLogsService: WebhookLogsService,
    private readonly paymentsService: PaymentsService,
  ) {}

  async handleWebhook(payload: any): Promise<void> {
    const webhookSecret = this.configService.get<string>(
      'MERCADOPAGO_WEBHOOK_SECRET',
    );

    if (!webhookSecret) {
      this.logger.warn('MERCADOPAGO_WEBHOOK_SECRET not configured');
    }

    // TODO: Verify MercadoPago webhook signature/HMAC

    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException('Invalid webhook payload');
    }

    const eventType = payload.type ?? payload.action ?? 'unknown';
    const externalId = payload.data?.id?.toString() ?? payload.id ?? null;

    // Log the webhook event
    const log = await this.webhookLogsService.create(
      'mercadopago',
      eventType,
      externalId,
      payload,
    );

    try {
      await this.routeEvent(eventType, payload);
      await this.webhookLogsService.markProcessed(log.id);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      await this.webhookLogsService.markFailed(log.id, message);
      this.logger.error(
        `Failed to process MercadoPago event ${eventType}`,
        message,
      );
    }
  }

  private async routeEvent(eventType: string, payload: any): Promise<void> {
    switch (eventType) {
      case 'payment':
        // TODO: Handle MercadoPago payment notification
        // 1. Fetch payment details from MercadoPago API using payload.data.id
        // 2. Update local payment record status
        // 3. Process subscription or credit purchase accordingly
        this.logger.log(
          `MercadoPago payment event: ${payload.data?.id ?? 'unknown'}`,
        );
        break;
      case 'subscription_preapproval':
        // TODO: Handle subscription preapproval events
        this.logger.log(
          `MercadoPago subscription event: ${payload.data?.id ?? 'unknown'}`,
        );
        break;
      default:
        this.logger.log(`Unhandled MercadoPago event type: ${eventType}`);
    }
  }
}
