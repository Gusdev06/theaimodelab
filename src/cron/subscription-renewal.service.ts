import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CreditTransactionType, Plan, Subscription, SubscriptionStatus } from '@prisma/client';
import { CronLoggerService } from './cron-logger.service';

const SCHEDULE = '0 * * * *';

@Injectable()
export class SubscriptionRenewalService {
  private readonly logger = new Logger(SubscriptionRenewalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleSubscriptionRenewal() {
    try {
      return await this.cronLogger.wrap(
        { cronName: 'SubscriptionRenewalService.handleSubscriptionRenewal', schedule: SCHEDULE },
        async () => {
          const now = new Date();

          const expiredSubscriptions = await this.prisma.subscription.findMany({
            where: {
              status: SubscriptionStatus.ACTIVE,
              currentPeriodEnd: { lte: now },
              cancelAtPeriodEnd: false,
              paymentProvider: null,
            },
            include: { plan: true },
          });

          this.logger.log(`Found ${expiredSubscriptions.length} subscriptions to renew`);

          let renewed = 0;
          let renewalFailed = 0;
          for (const subscription of expiredSubscriptions) {
            try {
              await this.renewSubscription(subscription);
              renewed++;
            } catch (error: any) {
              renewalFailed++;
              this.logger.error(
                `Failed to renew subscription ${subscription.id}: ${error.message}`,
              );
            }
          }

          const cancelingSubscriptions = await this.prisma.subscription.findMany({
            where: {
              status: SubscriptionStatus.ACTIVE,
              currentPeriodEnd: { lte: now },
              cancelAtPeriodEnd: true,
              paymentProvider: null,
            },
          });

          let canceled = 0;
          for (const subscription of cancelingSubscriptions) {
            try {
              await this.prisma.subscription.update({
                where: { id: subscription.id },
                data: { status: SubscriptionStatus.CANCELED },
              });
              canceled++;
              this.logger.log(`Canceled subscription ${subscription.id} at period end`);
            } catch (error: any) {
              this.logger.error(
                `Failed to cancel subscription ${subscription.id}: ${error.message}`,
              );
            }
          }

          return {
            renewed,
            renewalFailed,
            canceled,
            totalProcessed: expiredSubscriptions.length + cancelingSubscriptions.length,
          };
        },
      );
    } catch (error: any) {
      this.logger.error(`Subscription renewal cron failed: ${error.message}`, error.stack);
    }
  }

  private async renewSubscription(
    subscription: Subscription & { plan: Plan },
  ) {
    const newPeriodStart = subscription.currentPeriodEnd;
    const newPeriodEnd = new Date(newPeriodStart);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);

    // Plans without monthly renewal (creditsPerMonth === 0) only advance the
    // period — saldo é preservado. Usado pelo Free em v5 (sem créditos).
    if (subscription.plan.creditsPerMonth === 0) {
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
        },
      });

      this.logger.log(
        `Advanced period for subscription ${subscription.id} (plan "${subscription.plan.slug}" has no monthly credits)`,
      );
      return;
    }

    const credits = subscription.plan.creditsPerMonth;

    await this.prisma.$transaction(async (tx) => {
      // Update subscription period
      await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          currentPeriodStart: newPeriodStart,
          currentPeriodEnd: newPeriodEnd,
        },
      });

      // Reset plan credits for the new period
      await tx.creditBalance.upsert({
        where: { userId: subscription.userId },
        create: {
          userId: subscription.userId,
          planCreditsRemaining: credits,
          bonusCreditsRemaining: 0,
          planCreditsUsed: 0,
          periodStart: newPeriodStart,
          periodEnd: newPeriodEnd,
        },
        update: {
          planCreditsRemaining: credits,
          planCreditsUsed: 0,
          periodStart: newPeriodStart,
          periodEnd: newPeriodEnd,
        },
      });

      // Record the credit transaction
      if (credits > 0) {
        await tx.creditTransaction.create({
          data: {
            userId: subscription.userId,
            type: CreditTransactionType.SUBSCRIPTION_RENEWAL,
            amount: credits,
            source: 'plan',
            description: `Renovação do plano ${subscription.plan.name} — ${credits} créditos`,
          },
        });
      }
    });

    this.logger.log(
      `Renewed subscription ${subscription.id} for user ${subscription.userId} (${credits} credits)`,
    );
  }
}
