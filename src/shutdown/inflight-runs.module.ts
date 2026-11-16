import { Global, Module } from '@nestjs/common';
import { InflightRunsService } from './inflight-runs.service';

/** Global: qualquer módulo que roda geração fora da fila registra a execução aqui. */
@Global()
@Module({
  providers: [InflightRunsService],
  exports: [InflightRunsService],
})
export class InflightRunsModule {}
