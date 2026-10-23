import { Module } from '@nestjs/common';
import { PromptEnhancerController } from './prompt-enhancer.controller';
import { PromptEnhancerService } from './prompt-enhancer.service';
import { TheaimodelabChatClient } from './theaimodelab-chat.client';
import { UploadsModule } from '../uploads/uploads.module';
import { ExternalMediaCheck } from '../content-safety/image-safety/external-media-check';

@Module({
  imports: [UploadsModule],
  controllers: [PromptEnhancerController],
  providers: [PromptEnhancerService, TheaimodelabChatClient, ExternalMediaCheck],
  exports: [PromptEnhancerService],
})
export class PromptEnhancerModule {}
