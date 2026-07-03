import { Module } from '@nestjs/common';
import { PromptEnhancerController } from './prompt-enhancer.controller';
import { PromptEnhancerService } from './prompt-enhancer.service';
import { TheaimodelabChatClient } from './theaimodelab-chat.client';

@Module({
  controllers: [PromptEnhancerController],
  providers: [PromptEnhancerService, TheaimodelabChatClient],
  exports: [PromptEnhancerService],
})
export class PromptEnhancerModule {}
