import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditTransactionType,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitFeedbackDto } from './dto/submit-feedback.dto';

export const FEEDBACK_REWARD_CREDITS = 2500;

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(userId: string, dto: SubmitFeedbackDto) {
    await this.assertActivePaidSubscription(userId);

    const existing = await this.prisma.feedback.findUnique({
      where: { userId },
    });
    if (existing) {
      throw new ConflictException('Você já enviou seu feedback');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.feedback.create({
          data: {
            userId,
            nps: dto.nps,
            rating: dto.rating,
            goal: dto.goal,
            goalOther: dto.goal === 'outro' ? dto.goalOther?.trim() ?? null : null,
            features: dto.features,
            highlight: dto.highlight.trim(),
            improve: dto.improve.trim(),
            wishlist: dto.wishlist.trim(),
            creditsAwarded: FEEDBACK_REWARD_CREDITS,
          },
        });

        const balance = await tx.creditBalance.findUnique({ where: { userId } });
        if (!balance) {
          await tx.creditBalance.create({
            data: {
              userId,
              bonusCreditsRemaining: FEEDBACK_REWARD_CREDITS,
              planCreditsRemaining: 0,
              planCreditsUsed: 0,
            },
          });
        } else {
          await tx.creditBalance.update({
            where: { userId },
            data: {
              bonusCreditsRemaining: { increment: FEEDBACK_REWARD_CREDITS },
            },
          });
        }

        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.FEEDBACK_REWARD,
            amount: FEEDBACK_REWARD_CREDITS,
            source: 'bonus',
            description: 'Recompensa por feedback enviado',
          },
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Você já enviou seu feedback');
      }
      throw err;
    }

    return {
      submitted: true,
      creditsAwarded: FEEDBACK_REWARD_CREDITS,
    };
  }

  async listForAdmin(page: number, limit: number) {
    const skip = (page - 1) * limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              avatarUrl: true,
              subscriptions: {
                where: { status: SubscriptionStatus.ACTIVE },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  status: true,
                  plan: { select: { slug: true, name: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.feedback.count(),
    ]);

    const data = items.map((f) => ({
      id: f.id,
      userId: f.userId,
      user: {
        id: f.user.id,
        email: f.user.email,
        name: f.user.name,
        avatarUrl: f.user.avatarUrl,
        plan: f.user.subscriptions[0]?.plan ?? null,
      },
      nps: f.nps,
      rating: f.rating,
      goal: f.goal,
      goalOther: f.goalOther,
      features: f.features,
      highlight: f.highlight,
      improve: f.improve,
      wishlist: f.wishlist,
      creditsAwarded: f.creditsAwarded,
      createdAt: f.createdAt,
    }));

    const stats = await this.computeStats();

    return {
      data,
      meta: { page, limit, total },
      stats,
    };
  }

  private async computeStats() {
    const total = await this.prisma.feedback.count();
    if (total === 0) {
      return { total: 0, avgNps: null, avgRating: null, npsPromoters: 0, npsDetractors: 0 };
    }
    const agg = await this.prisma.feedback.aggregate({
      _avg: { nps: true, rating: true },
    });
    const promoters = await this.prisma.feedback.count({ where: { nps: { gte: 9 } } });
    const detractors = await this.prisma.feedback.count({ where: { nps: { lte: 6 } } });
    return {
      total,
      avgNps: agg._avg.nps,
      avgRating: agg._avg.rating,
      npsScore: Math.round(((promoters - detractors) / total) * 100),
      npsPromoters: promoters,
      npsDetractors: detractors,
    };
  }

  private async assertActivePaidSubscription(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuário não encontrado');

    const sub = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
      include: { plan: { select: { slug: true } } },
    });

    const isPaid = !!sub && sub.plan.slug !== 'free';
    if (!isPaid) {
      throw new ForbiddenException('Acesso exclusivo para assinantes pagantes');
    }
  }
}
