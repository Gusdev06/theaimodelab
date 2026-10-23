import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReferralsService } from '../referrals/referrals.service';
import { CronLoggerService } from './cron-logger.service';

const SCHEDULE = '*/10 * * * *';

/**
 * Paga as indicações cujo indicado já concluiu a 1ª geração com o e-mail verificado.
 * O gatilho fica fora do processamento de geração de propósito: cobre fila, webhook e
 * avatar sem tocar neles. Quem indicou também recebe na hora ao abrir o painel.
 */
@Injectable()
export class ReferralRewardsService {
  private readonly logger = new Logger(ReferralRewardsService.name);

  constructor(
    private readonly referralsService: ReferralsService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleSweep() {
    try {
      return await this.cronLogger.wrap(
        { cronName: 'ReferralRewardsService.handleSweep', schedule: SCHEDULE },
        async () => this.referralsService.sweepPending(),
      );
    } catch (error) {
      this.logger.error(
        `Varredura de indicações falhou: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
