import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { IMAGE_EVIDENCE_EVENT_KINDS } from '../content-safety/safety-event-kinds';
import {
  GENERATION_OUTPUT_ROOT,
  UploadsService,
} from '../uploads/uploads.service';
import {
  CreditTransactionType,
  Generation,
  GenerationStatus,
} from '@prisma/client';
import { CronLoggerService } from './cron-logger.service';

const STUCK_THRESHOLD_MINUTES = 25;
const SCHEDULE = '*/15 * * * *';

/**
 * Presa = PROCESSING (IN_REVIEW nunca entra: a quarentena tem cron próprio) há mais do limite, contado do fim da
 * checagem de segurança (safetyCheckedAt) quando houver, senão da criação: a espera do porteiro na fila (até 10 min)
 * não come o tempo do provedor. PR API #3 (que conta de processingStartedAt): no merge, a referência é o mais
 * recente entre processingStartedAt e safetyCheckedAt (createdAt só quando os dois são nulos).
 */
export function stuckGenerationsWhere(threshold: Date) {
  return {
    status: GenerationStatus.PROCESSING,
    OR: [
      { safetyCheckedAt: null, createdAt: { lt: threshold } },
      { safetyCheckedAt: { lt: threshold } },
    ],
  };
}

@Injectable()
export class StuckGenerationsService {
  private readonly logger = new Logger(StuckGenerationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronLogger: CronLoggerService,
    /** para apagar a sobra do resultado na quarentena (só com a checagem de imagem gravando nela) */
    @Optional() private readonly uploads?: UploadsService,
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
            where: stuckGenerationsWhere(threshold),
          });

          if (stuckGenerations.length === 0) {
            return { stuckFound: 0, recovered: 0, failed: 0 };
          }

          this.logger.log(`Found ${stuckGenerations.length} stuck generations to clean up`);

          let recovered = 0;
          let failed = 0;
          for (const generation of stuckGenerations) {
            try {
              if (await this.failAndRefund(generation)) recovered++;
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

  /**
   * Encerra uma presa com estorno. A troca para FAILED só vale se ela AINDA estiver PROCESSING (updateMany condicional):
   * a geração que concluiu, falhou ou voltou para a revisão entre a leitura e aqui não é estornada de novo. Devolve
   * false quando outro caminho chegou antes.
   */
  private async failAndRefund(generation: Generation): Promise<boolean> {
    const failed = await this.prisma.$transaction(async (tx) => {
      // Mark generation as failed (só quem ainda está PROCESSING)
      const { count } = await tx.generation.updateMany({
        where: { id: generation.id, status: GenerationStatus.PROCESSING },
        data: {
          status: GenerationStatus.FAILED,
          errorMessage: 'Geração expirou por timeout',
          errorCode: 'GENERATION_TIMEOUT',
        },
      });
      if (count === 0) return false;

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
        return true;
      }

      if (generation.creditsConsumed <= 0) {
        return true;
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
      return true;
    });

    if (!failed) {
      this.logger.log(
        `Generation ${generation.id} já não estava PROCESSING — sem timeout nem estorno`,
      );
      return false;
    }
    this.logger.warn(
      `Marked generation ${generation.id} as failed (timeout) and refunded ${generation.creditsConsumed} credits`,
    );
    await this.discardQuarantinedOutputs(generation.id);
    return true;
  }

  /**
   * Sobra do resultado na quarentena de uma presa (upload parcial, hold que não foi gravado): apaga só a pasta da
   * geração no bucket de quarentena, e só com a checagem de imagem gravando nele. Geração com evidência de imagem em
   * guarda (evento sem liberação) fica como está. Nunca lança.
   */
  private async discardQuarantinedOutputs(generationId: string): Promise<void> {
    if (!this.uploads?.quarantineEnabled) return;
    try {
      const held = await this.prisma.contentSafetyEvent.count({
        where: {
          generationId,
          kind: { in: [...IMAGE_EVIDENCE_EVENT_KINDS] },
          releasedAt: null,
        },
      });
      if (held > 0) return;
      await this.uploads.deleteQuarantinePrefix(
        `${GENERATION_OUTPUT_ROOT}/${generationId}/`,
      );
    } catch (error) {
      this.logger.warn(
        `Generation ${generationId}: sobra da quarentena não apagada (${(error as Error).message})`,
      );
    }
  }
}
