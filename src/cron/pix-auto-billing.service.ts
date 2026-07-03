import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AsaasSubscriptionsService } from '../payments/asaas-subscriptions.service';
import { CronLoggerService } from './cron-logger.service';

const SCHEDULE = '0 6 * * *'; // 06:00 todo dia
const DAYS_BEFORE_DUE = 3; // janela alvo: cria cobrança 3 dias antes do vencimento

/**
 * Cron diário que cria cobranças recorrentes para subscriptions PIX Automático.
 *
 * Regra do BACEN: cobranças devem ser criadas entre 2 e 10 dias úteis antes do
 * vencimento. Rodamos diariamente pra capturar subs que entram na janela.
 *
 * Idempotência: skipamos subscriptions que já têm Payment criado nos últimos
 * 5 dias (1 cobrança por ciclo).
 */
@Injectable()
export class PixAutoBillingService {
  private readonly logger = new Logger(PixAutoBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly asaasSubscriptionsService: AsaasSubscriptionsService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handlePixAutoBilling() {
    return this.cronLogger.wrap(
      { cronName: 'PixAutoBillingService.handlePixAutoBilling', schedule: SCHEDULE },
      async () => {
        const now = new Date();
        const windowStart = new Date(now);
        windowStart.setDate(windowStart.getDate() + 2);
        const windowEnd = new Date(now);
        windowEnd.setDate(windowEnd.getDate() + DAYS_BEFORE_DUE + 1);

        const candidates = await this.prisma.subscription.findMany({
          where: {
            status: 'ACTIVE',
            paymentMethod: 'pix_auto_asaas',
            asaasAuthorizationStatus: 'ACTIVE',
            currentPeriodEnd: { gte: windowStart, lte: windowEnd },
          },
          include: { plan: true, user: true },
        });

        this.logger.log(
          `Found ${candidates.length} PIX Auto subscriptions in billing window`,
        );

        let created = 0;
        let skipped = 0;
        let failed = 0;

        for (const sub of candidates) {
          try {
            const recent = await this.prisma.payment.findFirst({
              where: {
                subscriptionId: sub.id,
                createdAt: { gte: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) },
              },
            });

            if (recent) {
              skipped++;
              continue;
            }

            if (!sub.asaasAuthorizationId || !sub.user.asaasCustomerId) {
              this.logger.warn(
                `Subscription ${sub.id} sem authorizationId ou customerId — skip`,
              );
              skipped++;
              continue;
            }

            const dueDate = sub.currentPeriodEnd.toISOString().slice(0, 10);

            const charge = await this.asaasSubscriptionsService.createRecurringCharge({
              customerId: sub.user.asaasCustomerId,
              authorizationId: sub.asaasAuthorizationId,
              valueCents: sub.plan.priceCents,
              dueDate,
              description: `Renovação ${sub.plan.name} (The AI Model Lab)`,
              externalReference: JSON.stringify({
                userId: sub.userId,
                planSlug: sub.plan.slug,
                subscriptionId: sub.id,
              }),
            });

            await this.prisma.payment.create({
              data: {
                userId: sub.userId,
                type: 'SUBSCRIPTION',
                amountCents: sub.plan.priceCents,
                currency: 'BRL',
                status: 'PENDING',
                provider: 'asaas',
                externalPaymentId: charge.id,
                subscriptionId: sub.id,
              },
            });

            created++;
            this.logger.log(
              `Created recurring charge ${charge.id} for subscription ${sub.id} (due ${dueDate})`,
            );
          } catch (error) {
            failed++;
            this.logger.error(
              `Failed to create charge for subscription ${sub.id}: ${error instanceof Error ? error.message : error}`,
            );
          }
        }

        this.logger.log(
          `PIX Auto billing done — created=${created} skipped=${skipped} failed=${failed}`,
        );
      },
    );
  }
}
