import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TakedownService } from './takedown.service';

/** A cada 10 min, a purga do CDN que ficou pendente (sem token) ou falhou é tentada de novo. */
export const TAKEDOWN_PURGE_SCHEDULE = '*/10 * * * *';

@Injectable()
export class TakedownPurgeCron {
  private readonly logger = new Logger(TakedownPurgeCron.name);
  private running = false;

  constructor(private readonly takedown: TakedownService) {}

  /** Sem argumento de propósito: o agendador chama o método com argumentos dele. */
  @Cron(TAKEDOWN_PURGE_SCHEDULE, { name: 'takedown-purge-retry' })
  async handle(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.takedown.retryPendingPurges();
    } catch (error) {
      this.logger.error(
        `A varredura das purgas do CDN falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
