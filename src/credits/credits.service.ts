import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import {
  CreditTransactionType,
  FreeGenerationType,
  GenerationType,
  Resolution,
} from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import {
  CreditBalanceResponseDto,
  FreeGenerationsMap,
} from './dto/credit-balance-response.dto';
import { CreditTransactionResponseDto } from './dto/credit-transaction-response.dto';
import { EstimateCostResponseDto } from './dto/estimate-cost.dto';

const EMPTY_FREE_GENERATIONS: FreeGenerationsMap = {
  NB2: 0,
  NB_PRO: 0,
  FACE_SWAP: 0,
  VIRTUAL_TRY_ON: 0,
  THEAIMODELAB_FAST: 0,
  UPSCALE: 0,
  SEM_CENSURA: 0,
  DEEPDEEP: 0,
  GPT_IMAGE_2: 0,
  SEEDREAM_LITE: 0,
  THEAIMODELAB_QUALITY: 0,
  VEO_FAST: 0,
  VEO_MAX: 0,
  GROK_IMAGINE: 0,
  GEMINI_OMNI: 0,
  SEEDANCE_2: 0,
  KLING_V3_TURBO: 0,
  COMFYDEPLOY_WAN: 0,
  MOTION_CONTROL: 0,
};

/**
 * Mapeia o modelVariant (string usada na tabela credit_costs) para o
 * FreeGenerationType correspondente. Cobre todos os modelos existentes.
 */
const VARIANT_TO_FREE_TYPE: Record<string, FreeGenerationType> = {
  NB2: FreeGenerationType.NB2,
  NBP: FreeGenerationType.NB_PRO,
  SEM_CENSURA: FreeGenerationType.SEM_CENSURA,
  DEEPDEEP: FreeGenerationType.DEEPDEEP,
  GPT_IMAGE_2: FreeGenerationType.GPT_IMAGE_2,
  SEEDREAM_LITE: FreeGenerationType.SEEDREAM_LITE,
  THEAIMODELAB_FAST: FreeGenerationType.THEAIMODELAB_FAST,
  THEAIMODELAB_QUALITY: FreeGenerationType.THEAIMODELAB_QUALITY,
  VEO_FAST: FreeGenerationType.VEO_FAST,
  VEO_MAX: FreeGenerationType.VEO_MAX,
  GROK_IMAGINE: FreeGenerationType.GROK_IMAGINE,
  GEMINI_OMNI: FreeGenerationType.GEMINI_OMNI,
  SEEDANCE_2: FreeGenerationType.SEEDANCE_2,
  KLING_V3_TURBO: FreeGenerationType.KLING_V3_TURBO,
  COMFYDEPLOY_WAN: FreeGenerationType.COMFYDEPLOY_WAN,
};

/**
 * Mapeia (generationType, modelVariant) para o tipo de geração grátis elegível.
 * Retorna null se a combinação não tem free generation.
 * Tipos derivados do generationType (face swap, try-on, motion control) têm
 * precedência; o restante é resolvido pelo modelVariant.
 */
export function resolveFreeGenerationType(
  type: GenerationType,
  modelVariant: string | null | undefined,
): FreeGenerationType | null {
  if (type === GenerationType.FACE_SWAP) return FreeGenerationType.FACE_SWAP;
  if (type === GenerationType.VIRTUAL_TRY_ON) return FreeGenerationType.VIRTUAL_TRY_ON;
  if (type === GenerationType.MOTION_CONTROL) return FreeGenerationType.MOTION_CONTROL;
  if (modelVariant && VARIANT_TO_FREE_TYPE[modelVariant]) {
    return VARIANT_TO_FREE_TYPE[modelVariant];
  }
  return null;
}

@Injectable()
export class CreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plansService: PlansService,
  ) {}

  async getBalance(userId: string): Promise<CreditBalanceResponseDto> {
    const [balance, freeGens] = await Promise.all([
      this.prisma.creditBalance.findUnique({ where: { userId } }),
      this.prisma.userFreeGeneration.findMany({ where: { userId } }),
    ]);

    const freeGenerations = { ...EMPTY_FREE_GENERATIONS };
    for (const fg of freeGens) {
      freeGenerations[fg.type] = fg.remaining;
    }

    if (!balance) {
      return {
        planCreditsRemaining: 0,
        bonusCreditsRemaining: 0,
        totalCreditsAvailable: 0,
        planCreditsUsed: 0,
        freeGenerations,
        periodStart: null,
        periodEnd: null,
      };
    }

    return {
      planCreditsRemaining: balance.planCreditsRemaining,
      bonusCreditsRemaining: balance.bonusCreditsRemaining,
      totalCreditsAvailable:
        balance.planCreditsRemaining + balance.bonusCreditsRemaining,
      planCreditsUsed: balance.planCreditsUsed,
      freeGenerations,
      periodStart: balance.periodStart,
      periodEnd: balance.periodEnd,
    };
  }

  async getTransactions(
    userId: string,
    pagination: PaginationDto,
  ): Promise<PaginatedResponseDto<CreditTransactionResponseDto>> {
    const [transactions, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.creditTransaction.count({
        where: { userId },
      }),
    ]);

    const data: CreditTransactionResponseDto[] = transactions.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      source: tx.source,
      description: tx.description,
      generationId: tx.generationId,
      paymentId: tx.paymentId,
      createdAt: tx.createdAt,
    }));

    return new PaginatedResponseDto(
      data,
      total,
      pagination.page,
      pagination.limit,
    );
  }

  async getPackages() {
    return this.plansService.findAllPackages();
  }

  async estimateCost(
    userId: string,
    type: GenerationType,
    resolution: Resolution,
    durationSeconds?: number,
    hasAudio: boolean = false,
    sampleCount: number = 1,
    modelVariant?: string,
    freeGenerationTypeOverride?: FreeGenerationType,
    hasVideoInput: boolean = false,
  ): Promise<EstimateCostResponseDto> {
    const creditsRequired = await this.plansService.calculateGenerationCost(
      type,
      resolution,
      durationSeconds,
      hasAudio,
      sampleCount,
      modelVariant,
      hasVideoInput,
    );

    const balance = await this.getBalance(userId);
    const freeGenerationType =
      freeGenerationTypeOverride ??
      resolveFreeGenerationType(type, modelVariant ?? null);

    const freeGenerationsRemainingForType = freeGenerationType
      ? balance.freeGenerations[freeGenerationType]
      : 0;
    const canUseFreeGeneration =
      freeGenerationType !== null && freeGenerationsRemainingForType > 0;

    return {
      creditsRequired,
      hasSufficientBalance:
        canUseFreeGeneration ||
        balance.totalCreditsAvailable >= creditsRequired,
      canUseFreeGeneration,
      freeGenerationType,
      freeGenerationsRemainingForType,
    };
  }

  async addBonusCredits(
    userId: string,
    amount: number,
    description: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.creditBalance.upsert({
        where: { userId },
        create: {
          userId,
          bonusCreditsRemaining: amount,
          planCreditsRemaining: 0,
          planCreditsUsed: 0,
        },
        update: {
          bonusCreditsRemaining: { increment: amount },
        },
      });

      await tx.creditTransaction.create({
        data: {
          userId,
          type: CreditTransactionType.REFERRAL_BONUS,
          amount,
          source: 'bonus',
          description,
        },
      });
    });
  }

  async debit(
    userId: string,
    amount: number,
    type: CreditTransactionType,
    generationId?: string,
    description?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Use SELECT FOR UPDATE to prevent race conditions on concurrent debits
      const [balance] = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM "credit_balances" WHERE "user_id" = $1 FOR UPDATE`,
        userId,
      );

      if (!balance) {
        throw new NotFoundException('Saldo de créditos não encontrado');
      }

      const totalAvailable =
        balance.plan_credits_remaining + balance.bonus_credits_remaining;

      if (totalAvailable < amount) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_CREDITS',
          message: `Créditos insuficientes. Necessário: ${amount}, disponível: ${totalAvailable}.`,
          statusCode: 402,
        });
      }

      // Debit plan credits first, then bonus
      let remainingDebit = amount;
      let planDebit = 0;
      let bonusDebit = 0;

      if (balance.plan_credits_remaining >= remainingDebit) {
        planDebit = remainingDebit;
        remainingDebit = 0;
      } else {
        planDebit = balance.plan_credits_remaining;
        remainingDebit -= planDebit;
        bonusDebit = remainingDebit;
      }

      await tx.creditBalance.update({
        where: { userId },
        data: {
          planCreditsRemaining: balance.plan_credits_remaining - planDebit,
          bonusCreditsRemaining: balance.bonus_credits_remaining - bonusDebit,
          planCreditsUsed: balance.plan_credits_used + planDebit,
        },
      });

      // Create transaction record(s)
      if (planDebit > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type,
            amount: -planDebit,
            source: 'plan',
            description: description || `Débito de ${planDebit} créditos do plano`,
            generationId,
          },
        });
      }

      if (bonusDebit > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type,
            amount: -bonusDebit,
            source: 'bonus',
            description: description || `Débito de ${bonusDebit} créditos bônus`,
            generationId,
          },
        });
      }
    });
  }

  async refund(
    userId: string,
    amount: number,
    generationId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Look at the original debit transactions to know where to refund
      const debitTransactions = await tx.creditTransaction.findMany({
        where: {
          generationId,
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
        bonusRefund = amount;
      }

      // Use SELECT FOR UPDATE to prevent race conditions on concurrent refunds
      const [balance] = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM "credit_balances" WHERE "user_id" = $1 FOR UPDATE`,
        userId,
      );

      if (!balance) {
        throw new NotFoundException('Saldo de créditos não encontrado');
      }

      await tx.creditBalance.update({
        where: { userId },
        data: {
          planCreditsRemaining: balance.plan_credits_remaining + planRefund,
          bonusCreditsRemaining: balance.bonus_credits_remaining + bonusRefund,
          planCreditsUsed: balance.plan_credits_used - planRefund,
        },
      });

      if (planRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.GENERATION_REFUND,
            amount: planRefund,
            source: 'plan',
            description: `Estorno de ${planRefund} créditos do plano`,
            generationId,
          },
        });
      }

      if (bonusRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.GENERATION_REFUND,
            amount: bonusRefund,
            source: 'bonus',
            description: `Estorno de ${bonusRefund} créditos bônus`,
            generationId,
          },
        });
      }
    });
  }

  /**
   * Reconciles the credits charged for a generation after the real cost is known.
   * Used by the HeyGen avatar-video webhook: the upfront debit is an estimate
   * based on script length, and the webhook reports the actual video duration.
   *
   *  - Positive deltaCredits → user was overcharged → refund (mirrors plan/bonus
   *    proportions of the original debits).
   *  - Negative deltaCredits → user was undercharged → debit the difference,
   *    capped at the user's current balance (we don't model negative balances —
   *    a tiny under-recovery is preferable to blocking the generation).
   */
  async adjustGenerationCost(
    userId: string,
    generationId: string,
    deltaCredits: number,
    description: string,
  ): Promise<void> {
    if (deltaCredits === 0) return;

    await this.prisma.$transaction(async (tx) => {
      const [balance] = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM "credit_balances" WHERE "user_id" = $1 FOR UPDATE`,
        userId,
      );
      if (!balance) {
        throw new NotFoundException('Saldo de créditos não encontrado');
      }

      if (deltaCredits > 0) {
        // Refund the diff. Mirror the source proportions of the original debits
        // so plan/bonus accounting stays consistent.
        const debits = await tx.creditTransaction.findMany({
          where: { generationId, type: CreditTransactionType.GENERATION_DEBIT },
        });
        const planDebited = debits
          .filter((d) => d.source === 'plan')
          .reduce((sum, d) => sum + Math.abs(d.amount), 0);
        const totalDebited = debits.reduce((sum, d) => sum + Math.abs(d.amount), 0);

        let planRefund = 0;
        let bonusRefund = 0;
        if (totalDebited > 0) {
          planRefund = Math.round((planDebited / totalDebited) * deltaCredits);
          bonusRefund = deltaCredits - planRefund;
        } else {
          bonusRefund = deltaCredits;
        }

        await tx.creditBalance.update({
          where: { userId },
          data: {
            planCreditsRemaining: balance.plan_credits_remaining + planRefund,
            bonusCreditsRemaining: balance.bonus_credits_remaining + bonusRefund,
            planCreditsUsed: Math.max(0, balance.plan_credits_used - planRefund),
          },
        });

        if (planRefund > 0) {
          await tx.creditTransaction.create({
            data: {
              userId,
              type: CreditTransactionType.GENERATION_REFUND,
              amount: planRefund,
              source: 'plan',
              description,
              generationId,
            },
          });
        }
        if (bonusRefund > 0) {
          await tx.creditTransaction.create({
            data: {
              userId,
              type: CreditTransactionType.GENERATION_REFUND,
              amount: bonusRefund,
              source: 'bonus',
              description,
              generationId,
            },
          });
        }
        return;
      }

      // deltaCredits < 0 — we need to debit more. Cap at current balance.
      const shortfall = Math.abs(deltaCredits);
      const totalAvailable =
        balance.plan_credits_remaining + balance.bonus_credits_remaining;
      const toDebit = Math.min(shortfall, totalAvailable);
      if (toDebit <= 0) return;

      let planDebit = 0;
      let bonusDebit = 0;
      if (balance.plan_credits_remaining >= toDebit) {
        planDebit = toDebit;
      } else {
        planDebit = balance.plan_credits_remaining;
        bonusDebit = toDebit - planDebit;
      }

      await tx.creditBalance.update({
        where: { userId },
        data: {
          planCreditsRemaining: balance.plan_credits_remaining - planDebit,
          bonusCreditsRemaining: balance.bonus_credits_remaining - bonusDebit,
          planCreditsUsed: balance.plan_credits_used + planDebit,
        },
      });

      if (planDebit > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.GENERATION_DEBIT,
            amount: -planDebit,
            source: 'plan',
            description,
            generationId,
          },
        });
      }
      if (bonusDebit > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.GENERATION_DEBIT,
            amount: -bonusDebit,
            source: 'bonus',
            description,
            generationId,
          },
        });
      }
    });
  }

  /**
   * Debit credits for avatar training. Symmetric to debit() but the resulting
   * transactions link to userAvatarId instead of generationId, with type
   * AVATAR_TRAINING_DEBIT so it shows up separately in the user's history.
   */
  async debitForAvatar(
    userId: string,
    amount: number,
    userAvatarId: string,
    description?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [balance] = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM "credit_balances" WHERE "user_id" = $1 FOR UPDATE`,
        userId,
      );

      if (!balance) {
        throw new NotFoundException('Saldo de créditos não encontrado');
      }

      const totalAvailable =
        balance.plan_credits_remaining + balance.bonus_credits_remaining;

      if (totalAvailable < amount) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_CREDITS',
          message: `Créditos insuficientes. Necessário: ${amount}, disponível: ${totalAvailable}.`,
          statusCode: 402,
        });
      }

      let remainingDebit = amount;
      let planDebit = 0;
      let bonusDebit = 0;

      if (balance.plan_credits_remaining >= remainingDebit) {
        planDebit = remainingDebit;
        remainingDebit = 0;
      } else {
        planDebit = balance.plan_credits_remaining;
        remainingDebit -= planDebit;
        bonusDebit = remainingDebit;
      }

      await tx.creditBalance.update({
        where: { userId },
        data: {
          planCreditsRemaining: balance.plan_credits_remaining - planDebit,
          bonusCreditsRemaining: balance.bonus_credits_remaining - bonusDebit,
          planCreditsUsed: balance.plan_credits_used + planDebit,
        },
      });

      if (planDebit > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.AVATAR_TRAINING_DEBIT,
            amount: -planDebit,
            source: 'plan',
            description: description || `Treinamento de avatar — ${planDebit} créditos do plano`,
            userAvatarId,
          },
        });
      }

      if (bonusDebit > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.AVATAR_TRAINING_DEBIT,
            amount: -bonusDebit,
            source: 'bonus',
            description: description || `Treinamento de avatar — ${bonusDebit} créditos bônus`,
            userAvatarId,
          },
        });
      }
    });
  }

  /**
   * Refund credits for a failed avatar training. Looks up the original
   * AVATAR_TRAINING_DEBIT transactions for the avatar and reverses them
   * to the same buckets (plan/bonus). If no debit found, falls back to bonus.
   */
  async refundForAvatar(
    userId: string,
    userAvatarId: string,
    amount: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const debitTransactions = await tx.creditTransaction.findMany({
        where: {
          userAvatarId,
          type: CreditTransactionType.AVATAR_TRAINING_DEBIT,
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

      if (debitTransactions.length === 0) {
        bonusRefund = amount;
      }

      const [balance] = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM "credit_balances" WHERE "user_id" = $1 FOR UPDATE`,
        userId,
      );

      if (!balance) {
        throw new NotFoundException('Saldo de créditos não encontrado');
      }

      await tx.creditBalance.update({
        where: { userId },
        data: {
          planCreditsRemaining: balance.plan_credits_remaining + planRefund,
          bonusCreditsRemaining: balance.bonus_credits_remaining + bonusRefund,
          planCreditsUsed: balance.plan_credits_used - planRefund,
        },
      });

      if (planRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.AVATAR_TRAINING_REFUND,
            amount: planRefund,
            source: 'plan',
            description: `Estorno de treinamento de avatar — ${planRefund} créditos do plano`,
            userAvatarId,
          },
        });
      }

      if (bonusRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.AVATAR_TRAINING_REFUND,
            amount: bonusRefund,
            source: 'bonus',
            description: `Estorno de treinamento de avatar — ${bonusRefund} créditos bônus`,
            userAvatarId,
          },
        });
      }
    });
  }

  async hasFreeGeneration(
    userId: string,
    type: FreeGenerationType,
  ): Promise<boolean> {
    const row = await this.prisma.userFreeGeneration.findUnique({
      where: { userId_type: { userId, type } },
      select: { remaining: true },
    });
    return (row?.remaining ?? 0) > 0;
  }

  async consumeFreeGeneration(
    userId: string,
    generationId: string,
    type: FreeGenerationType,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Atomic decrement with guard: only succeeds if remaining > 0
      const updated = await tx.$executeRaw`
        UPDATE "user_free_generations"
        SET "remaining" = "remaining" - 1,
            "updated_at" = NOW()
        WHERE "user_id" = ${userId}
          AND "type"::text = ${type}
          AND "remaining" > 0
      `;

      if (updated === 0) {
        throw new BadRequestException({
          code: 'NO_FREE_GENERATIONS',
          message: `Nenhuma geração gratuita de ${type} disponível.`,
        });
      }

      await tx.generation.update({
        where: { id: generationId },
        data: {
          usedFreeGeneration: true,
          usedFreeGenerationType: type,
        },
      });
    });
  }

  async refundFreeGeneration(
    userId: string,
    generationId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const generation = await tx.generation.findUnique({
        where: { id: generationId },
        select: { usedFreeGenerationType: true, usedFreeGeneration: true },
      });

      if (!generation || !generation.usedFreeGenerationType) return;

      const type = generation.usedFreeGenerationType;

      await tx.userFreeGeneration.upsert({
        where: { userId_type: { userId, type } },
        create: { userId, type, remaining: 1 },
        update: { remaining: { increment: 1 } },
      });

      await tx.generation.update({
        where: { id: generationId },
        data: {
          usedFreeGeneration: false,
          usedFreeGenerationType: null,
        },
      });
    });
  }

  async grantFreeGeneration(
    userId: string,
    type: FreeGenerationType,
    amount: number,
  ): Promise<void> {
    if (amount === 0) return;
    await this.prisma.userFreeGeneration.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, remaining: Math.max(0, amount) },
      update: { remaining: { increment: amount } },
    });
  }

  async partialRefund(
    userId: string,
    refundAmount: number,
    generationId: string,
    description?: string,
  ): Promise<void> {
    if (refundAmount <= 0) return;

    await this.prisma.$transaction(async (tx) => {
      const debitTransactions = await tx.creditTransaction.findMany({
        where: {
          generationId,
          type: CreditTransactionType.GENERATION_DEBIT,
        },
        orderBy: { createdAt: 'asc' },
      });

      let planRefund = 0;
      let bonusRefund = 0;

      if (debitTransactions.length > 0) {
        const totalDebited = debitTransactions.reduce(
          (sum, d) => sum + Math.abs(d.amount),
          0,
        );
        const planDebited = debitTransactions
          .filter((d) => d.source === 'plan')
          .reduce((sum, d) => sum + Math.abs(d.amount), 0);
        const bonusDebited = totalDebited - planDebited;

        // Distribute refund proportionally based on original debit ratio
        planRefund = Math.round((planDebited / totalDebited) * refundAmount);
        bonusRefund = refundAmount - planRefund;

        // Ensure we don't refund more than was debited from each source
        if (planRefund > planDebited) {
          planRefund = planDebited;
          bonusRefund = refundAmount - planRefund;
        }
        if (bonusRefund > bonusDebited) {
          bonusRefund = bonusDebited;
          planRefund = refundAmount - bonusRefund;
        }
      } else {
        bonusRefund = refundAmount;
      }

      // Use SELECT FOR UPDATE to prevent race conditions on concurrent partial refunds
      const [balance] = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM "credit_balances" WHERE "user_id" = $1 FOR UPDATE`,
        userId,
      );

      if (!balance) {
        throw new NotFoundException('Saldo de créditos não encontrado');
      }

      await tx.creditBalance.update({
        where: { userId },
        data: {
          planCreditsRemaining: balance.plan_credits_remaining + planRefund,
          bonusCreditsRemaining: balance.bonus_credits_remaining + bonusRefund,
          planCreditsUsed: balance.plan_credits_used - planRefund,
        },
      });

      const refundDesc =
        description || `Estorno parcial de ${refundAmount} créditos`;

      if (planRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.GENERATION_REFUND,
            amount: planRefund,
            source: 'plan',
            description: refundDesc,
            generationId,
          },
        });
      }

      if (bonusRefund > 0) {
        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.GENERATION_REFUND,
            amount: bonusRefund,
            source: 'bonus',
            description: refundDesc,
            generationId,
          },
        });
      }
    });
  }
}
