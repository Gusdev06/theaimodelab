import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { UploadsModule } from '../uploads/uploads.module';
import { CreditsModule } from '../credits/credits.module';
import { ModelsModule } from '../models/models.module';
import { AvatarsController } from './avatars.controller';
import { AvatarsService } from './avatars.service';
import { HeyGenProvider } from './providers/heygen.provider';
import { AvatarEventsService } from './avatar-events.service';
import { AvatarProcessor } from './queue/avatar.processor';
import { AVATAR_QUEUE } from './queue/avatar-queue.constants';
import { HeyGenWebhookController } from './webhooks/heygen-webhook.controller';
import { HeyGenWebhookService } from './webhooks/heygen-webhook.service';
import { StuckAvatarsService } from './cron/stuck-avatars.service';
import { WavespeedAudioProvider } from '../generations/providers/wavespeed-audio.provider';

@Module({
  imports: [
    PrismaModule,
    UploadsModule,
    CreditsModule,
    ModelsModule,
    BullModule.registerQueue({
      name: AVATAR_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
  ],
  controllers: [AvatarsController, HeyGenWebhookController],
  providers: [
    AvatarsService,
    HeyGenProvider,
    AvatarEventsService,
    AvatarProcessor,
    HeyGenWebhookService,
    StuckAvatarsService,
    WavespeedAudioProvider,
  ],
  exports: [AvatarsService, HeyGenProvider, AvatarEventsService],
})
export class AvatarsModule {}
