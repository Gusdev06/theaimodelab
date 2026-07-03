import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FreeGenerationType, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  currentWeekWednesdayKey,
  currentWindowClosesAt,
  currentWindowOpensAt,
  isWednesdayInBrt,
  nextWindowOpensAt,
} from './week-key.util';

const WEEKLY_CLAIM_AMOUNT = 4;
const REWARD_TYPE: FreeGenerationType = FreeGenerationType.THEAIMODELAB_FAST;

export interface WeeklyClaimStatus {
  canClaim: boolean;
  alreadyClaimedThisWeek: boolean;
  isPaying: boolean;
  amount: number;
  weekKey: string;
  isWindowOpen: boolean;
  windowOpensAt: string;
  windowClosesAt: string;
  nextWindowOpensAt: string;
}

@Injectable()
export class RewardsService {
  private readonly logger = new Logger(RewardsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getWeeklyClaimStatus(userId: string): Promise<WeeklyClaimStatus> {
    const now = new Date();
    const weekKey = currentWeekWednesdayKey(now);
    const windowOpen = isWednesdayInBrt(now);

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
      amount: WEEKLY_CLAIM_AMOUNT,
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
        await tx.weeklyClaim.create({
          data: { userId, weekKey, amount: WEEKLY_CLAIM_AMOUNT },
        });

        // Bônus semanal NÃO acumula: ao resgatar, o saldo é fixado em
        // WEEKLY_CLAIM_AMOUNT, independente de gerações que sobraram.
        await tx.userFreeGeneration.upsert({
          where: { userId_type: { userId, type: REWARD_TYPE } },
          create: { userId, type: REWARD_TYPE, remaining: WEEKLY_CLAIM_AMOUNT },
          update: { remaining: WEEKLY_CLAIM_AMOUNT },
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
      `[WEEKLY_CLAIM] user=${userId} weekKey=${weekKey} amount=${WEEKLY_CLAIM_AMOUNT}`,
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
