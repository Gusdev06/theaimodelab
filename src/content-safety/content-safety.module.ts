import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ContentSafetyAdminController } from './content-safety-admin.controller';
import { ContentSafetyInterceptor } from './content-safety.interceptor';
import { ContentSafetyService } from './content-safety.service';
import { PromptJudgeService } from './prompt-judge/prompt-judge.service';

/**
 * Global de propósito: o interceptor é aplicado nos controllers de geração, avatares, prompt e agente, e o
 * ContentSafetyService é usado direto pelo agente (que chama o GenerationsService sem passar pelo controller), sem
 * que cada módulo precise importar este (menos chance de rota nova ficar de fora).
 */
@Global()
@Module({
  // ConfigModule aqui (e não só o global do AppModule) para o juiz ler as envs também quando o módulo sobe sozinho (testes)
  imports: [ConfigModule],
  controllers: [ContentSafetyAdminController],
  providers: [ContentSafetyService, PromptJudgeService, ContentSafetyInterceptor],
  exports: [ContentSafetyService, PromptJudgeService, ContentSafetyInterceptor],
})
export class ContentSafetyModule {}
