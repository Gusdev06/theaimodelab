import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookLogsModule } from '../webhook-logs/webhook-logs.module';
import { ResendWebhooksController } from './resend-webhooks.controller';
import { ResendWebhooksService } from './resend-webhooks.service';

@Module({
  imports: [PrismaModule, WebhookLogsModule],
  controllers: [ResendWebhooksController],
  providers: [ResendWebhooksService],
})
export class ResendWebhooksModule {}
