import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  CURIOSITY_LOCK_MAX_COMPLETED,
  curiosityAbBucketFor,
  isCuriosityLockEligible,
  parseCuriosityMediaUrls,
  pickCuriosityMedia,
  type CuriosityAbBucket,
} from './curiosity-lock.rules';

export interface CuriosityLockStatus {
  eligible: boolean;
  /** gerações concluídas, contadas até CURIOSITY_LOCK_MAX_COMPLETED + 1 (não é o total da conta) */
  completedGenerations: number;
  /** balde do A/B (medição); a variante servida é sempre a A enquanto a B não existir */
  abBucket: CuriosityAbBucket;
  variant: 'A';
  /** mídia do acervo escolhida pelo dono para esta conta; null = o card usa a cena do Reel ou o próprio resultado */
  mediaUrl: string | null;
}

/**
 * Leitura do paywall de curiosidade (L02). Só leitura, sem efeito colateral: o card só aparece com
 * NEXT_PUBLIC_CURIOSITY_LOCK=on no site, que é quem chama esta rota.
 */
@Injectable()
export class CuriosityLockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async statusFor(userId: string): Promise<CuriosityLockStatus> {
    const [completed, paid, paidSubscription] = await Promise.all([
      this.prisma.generation.findMany({
        where: { userId, status: 'COMPLETED' },
        select: { id: true },
        take: CURIOSITY_LOCK_MAX_COMPLETED + 1,
      }),
      this.prisma.payment.findFirst({ where: { userId, status: 'COMPLETED' }, select: { id: true } }),
      this.prisma.subscription.findFirst({
        where: { userId, status: 'ACTIVE', plan: { priceCents: { gt: 0 } } },
        select: { id: true },
      }),
    ]);

    const eligible = isCuriosityLockEligible({
      completedGenerations: completed.length,
      everPaid: !!paid,
      hasPaidPlan: !!paidSubscription,
    });
    return {
      eligible,
      completedGenerations: completed.length,
      abBucket: curiosityAbBucketFor(userId, this.config.get<string>('CURIOSITY_LOCK_REAL_VIDEO_PCT')),
      variant: 'A',
      mediaUrl: eligible ? pickCuriosityMedia(userId, parseCuriosityMediaUrls(this.config.get<string>('CURIOSITY_LOCK_MEDIA_URLS'))) : null,
    };
  }
}
