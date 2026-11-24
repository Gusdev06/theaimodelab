import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MiaChatterService } from './mia-chatter.service';

/**
 * A cada 2 min lê as conversas das contas ligadas e responde (metade dos compradores compra no 1º dia: responder rápido
 * vende; kit, regra 1). Com MIA_CHATTER_ENABLED off sai na 1ª linha, sem tocar no banco nem na rede.
 */
@Injectable()
export class MiaChatterCron {
  private readonly logger = new Logger(MiaChatterCron.name);

  constructor(private readonly service: MiaChatterService) {}

  @Cron('*/2 * * * *')
  async tick(): Promise<void> {
    if (!this.service.enabled()) return;
    try {
      const result = await this.service.runOnce();
      if (result.replies > 0) this.logger.log(`[MIA_CHATTER] ${result.replies} respostas em ${result.accounts} contas`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[MIA_CHATTER] rodada falhou: ${reason.slice(0, 200)}`);
    }
  }
}
