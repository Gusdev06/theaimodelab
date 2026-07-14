import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { TheaimodelabChatClient } from '../prompt-enhancer/theaimodelab-chat.client';
import { PromptEnhancerModule } from '../prompt-enhancer/prompt-enhancer.module';
import { GenerationsModule } from '../generations/generations.module';
import { ModelsModule } from '../models/models.module';
import { CreditsModule } from '../credits/credits.module';

@Module({
  imports: [
    PromptEnhancerModule, // exporta PromptEnhancerService
    GenerationsModule, // exporta GenerationsService
    ModelsModule, // exporta ModelsService
    CreditsModule, // exporta CreditsService
  ],
  controllers: [AgentController],
  providers: [AgentService, TheaimodelabChatClient],
})
export class AgentModule {}
