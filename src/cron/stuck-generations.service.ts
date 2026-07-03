import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreditTransactionType,
  Generation,
  GenerationStatus,
} from '@prisma/client';
import { CronLoggerService } from './cron-logger.service';

const STUCK_THRESHOLD_MINUTES = 25;
const SCHEDULE = '*/15 * * * *';

@Injectable()
export class StuckGenerationsService {
  private readonly logger = new Logger(StuckGenerationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleStuckGenerations() {
    try {
      return await this.cronLogger.wrap(
        { cronName: 'StuckGenerationsService.handleStuckGenerations', schedule: SCHEDULE },
        async () => {
          const threshold = new Date();
          threshold.setMinutes(threshold.getMinutes() - STUCK_THRESHOLD_MINUTES);

          const stuckGenerations = await this.prisma.generation.findMany({
            where: {
              status: GenerationStatus.PROCESSING,
              createdAt: { lt: threshold },
            },
          });

          if (stuckGenerations.length === 0) {
            return { stuckFound: 0, recovered: 0, failed: 0 };
          }

          this.logger.log(`Found ${stuckGenerations.length} stuck generations to clean up`);

          let recovered = 0;
          let failed = 0;
          for (const generation of stuckGenerations) {
            try {
              await this.failAndRefund(generation);
              recovered++;
            } catch (error: any) {
              failed++;
              this.logger.error(
                `Failed to clean up stuck generation ${generation.id}: ${error.message}`,
              );
            }
          }

          return { stuckFound: stuckGenerations.length, recovered, failed };
        },
      );
    } catch (error: any) {
      this.logger.error(`Stuck generations cron failed: ${error.message}`, error.stack);
    }
  }

  private async failAndRefund(generation: Generation) {
    await this.prisma.$transaction(async (tx) => {
      // Mark generation as failed
      await tx.generation.update({
        where: { id: generation.id },
        data: {
          status: GenerationStatus.FAILED,
          errorMessage: 'Geração expirou por timeout',
          errorCode: 'GENERATION_TIMEOUT',
        },
      });

      // Free generation: restore the free generation slot by type
      if (generation.usedFreeGeneration && generation.usedFreeGenerationType) {
        await tx.userFreeGeneration.upsert({
          where: {
            userId_type: {
              userId: generation.userId,
              type: generation.usedFreeGenerationType,
            },
          },
          create: {
            userId: generation.userId,
            type: generation.usedFreeGenerationType,
            remaining: 1,
          },
          update: { remaining: { increment: 1 } },
        });
        await tx.generation.update({
          where: { id: generation.id },
          data: {
            usedFreeGeneration: false,
            usedFreeGenerationType: null,
          },
        });
        return;
      }

      if (generation.creditsConsumed <= 0) {
        return;
      }

      // Look at the original debit transactions to know where to refund
      const debitTransactions = await tx.creditTransaction.findMany({
        where: {
          generationId: generation.id,
          type: CreditTransactionType.GENERATION_DEBIT,
        },
        orderBy: { createdAt: 'asc' },
      });

      let planRefund = 0;
      let bonusRefund = 0;

      for (const debit of debitTransactions) {
        if (debit.source === 'plan') {
          planRefund += Math.abs(debit.amount);
        } else {
          bonusRefund += Math.abs(debit.amount);
        }
      }

      // If no debit records found, refund to bonus credits as fallback
      if (debitTransactions.length === 0) {
        bonusRefund = generation.creditsConsumed;
      }

      const balance = await tx.creditBalance.findUnique({
        where: { userId: generation.userId },
      });

      if (balance) {
        await tx.creditBalance.update({
          where: { userId: generation.userId },
          data: {
            planCreditsRemaining: balance.planCreditsRemaining + planRefund,
            bonusCreditsRemaining: balance.bonusCreditsRemaining + bonusRefund,
            planCreditsUsed: balance.planCreditsUsed - planRefund,
          },
        });
      }

      if (planRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId: generation.userId,
            type: CreditTransactionType.GENERATION_REFUND,
            amount: planRefund,
            source: 'plan',
            description: `Estorno de ${planRefund} créditos do plano (timeout)`,
            generationId: generation.id,
          },
        });
      }

      if (bonusRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId: generation.userId,
            type: CreditTransactionType.GENERATION_REFUND,
            amount: bonusRefund,
            source: 'bonus',
            description: `Estorno de ${bonusRefund} créditos bônus (timeout)`,
            generationId: generation.id,
          },
        });
      }
    });

    this.logger.warn(
      `Marked generation ${generation.id} as failed (timeout) and refunded ${generation.creditsConsumed} credits`,
    );
  }
}
