import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreditTransactionType,
  GenerationStatus,
  Prisma,
  ReferralStatus,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';
import {
  emailFingerprint,
  generateReferralCode,
  hashSignupIp,
  normalizeReferralCode,
  REFERRAL_CODE_LENGTH,
} from './referral-signals';

export const DEFAULT_REFERRAL_REWARD_CREDITS = 200;
export const DEFAULT_MAX_REWARDS_PER_REFERRER = 50;
export const DEFAULT_MAX_REWARDS_PER_DAY = 10;
/** Marcador do motivo quando o admin libera: a concessão seguinte pula as regras de fraude. */
export const APPROVED_BY_ADMIN = 'approved_by_admin';

const SWEEP_BATCH = 200;
const ON_DEMAND_BATCH = 10;
const RECENT_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const IP_SALT_FALLBACK = 'taml-referral-v1';
const CODE_ATTEMPTS = 6;

export type ReferralRewardOutcome =
  | 'rewarded'
  | 'disabled'
  | 'not_pending'
  | 'not_eligible'
  | 'deferred'
  | 'review'
  | 'blocked'
  | 'error';

/** Etapa que o indicador vê. Nunca o motivo de fraude. */
export type ReferralStage = 'waiting_first_creation' | 'in_review' | 'rewarded' | 'not_eligible';

export interface ReferralSummary {
  enabled: boolean;
  code: string;
  rewardCredits: number;
  totals: { invited: number; rewarded: number; pending: number; creditsEarned: number };
  recent: Array<{ id: string; name: string; stage: ReferralStage; credits: number; createdAt: Date }>;
}

const ELIGIBLE_REFERRED: Prisma.UserWhereInput = {
  isActive: true,
  emailVerified: true,
  generations: { some: { status: GenerationStatus.COMPLETED } },
};

/**
 * Indicação entre usuários: cada conta tem um código; quem entra pelo link vira Referral PENDING
 * e, quando o indicado conclui a 1ª geração com o e-mail verificado, quem indicou ganha créditos
 * bônus (REFERRAL_BONUS). Não mexe no programa de afiliado (comissão em dinheiro, `referredByCode`).
 *
 * Travas: 1 indicação por conta indicada (unique), sem auto-indicação nem alias do próprio e-mail,
 * e-mail repetido (alias) do mesmo indicador bloqueia, IP de cadastro repetido vai para revisão,
 * teto total vai para revisão e teto diário espera o dia seguinte. Nada aqui quebra o cadastro,
 * a verificação de e-mail ou a geração: os ganchos só registram erro.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  // ─── configuração ──────────────────────────────────────────────────────────

  /** Créditos por indicação: app_settings manda; sem linha, env; sem env, 200. 0 = desligado. */
  async getRewardAmount(): Promise<number> {
    const fromDb = await this.settings.getInt(SETTING_KEYS.referralRewardCredits, -1);
    if (fromDb === null) return 0;
    if (fromDb >= 0) return fromDb;
    const raw = this.configService.get<string>('REFERRAL_REWARD_CREDITS');
    if (raw == null || raw === '') return DEFAULT_REFERRAL_REWARD_CREDITS;
    const parsed = Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private async getCap(key: string, envName: string, fallback: number): Promise<number> {
    const fromDb = await this.settings.getInt(key, -1);
    if (fromDb !== null && fromDb >= 1) return fromDb;
    const parsed = Number.parseInt(String(this.configService.get<string>(envName) ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
  }

  private ipSalt(): string {
    return this.configService.get<string>('REFERRAL_IP_SALT') || IP_SALT_FALLBACK;
  }

  // ─── código do usuário ─────────────────────────────────────────────────────

  /** Devolve o código do usuário, criando na 1ª vez. Nunca reaproveita um código de afiliado. */
  async getOrCreateCode(userId: string): Promise<string> {
    const existing = await this.prisma.referralCode.findUnique({
      where: { userId },
      select: { code: true },
    });
    if (existing) return existing.code;

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = generateReferralCode(randomBytes(REFERRAL_CODE_LENGTH));
      const clashesWithAffiliate = await this.prisma.affiliate.findUnique({
        where: { code },
        select: { id: true },
      });
      if (clashesWithAffiliate) continue;
      try {
        const created = await this.prisma.referralCode.create({
          data: { userId, code },
          select: { code: true },
        });
        return created.code;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Outra chamada criou o código deste usuário ao mesmo tempo: usa o dela.
        const raced = await this.prisma.referralCode.findUnique({
          where: { userId },
          select: { code: true },
        });
        if (raced) return raced.code;
        // Senão foi colisão de código com outro usuário: tenta outro.
      }
    }
    throw new Error(`Não consegui gerar um código de indicação único para userId=${userId}`);
  }

  // ─── cadastro ──────────────────────────────────────────────────────────────

  /**
   * Liga a conta nova a quem indicou. Chamado só quando o código NÃO é de afiliado ativo.
   * Nunca lança: falha aqui não pode derrubar o cadastro.
   */
  async attachOnSignup(input: {
    referredUserId: string;
    referredEmail: string;
    rawCode?: string | null;
    ipAddress?: string | null;
  }): Promise<void> {
    try {
      const code = normalizeReferralCode(input.rawCode);
      if (!code) return;

      const owner = await this.prisma.referralCode.findUnique({
        where: { code },
        select: { userId: true, user: { select: { email: true } } },
      });
      if (!owner || owner.userId === input.referredUserId) return;

      const fingerprint = emailFingerprint(input.referredEmail);
      const selfAlias = fingerprint !== null && fingerprint === emailFingerprint(owner.user.email);

      await this.prisma.referral.create({
        data: {
          referrerId: owner.userId,
          referredUserId: input.referredUserId,
          code,
          status: selfAlias ? ReferralStatus.BLOCKED : ReferralStatus.PENDING,
          reason: selfAlias ? 'self_alias' : null,
          signupIpHash: hashSignupIp(input.ipAddress, this.ipSalt()),
          emailFingerprint: fingerprint,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return; // a conta já tinha indicação
      this.logger.error(
        `attachOnSignup falhou para referredUserId=${input.referredUserId}: ${messageOf(error)}`,
      );
    }
  }

  // ─── concessão ─────────────────────────────────────────────────────────────

  /**
   * Tenta pagar a indicação desta conta indicada. Idempotente e seguro sob concorrência:
   * só uma chamada consegue virar PENDING → REWARDED, e o crédito entra na mesma transação.
   * Nunca lança.
   */
  async tryReward(referredUserId: string): Promise<ReferralRewardOutcome> {
    try {
      const amount = await this.getRewardAmount();
      if (amount <= 0) return 'disabled';

      const referral = await this.prisma.referral.findUnique({
        where: { referredUserId },
        select: {
          id: true,
          referrerId: true,
          status: true,
          reason: true,
          signupIpHash: true,
          emailFingerprint: true,
          createdAt: true,
        },
      });
      if (!referral || referral.status !== ReferralStatus.PENDING) return 'not_pending';

      // A conta indicada precisa existir de verdade: ativa, e-mail confirmado e 1 geração concluída.
      const eligible = await this.prisma.user.findFirst({
        where: { id: referredUserId, ...ELIGIBLE_REFERRED },
        select: { id: true },
      });
      if (!eligible) return 'not_eligible';

      // Indicador desativado não recebe; a indicação continua pendente se ele for reativado.
      const referrer = await this.prisma.user.findUnique({
        where: { id: referral.referrerId },
        select: { isActive: true },
      });
      if (!referrer?.isActive) return 'not_eligible';

      if (referral.reason !== APPROVED_BY_ADMIN) {
        const verdict = await this.fraudVerdict(referral);
        if (verdict) {
          if (verdict.status === 'defer') {
            // Mexe no updatedAt para a varredura passar às pendentes de trás.
            await this.prisma.referral.updateMany({
              where: { id: referral.id, status: ReferralStatus.PENDING },
              data: { reason: verdict.reason },
            });
            return 'deferred';
          }
          await this.prisma.referral.updateMany({
            where: { id: referral.id, status: ReferralStatus.PENDING },
            data: { status: verdict.status, reason: verdict.reason },
          });
          return verdict.status === ReferralStatus.REVIEW ? 'review' : 'blocked';
        }
      }

      const rewarded = await this.prisma.$transaction(async (tx) => {
        const flipped = await tx.referral.updateMany({
          where: { id: referral.id, status: ReferralStatus.PENDING },
          data: {
            status: ReferralStatus.REWARDED,
            rewardedAt: new Date(),
            creditsAwarded: amount,
          },
        });
        if (flipped.count !== 1) return false;

        await tx.creditBalance.upsert({
          where: { userId: referral.referrerId },
          create: { userId: referral.referrerId, bonusCreditsRemaining: amount },
          update: { bonusCreditsRemaining: { increment: amount } },
        });
        await tx.creditTransaction.create({
          data: {
            userId: referral.referrerId,
            type: CreditTransactionType.REFERRAL_BONUS,
            amount,
            source: 'bonus',
            description: `referral:${referral.id}`,
          },
        });
        return true;
      });

      if (!rewarded) return 'not_pending';
      this.logger.log(
        `Indicação paga: referralId=${referral.id} referrerId=${referral.referrerId} amount=${amount}`,
      );
      return 'rewarded';
    } catch (error) {
      this.logger.error(`tryReward falhou para referredUserId=${referredUserId}: ${messageOf(error)}`);
      return 'error';
    }
  }

  /**
   * Regras anti-fraude, na ordem: alias do mesmo indicador (bloqueia), IP de cadastro repetido
   * (revisão), teto total (revisão), teto diário (espera). A 1ª conta de um e-mail ou IP passa;
   * só as seguintes caem na regra. Os tetos são flexíveis: duas concessões simultâneas do mesmo
   * indicador podem passar 1 do teto, o que é aceitável para um limite anti-farm.
   */
  private async fraudVerdict(referral: {
    id: string;
    referrerId: string;
    signupIpHash: string | null;
    emailFingerprint: string | null;
    createdAt: Date;
  }): Promise<{ status: ReferralStatus | 'defer'; reason: string } | null> {
    const earlierOfSameReferrer = {
      referrerId: referral.referrerId,
      id: { not: referral.id },
      createdAt: { lt: referral.createdAt },
    };

    if (referral.emailFingerprint) {
      const sameMailbox = await this.prisma.referral.count({
        where: { ...earlierOfSameReferrer, emailFingerprint: referral.emailFingerprint },
      });
      if (sameMailbox > 0) return { status: ReferralStatus.BLOCKED, reason: 'duplicate_email' };
    }

    if (referral.signupIpHash) {
      const sameIp = await this.prisma.referral.count({
        where: { ...earlierOfSameReferrer, signupIpHash: referral.signupIpHash },
      });
      if (sameIp > 0) return { status: ReferralStatus.REVIEW, reason: 'shared_ip' };
    }

    const [maxTotal, maxPerDay] = await Promise.all([
      this.getCap(
        SETTING_KEYS.referralMaxRewardsPerReferrer,
        'REFERRAL_MAX_REWARDS_PER_REFERRER',
        DEFAULT_MAX_REWARDS_PER_REFERRER,
      ),
      this.getCap(
        SETTING_KEYS.referralMaxRewardsPerDay,
        'REFERRAL_MAX_REWARDS_PER_DAY',
        DEFAULT_MAX_REWARDS_PER_DAY,
      ),
    ]);

    const rewardedTotal = await this.prisma.referral.count({
      where: { referrerId: referral.referrerId, status: ReferralStatus.REWARDED },
    });
    if (rewardedTotal >= maxTotal) return { status: ReferralStatus.REVIEW, reason: 'cap_total' };

    const rewardedToday = await this.prisma.referral.count({
      where: {
        referrerId: referral.referrerId,
        status: ReferralStatus.REWARDED,
        rewardedAt: { gte: new Date(Date.now() - DAY_MS) },
      },
    });
    if (rewardedToday >= maxPerDay) return { status: 'defer', reason: 'cap_daily' };

    return null;
  }

  /** Varredura do cron: paga as pendentes cujo indicado já cumpriu as condições. */
  async sweepPending(): Promise<Record<ReferralRewardOutcome, number>> {
    const counts = emptyOutcomeCounts();
    if ((await this.getRewardAmount()) <= 0) return counts;

    const candidates = await this.prisma.referral.findMany({
      where: { status: ReferralStatus.PENDING, referredUser: ELIGIBLE_REFERRED },
      select: { referredUserId: true },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_BATCH,
    });
    for (const candidate of candidates) {
      counts[await this.tryReward(candidate.referredUserId)] += 1;
    }
    return counts;
  }

  // ─── painel do usuário ─────────────────────────────────────────────────────

  async getSummary(userId: string): Promise<ReferralSummary> {
    const [code, rewardCredits] = await Promise.all([
      this.getOrCreateCode(userId),
      this.getRewardAmount(),
    ]);

    // Quem abre o painel não espera o cron: as pendentes já elegíveis são pagas agora.
    if (rewardCredits > 0) {
      const ready = await this.prisma.referral.findMany({
        where: {
          referrerId: userId,
          status: ReferralStatus.PENDING,
          referredUser: ELIGIBLE_REFERRED,
        },
        select: { referredUserId: true },
        orderBy: { updatedAt: 'asc' },
        take: ON_DEMAND_BATCH,
      });
      for (const item of ready) await this.tryReward(item.referredUserId);
    }

    const [byStatus, earned, recent] = await Promise.all([
      this.prisma.referral.groupBy({
        by: ['status'],
        where: { referrerId: userId },
        _count: { _all: true },
      }),
      this.prisma.referral.aggregate({
        where: { referrerId: userId, status: ReferralStatus.REWARDED },
        _sum: { creditsAwarded: true },
      }),
      this.prisma.referral.findMany({
        where: { referrerId: userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_LIMIT,
        select: {
          id: true,
          status: true,
          creditsAwarded: true,
          createdAt: true,
          referredUser: { select: { name: true } },
        },
      }),
    ]);

    const countOf = (status: ReferralStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    return {
      enabled: rewardCredits > 0,
      code,
      rewardCredits,
      totals: {
        invited: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        rewarded: countOf(ReferralStatus.REWARDED),
        pending: countOf(ReferralStatus.PENDING) + countOf(ReferralStatus.REVIEW),
        creditsEarned: earned._sum.creditsAwarded ?? 0,
      },
      recent: recent.map((row) => ({
        id: row.id,
        name: firstName(row.referredUser?.name),
        stage: stageOf(row.status),
        credits: row.creditsAwarded,
        createdAt: row.createdAt,
      })),
    };
  }

  // ─── admin ─────────────────────────────────────────────────────────────────

  async listForAdmin(status: ReferralStatus | undefined, take: number) {
    return this.prisma.referral.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        status: true,
        reason: true,
        code: true,
        creditsAwarded: true,
        createdAt: true,
        rewardedAt: true,
        reviewedAt: true,
        reviewedById: true,
        referrer: { select: { id: true, name: true, email: true } },
        referredUser: {
          select: { id: true, name: true, email: true, emailVerified: true, isActive: true },
        },
      },
    });
  }

  async adminStats() {
    const [byStatus, earned, rewardCredits] = await Promise.all([
      this.prisma.referral.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.referral.aggregate({
        where: { status: ReferralStatus.REWARDED },
        _sum: { creditsAwarded: true },
      }),
      this.getRewardAmount(),
    ]);
    return {
      rewardCredits,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      creditsAwarded: earned._sum.creditsAwarded ?? 0,
    };
  }

  /**
   * Libera uma indicação em revisão ou bloqueada. Volta para PENDING marcada como liberada pelo
   * admin (pula as regras de fraude) e já tenta pagar; se o indicado ainda não cumpriu as
   * condições, paga quando cumprir.
   */
  async approve(referralId: string, adminId: string) {
    const referral = await this.findOrFail(referralId);
    const updated = await this.prisma.referral.updateMany({
      where: {
        id: referralId,
        status: { in: [ReferralStatus.REVIEW, ReferralStatus.BLOCKED] },
      },
      data: {
        status: ReferralStatus.PENDING,
        reason: APPROVED_BY_ADMIN,
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException('Só dá para liberar indicação em revisão ou bloqueada');
    }
    const outcome = await this.tryReward(referral.referredUserId);
    return { id: referralId, outcome };
  }

  /** Recusa uma indicação pendente ou em revisão. Crédito já pago não é estornado aqui. */
  async reject(referralId: string, adminId: string) {
    await this.findOrFail(referralId);
    const updated = await this.prisma.referral.updateMany({
      where: {
        id: referralId,
        status: { in: [ReferralStatus.PENDING, ReferralStatus.REVIEW] },
      },
      data: {
        status: ReferralStatus.BLOCKED,
        reason: 'rejected_by_admin',
        reviewedById: adminId,
        reviewedAt: new Date(),
      },
    });
    if (updated.count !== 1) {
      throw new BadRequestException('Só dá para recusar indicação pendente ou em revisão');
    }
    return { id: referralId, status: ReferralStatus.BLOCKED };
  }

  private async findOrFail(referralId: string) {
    const referral = await this.prisma.referral.findUnique({
      where: { id: referralId },
      select: { id: true, referredUserId: true },
    });
    if (!referral) throw new NotFoundException('Indicação não encontrada');
    return referral;
  }
}

function stageOf(status: ReferralStatus): ReferralStage {
  switch (status) {
    case ReferralStatus.REWARDED:
      return 'rewarded';
    case ReferralStatus.REVIEW:
      return 'in_review';
    case ReferralStatus.BLOCKED:
      return 'not_eligible';
    default:
      return 'waiting_first_creation';
  }
}

/** Só o primeiro nome do indicado (o indicador já conhece a pessoa; e-mail nunca sai). */
function firstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first.slice(0, 24);
}

function emptyOutcomeCounts(): Record<ReferralRewardOutcome, number> {
  return {
    rewarded: 0,
    disabled: 0,
    not_pending: 0,
    not_eligible: 0,
    deferred: 0,
    review: 0,
    blocked: 0,
    error: 0,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
