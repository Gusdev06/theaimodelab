import { Global, Module } from '@nestjs/common';
import { ContentSafetyAdminController } from './content-safety-admin.controller';
import { ContentSafetyInterceptor } from './content-safety.interceptor';
import { ContentSafetyService } from './content-safety.service';

/**
 * Global de propósito: o interceptor é aplicado nos controllers de geração, avatares e prompt sem que cada módulo
 * precise importar este (menos chance de rota nova ficar de fora).
 */
@Global()
@Module({
  controllers: [ContentSafetyAdminController],
  providers: [ContentSafetyService, ContentSafetyInterceptor],
  exports: [ContentSafetyService, ContentSafetyInterceptor],
})
export class ContentSafetyModule {}
