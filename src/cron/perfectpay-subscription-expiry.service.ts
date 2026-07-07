import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionStatus } from '@prisma/client';
import { CronLoggerService } from './cron-logger.service';

const SCHEDULE = '0 * * * *';

// A Perfect Pay controla a recorrência: a cada cobrança mensal renovamos a
// assinatura via webhook (estende o período + reseta créditos). Se o período
// vence e nenhuma renovação chega, a assinatura terminou (cancelamento ou
// falha de pagamento) — este cron a expira e zera os créditos do plano.
//
// Carência para assinaturas NÃO marcadas para cancelar: tolera atraso entre a
// data de cobrança e a chegada do webhook antes de expirar.
const GRACE_DAYS = 3;

@Injectable()
export class PerfectpaySubscriptionExpiryService {
  private readonly logger = new Logger(PerfectpaySubscriptionExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleExpiry() {
    try {
      return await this.cronLogger.wrap(
        { cronName: 'PerfectpaySubscriptionExpiryService.handleExpiry', schedule: SCHEDULE },
        async () => {
          const now = new Date();
          const graceCutoff = new Date(now);
          graceCutoff.setDate(graceCutoff.getDate() - GRACE_DAYS);

          const expired = await this.prisma.subscription.findMany({
            where: {
              paymentProvider: 'perfectpay',
              status: SubscriptionStatus.ACTIVE,
              OR: [
                // Cancelamento agendado: expira exatamente no fim do período pago.
                { cancelAtPeriodEnd: true, currentPeriodEnd: { lte: now } },
                // Sem renovação após o vencimento (+ carência): pagamento lapsou.
                { cancelAtPeriodEnd: false, currentPeriodEnd: { lte: graceCutoff } },
              ],
            },
            select: { id: true, userId: true },
          });

          this.logger.log(`Found ${expired.length} lapsed Perfect Pay subscriptions to expire`);

          let expiredCount = 0;
          for (const sub of expired) {
            try {
              await this.prisma.$transaction(async (tx) => {
                await tx.subscription.update({
                  where: { id: sub.id },
                  data: { status: SubscriptionStatus.CANCELED },
                });
                await tx.creditBalance.updateMany({
                  where: { userId: sub.userId },
                  data: { planCreditsRemaining: 0, planCreditsUsed: 0 },
                });
              });
              expiredCount++;
              this.logger.log(`Expired Perfect Pay subscription ${sub.id} (user ${sub.userId})`);
            } catch (error: any) {
              this.logger.error(
                `Failed to expire subscription ${sub.id}: ${error.message}`,
              );
            }
          }

          return { candidates: expired.length, expired: expiredCount };
        },
      );
    } catch (error: any) {
      this.logger.error(`Perfect Pay expiry cron failed: ${error.message}`, error.stack);
    }
  }
}
