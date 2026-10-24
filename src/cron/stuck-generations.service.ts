import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreditTransactionType,
  Generation,
  GenerationStatus,
  GenerationType,
} from '@prisma/client';
import { CronLoggerService } from './cron-logger.service';
import { computeRefundable } from '../credits/refundable';

/**
 * Janela por família, contada a partir de `processingStartedAt` (quando o
 * worker pegou o job), não de `createdAt`: uma geração que ficou na fila não é
 * "presa", e um vídeo que passou pelo modelo alternativo ganha a janela inteira
 * de novo (TKT-107). Quem nunca começou a processar tem uma janela própria,
 * contada da criação.
 */
export const STUCK_THRESHOLD_MINUTES = {
  image: 20,
  video: 45,
  audio: 10,
  /** PROCESSING sem processingStartedAt: ainda na fila (ou job perdido). */
  queued: 60,
} as const;

const IMAGE_TYPES: GenerationType[] = [
  GenerationType.TEXT_TO_IMAGE,
  GenerationType.IMAGE_TO_IMAGE,
  GenerationType.FACE_SWAP,
  GenerationType.VIRTUAL_TRY_ON,
];
const AUDIO_TYPES: GenerationType[] = [GenerationType.VOICE_CLONE];
const VIDEO_TYPES: GenerationType[] = [
  GenerationType.TEXT_TO_VIDEO,
  GenerationType.IMAGE_TO_VIDEO,
  GenerationType.REFERENCE_VIDEO,
  GenerationType.MOTION_CONTROL,
  GenerationType.SPOKEN_VIDEO,
  GenerationType.AVATAR_VIDEO,
];

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
        {
          cronName: 'StuckGenerationsService.handleStuckGenerations',
          schedule: SCHEDULE,
        },
        async () => {
          const stuckGenerations = await this.prisma.generation.findMany({
            where: {
              status: GenerationStatus.PROCESSING,
              OR: StuckGenerationsService.buildStuckConditions(new Date()),
            },
          });

          if (stuckGenerations.length === 0) {
            return { stuckFound: 0, recovered: 0, failed: 0 };
          }

          this.logger.log(
            `Found ${stuckGenerations.length} stuck generations to clean up`,
          );

          let recovered = 0;
          let failed = 0;
          for (const generation of stuckGenerations) {
            try {
              await this.failAndRefund(generation);
              recovered++;
            } catch (error) {
              failed++;
              this.logger.error(
                `Failed to clean up stuck generation ${generation.id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }

          return { stuckFound: stuckGenerations.length, recovered, failed };
        },
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Stuck generations cron failed: ${failure.message}`,
        failure.stack,
      );
    }
  }

  static buildStuckConditions(now: Date) {
    const before = (minutes: number): Date =>
      new Date(now.getTime() - minutes * 60_000);
    return [
      {
        type: { in: IMAGE_TYPES },
        processingStartedAt: { lt: before(STUCK_THRESHOLD_MINUTES.image) },
      },
      {
        type: { in: VIDEO_TYPES },
        processingStartedAt: { lt: before(STUCK_THRESHOLD_MINUTES.video) },
      },
      {
        type: { in: AUDIO_TYPES },
        processingStartedAt: { lt: before(STUCK_THRESHOLD_MINUTES.audio) },
      },
      {
        processingStartedAt: null,
        createdAt: { lt: before(STUCK_THRESHOLD_MINUTES.queued) },
      },
    ];
  }

  private async failAndRefund(generation: Generation) {
    let refunded = 0;
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

      // Só devolve o que foi debitado para esta geração e ainda não devolvido.
      // Sem GENERATION_DEBIT não há estorno: a linha nasceu sem cobrança
      // (débito falhou/abortou) e "devolver" em bônus era crédito do nada (TKT-096).
      const ledger = await tx.creditTransaction.findMany({
        where: {
          generationId: generation.id,
          type: {
            in: [
              CreditTransactionType.GENERATION_DEBIT,
              CreditTransactionType.GENERATION_REFUND,
            ],
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      const refundable = computeRefundable(ledger, generation.creditsConsumed);
      if (!refundable) {
        this.logger.warn(
          `Generation ${generation.id} timed out with creditsConsumed=${generation.creditsConsumed} but no GENERATION_DEBIT — nothing to refund`,
        );
        return;
      }
      const { plan: planRefund, bonus: bonusRefund } = refundable;
      if (planRefund + bonusRefund === 0) {
        return;
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
      refunded = planRefund + bonusRefund;
    });

    this.logger.warn(
      `Marked generation ${generation.id} as failed (timeout) and refunded ${refunded} credits`,
    );
  }
}
