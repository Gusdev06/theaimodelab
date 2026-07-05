import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GenerationsController } from './generations.controller';
import { GenerationsService } from './generations.service';
import { GenerationEventsService } from './generation-events.service';
import { GenerationProcessor } from './queue/generation.processor';
import { UnlimitedProcessor } from './queue/unlimited.processor';
import {
  GENERATION_QUEUE,
  GENERATION_UNLIMITED_QUEUE,
} from './queue/generation-queue.constants';
import { PrismaModule } from '../prisma/prisma.module';
import { CreditsModule } from '../credits/credits.module';
import { PlansModule } from '../plans/plans.module';
import { UploadsModule } from '../uploads/uploads.module';
import { TheaimodelabProvider } from './providers/theaimodelab.provider';
import { NanoBananaProvider } from './providers/nano-banana.provider';
import { WanProvider } from './providers/wan.provider';
import { FaceSwapProvider } from './providers/face-swap.provider';
import { VeoProvider } from './providers/veo.provider';
import { GrokImagineProvider } from './providers/grok-imagine.provider';
import { GeminiOmniVideoProvider } from './providers/gemini-omni-video.provider';
import { BytedanceSeedanceProvider } from './providers/bytedance-seedance.provider';
import { SeedreamLiteProvider } from './providers/seedream-lite.provider';
import { SeedreamProvider } from './providers/seedream.provider';
import { GptImageProvider } from './providers/gpt-image.provider';
import { DeepDeepProvider } from './providers/deepdeep.provider';
import { WavespeedAudioProvider } from './providers/wavespeed-audio.provider';
import { PromptEnhancerModule } from '../prompt-enhancer/prompt-enhancer.module';
import { ModelsModule } from '../models/models.module';
import { VoicesModule } from '../voices/voices.module';

@Module({
  imports: [
    PrismaModule,
    CreditsModule,
    PlansModule,
    UploadsModule,
    PromptEnhancerModule,
    ModelsModule,
    VoicesModule,
    BullModule.registerQueue({
      name: GENERATION_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
    BullModule.registerQueue({
      name: GENERATION_UNLIMITED_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    }),
  ],
  controllers: [GenerationsController],
  providers: [
    GenerationsService,
    GenerationEventsService,
    GenerationProcessor,
    UnlimitedProcessor,
    TheaimodelabProvider,
    NanoBananaProvider,
    WanProvider,
    FaceSwapProvider,
    VeoProvider,
    GrokImagineProvider,
    GeminiOmniVideoProvider,
    BytedanceSeedanceProvider,
    SeedreamLiteProvider,
    SeedreamProvider,
    GptImageProvider,
    DeepDeepProvider,
    WavespeedAudioProvider,
  ],
  exports: [GenerationsService],
})
export class GenerationsModule {}
