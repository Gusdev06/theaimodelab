import { Global, Module } from '@nestjs/common';
import { UploadsModule } from '../../uploads/uploads.module';
import { TakedownModule } from '../takedown/takedown.module';
import { HeldGenerationDispatcher } from './held-generation.dispatcher';
import { SafetyReviewService } from './safety-review.service';
import { SafetyReviewerGuard } from './safety-reviewer.guard';

/**
 * Revisão de segurança (camada 7). Global de propósito: as rotas ficam no ContentSafetyAdminController (do
 * ContentSafetyModule), que recebe o serviço daqui sem o ContentSafetyModule passar a depender da pilha de imagem
 * (montado sozinho, como nos testes de integração dele, as rotas do revisor respondem 503). O ImageSafetyService, o
 * ContentSafetyService, a lista de bloqueio, a configuração e os pontos vêm dos módulos globais de segurança; o
 * GenerationProcessor e as filas são lidos pelo ModuleRef (dispatcher), sem importar o GenerationsModule. A remoção
 * (TakedownModule) grava o resultado publicado de um caso confirmado e purga o CDN.
 */
@Global()
@Module({
  imports: [UploadsModule, TakedownModule],
  providers: [SafetyReviewService, HeldGenerationDispatcher, SafetyReviewerGuard],
  exports: [SafetyReviewService, SafetyReviewerGuard],
})
export class SafetyReviewModule {}
