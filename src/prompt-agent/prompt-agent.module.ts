import { Module } from '@nestjs/common';
import { PromptAgentController } from './prompt-agent.controller';
import { PromptAgentService } from './prompt-agent.service';
import { CreditsModule } from '../credits/credits.module';
import { TheaimodelabChatClient } from '../prompt-enhancer/theaimodelab-chat.client';
import { OpenRouterVisionClient } from './openrouter-vision.client';

@Module({
  imports: [CreditsModule],
  controllers: [PromptAgentController],
  providers: [PromptAgentService, TheaimodelabChatClient, OpenRouterVisionClient],
})
export class PromptAgentModule {}
