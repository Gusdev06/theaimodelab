import { Module } from '@nestjs/common';
import { WebhookLogsService } from './webhook-logs.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [WebhookLogsService],
  exports: [WebhookLogsService],
})
export class WebhookLogsModule {}
