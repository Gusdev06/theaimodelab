import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdultPromptEnhancerService } from './adult/adult-prompt-enhancer.service';
import { PromptEnhancerController } from './prompt-enhancer.controller';
import { PromptEnhancerService } from './prompt-enhancer.service';
import { TheaimodelabChatClient } from './theaimodelab-chat.client';

@Module({
  imports: [ConfigModule],
  controllers: [PromptEnhancerController],
  providers: [PromptEnhancerService, TheaimodelabChatClient, AdultPromptEnhancerService],
  exports: [PromptEnhancerService],
})
export class PromptEnhancerModule {}
