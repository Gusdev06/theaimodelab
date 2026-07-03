import { Module } from '@nestjs/common';
import { PromptAgentController } from './prompt-agent.controller';
import { PromptAgentService } from './prompt-agent.service';
import { CreditsModule } from '../credits/credits.module';
import { TheaimodelabChatClient } from '../prompt-enhancer/theaimodelab-chat.client';

@Module({
  imports: [CreditsModule],
  controllers: [PromptAgentController],
  providers: [PromptAgentService, TheaimodelabChatClient],
})
export class PromptAgentModule {}
