import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { AdminEmailsController } from './admin-emails.controller';
import { AdminEmailsService } from './admin-emails.service';
import { EmailBroadcastProcessor } from './queue/email-broadcast.processor';
import { EMAIL_BROADCAST_QUEUE } from './queue/email-broadcast.constants';

@Module({
  imports: [
    PrismaModule,
    EmailModule,
    BullModule.registerQueue({
      name: EMAIL_BROADCAST_QUEUE,
      defaultJobOptions: {
        attempts: 1, // Cada destinatário tem retry individual implícito (status FAILED)
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: { age: 30 * 24 * 3600 },
      },
    }),
  ],
  controllers: [AdminEmailsController],
  providers: [AdminEmailsService, EmailBroadcastProcessor],
  exports: [AdminEmailsService],
})
export class AdminEmailsModule {}
