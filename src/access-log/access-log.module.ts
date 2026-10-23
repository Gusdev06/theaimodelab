import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { CronLoggerService } from '../cron/cron-logger.service';
import { AccessLogRetentionCron } from './access-log-retention.cron';
import { accessLogConfigProvider } from './access-log.config';
import { AccessLogInterceptor } from './access-log.interceptor';
import { AccessLogService } from './access-log.service';

/**
 * Registro de acesso (Marco Civil, art. 15): interceptor global nas rotas de entrada e de geração, gravação fora do
 * caminho da resposta e apagamento depois da guarda, salvo guarda legal. Fora dos modos da trava de imagem: vale
 * sempre. O CronLoggerService (sem estado, só o Prisma global) entra direto, sem puxar o CronModule e as dependências
 * dele: o apagamento aparece em /admin/crons do mesmo jeito.
 */
@Module({
  providers: [
    accessLogConfigProvider,
    CronLoggerService,
    AccessLogService,
    AccessLogRetentionCron,
    { provide: APP_INTERCEPTOR, useClass: AccessLogInterceptor },
  ],
  exports: [AccessLogService],
})
export class AccessLogModule {}
