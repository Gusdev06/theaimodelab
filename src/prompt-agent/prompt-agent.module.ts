import { Module } from '@nestjs/common';
import { PromptAgentController } from './prompt-agent.controller';
import { PromptAgentService } from './prompt-agent.service';
import { CreditsModule } from '../credits/credits.module';
import { TheaimodelabChatClient } from '../prompt-enhancer/theaimodelab-chat.client';
import { UploadsModule } from '../uploads/uploads.module';
import { ExternalMediaCheck } from '../content-safety/image-safety/external-media-check';

@Module({
  imports: [CreditsModule, UploadsModule],
  controllers: [PromptAgentController],
  providers: [PromptAgentService, TheaimodelabChatClient, ExternalMediaCheck],
})
export class PromptAgentModule {}
