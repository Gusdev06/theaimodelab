import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreditTransactionType, FreeGenerationType, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  currentWeekWednesdayKey,
  currentWindowClosesAt,
  currentWindowOpensAt,
  isWednesdayInBrt,
  nextWindowOpensAt,
} from './week-key.util';
import { resolveWeeklyReward, type WeeklyReward, type WeeklyRewardKind } from './weekly-reward';

const LEGACY_REWARD_TYPE: FreeGenerationType = FreeGenerationType.THEAIMODELAB_FAST;

export interface WeeklyClaimStatus {
  canClaim: boolean;
  alreadyClaimedThisWeek: boolean;
  isPaying: boolean;
  amount: number;
  /** 'credits' = créditos de bônus que valem em qualquer modelo; 'free_generations' = bônus antigo (THEAIMODELAB_FAST) */
  rewardKind: WeeklyRewardKind;
  weekKey: string;
  isWindowOpen: boolean;
  windowOpensAt: string;
  windowClosesAt: string;
  nextWindowOpensAt: string;
}

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Lida a cada chamada: trocar `WEEKLY_CLAIM_CREDITS` vale no próximo reinício, sem deploy de código. */
  private reward(): WeeklyReward {
    return resolveWeeklyReward(this.config.get<string>('WEEKLY_CLAIM_CREDITS'));
  }

  async getWeeklyClaimStatus(userId: string): Promise<WeeklyClaimStatus> {
    const now = new Date();
    const weekKey = currentWeekWednesdayKey(now);
    const windowOpen = isWednesdayInBrt(now);
    const reward = this.reward();

    const [isPaying, existing] = await Promise.all([
      this.userIsPaying(userId),
      this.prisma.weeklyClaim.findUnique({
        where: { userId_weekKey: { userId, weekKey } },
      }),
    ]);

    const alreadyClaimed = !!existing;
    const canClaim = isPaying && windowOpen && !alreadyClaimed;

    return {
      canClaim,
      alreadyClaimedThisWeek: alreadyClaimed,
      isPaying,
      amount: reward.amount,
      rewardKind: reward.kind,
      weekKey,
      isWindowOpen: windowOpen,
      windowOpensAt: currentWindowOpensAt(now).toISOString(),
      windowClosesAt: currentWindowClosesAt(now).toISOString(),
      nextWindowOpensAt: nextWindowOpensAt(now).toISOString(),
    };
  }

  async claimWeekly(userId: string): Promise<WeeklyClaimStatus> {
    const now = new Date();
    const weekKey = currentWeekWednesdayKey(now);
    const reward = this.reward();

    if (!isWednesdayInBrt(now)) {
      throw new ForbiddenException(
        'O resgate só está disponível nas quartas-feiras (horário de Brasília).',
      );
    }

    const isPaying = await this.userIsPaying(userId);
    if (!isPaying) {
      throw new ForbiddenException(
        'O resgate semanal é exclusivo para assinantes pagantes.',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // a linha da semana entra primeiro: o índice único (usuário, semana) barra o 2º resgate antes de qualquer crédito
        await tx.weeklyClaim.create({
          data: { userId, weekKey, amount: reward.amount },
        });

        if (reward.kind === 'credits') {
          // crédito de bônus: vale em qualquer modelo na hora e fica no extrato como WEEKLY_BONUS
          await tx.creditBalance.upsert({
            where: { userId },
            create: {
              userId,
              bonusCreditsRemaining: reward.amount,
              planCreditsRemaining: 0,
              planCreditsUsed: 0,
            },
            update: { bonusCreditsRemaining: { increment: reward.amount } },
          });
          await tx.creditTransaction.create({
            data: {
              userId,
              type: CreditTransactionType.WEEKLY_BONUS,
              amount: reward.amount,
              source: 'bonus',
              description: 'Bônus semanal de quarta-feira',
              metadata: { weekKey },
            },
          });
          return;
        }

        // bônus antigo (WEEKLY_CLAIM_CREDITS=0): NÃO acumula, o saldo é fixado na quantidade da semana
        await tx.userFreeGeneration.upsert({
          where: { userId_type: { userId, type: LEGACY_REWARD_TYPE } },
          create: { userId, type: LEGACY_REWARD_TYPE, remaining: reward.amount },
          update: { remaining: reward.amount },
        });
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        throw new ConflictException('Você já resgatou seu bônus desta semana.');
      }
      throw err;
    }

    this.logger.log(
      `[WEEKLY_CLAIM] user=${userId} weekKey=${weekKey} kind=${reward.kind} amount=${reward.amount}`,
    );

    return this.getWeeklyClaimStatus(userId);
  }

  private async userIsPaying(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
      include: { plan: { select: { slug: true } } },
    });

    return !!sub && sub.plan.slug !== 'free';
  }
}
