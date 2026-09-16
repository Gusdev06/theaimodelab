import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CronLoggerService } from './cron-logger.service';

const SCHEDULE = '15 * * * *';

/**
 * Plano ANUAL: o gateway cobra uma vez e a assinatura vale 12 meses, mas os créditos
 * são mensais (plans.credits_per_month) — nunca 12x no dia 1. O webhook do pagamento
 * abre o primeiro ciclo de 1 mês no credit_balance; este cron vira os ciclos
 * seguintes: quando o period_end do saldo passa e a assinatura anual ainda está
 * ativa, reseta os créditos do plano e abre o próximo mês (a partir do period_end
 * anterior, sem deriva). Bônus (pacotes) é preservado, igual à renovação mensal.
 */
@Injectable()
export class AnnualCreditsRefillService {
  private readonly logger = new Logger(AnnualCreditsRefillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleRefill() {
    try {
      return await this.cronLogger.wrap(
        { cronName: 'AnnualCreditsRefillService.handleRefill', schedule: SCHEDULE },
        async () => {
          const now = new Date();

          const due = await this.prisma.subscription.findMany({
            where: {
              status: SubscriptionStatus.ACTIVE,
              currentPeriodEnd: { gt: now },
              plan: { billingInterval: 'year' },
              user: { creditBalance: { periodEnd: { lte: now } } },
            },
            select: {
              id: true,
              userId: true,
              currentPeriodEnd: true,
              plan: { select: { name: true, creditsPerMonth: true } },
              user: { select: { creditBalance: { select: { periodEnd: true } } } },
            },
          });

          this.logger.log(`Found ${due.length} annual subscriptions due for monthly credit refill`);

          let refilled = 0;
          for (const sub of due) {
            try {
              const prevEnd = sub.user.creditBalance?.periodEnd ?? now;
              // Próximo ciclo começa onde o anterior acabou; se ficou muito pra trás
              // (cron parado), pula meses inteiros até passar de agora.
              const nextEnd = new Date(prevEnd);
              while (nextEnd <= now) nextEnd.setMonth(nextEnd.getMonth() + 1);
              const cappedEnd = nextEnd > sub.currentPeriodEnd ? sub.currentPeriodEnd : nextEnd;

              await this.prisma.$transaction(async (tx) => {
                await tx.creditBalance.update({
                  where: { userId: sub.userId },
                  data: {
                    planCreditsRemaining: sub.plan.creditsPerMonth,
                    planCreditsUsed: 0,
                    periodStart: now,
                    periodEnd: cappedEnd,
                  },
                });
                await tx.creditTransaction.create({
                  data: {
                    userId: sub.userId,
                    type: 'SUBSCRIPTION_RENEWAL',
                    amount: sub.plan.creditsPerMonth,
                    source: 'plan',
                    description: `Ciclo mensal do plano anual ${sub.plan.name} — ${sub.plan.creditsPerMonth} créditos`,
                  },
                });
              });
              refilled++;
            } catch (error: any) {
              this.logger.error(`Failed to refill annual subscription ${sub.id}: ${error.message}`);
            }
          }

          return { candidates: due.length, refilled };
        },
      );
    } catch (error: any) {
      this.logger.error(`Annual credits refill cron failed: ${error.message}`, error.stack);
    }
  }
}
