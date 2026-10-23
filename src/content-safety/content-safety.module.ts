import { Global, Module } from '@nestjs/common';
import { ContentSafetyAdminController } from './content-safety-admin.controller';
import { ContentSafetyInterceptor } from './content-safety.interceptor';
import { ContentSafetyService } from './content-safety.service';

/**
 * Global de propósito: o interceptor é aplicado nos controllers de geração, avatares, prompt e agente, e o
 * ContentSafetyService é usado direto pelo agente (que chama o GenerationsService sem passar pelo controller), sem
 * que cada módulo precise importar este (menos chance de rota nova ficar de fora).
 */
@Global()
@Module({
  controllers: [ContentSafetyAdminController],
  providers: [ContentSafetyService, ContentSafetyInterceptor],
  exports: [ContentSafetyService, ContentSafetyInterceptor],
})
export class ContentSafetyModule {}
