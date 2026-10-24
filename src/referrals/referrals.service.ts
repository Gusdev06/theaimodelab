import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreditTransactionType,
  GenerationStatus,
  Prisma,
  ReferralStatus,
} from '@prisma/client';
import { createHmac, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';
import {
  displayFirstName,
  emailDomainKey,
  emailFingerprint,
  generateReferralCode,
  hashSignupIp,
  isDisposableEmail,
  normalizeReferralCode,
  parseStrictInt,
  REFERRAL_CODE_LENGTH,
} from './referral-signals';

export const DEFAULT_REFERRAL_REWARD_CREDITS = 200;
/** Valor acima disso é erro de digitação: desliga em vez de pagar 10x. */
export const MAX_REFERRAL_REWARD_CREDITS = 5000;
export const DEFAULT_MAX_REWARDS_PER_REFERRER = 50;
export const DEFAULT_MAX_REWARDS_PER_DAY = 10;
export const DEFAULT_MAX_REWARDS_GLOBAL_PER_DAY = 200;
/** Contas do mesmo domínio próprio que passam por indicador; a partir da seguinte, revisão. */
export const SAME_DOMAIN_ALLOWED = 2;
/** Marcador do motivo quando o admin libera: a concessão seguinte pula as regras de fraude e os tetos. */
export const APPROVED_BY_ADMIN = 'approved_by_admin';

const SWEEP_BATCH = 200;
const ON_DEMAND_BATCH = 5;
const RECENT_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_REVIEW_MS = 2 * DAY_MS;
const CODE_ATTEMPTS = 6;
/** Valor de reserva do JWT no auth.module: não serve de segredo. */
const INSECURE_JWT_SECRET = 'default-secret-key';

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
export type ReferralStage =
  | 'waiting_first_creation'
  | 'waiting_email'
  | 'scheduled'
  | 'in_review'
  | 'rewarded'
  | 'not_eligible';

export interface ReferralSummary {
  enabled: boolean;
  code: string;
  rewardCredits: number;
  /** Quem indica também precisa do e-mail confirmado para receber. */
  needsEmailVerification: boolean;
  totals: { invited: number; rewarded: number; pending: number; creditsEarned: number };
  recent: Array<{ id: string; name: string; stage: ReferralStage; credits: number; createdAt: string }>;
}

export interface ReferralSettings {
  rewardCredits: number;
  maxRewardsPerReferrer: number;
  maxRewardsPerDay: number;
  maxRewardsGlobalPerDay: number;
  /** false = sem REFERRAL_IP_SALT nem JWT_ACCESS_SECRET próprio: a regra de IP não age. */
  ipRuleActive: boolean;
}

type Limits = Pick<ReferralSettings, 'maxRewardsPerReferrer' | 'maxRewardsPerDay' | 'maxRewardsGlobalPerDay'>;

type PendingReferral = {
  id: string;
  referrerId: string;
  reason: string | null;
  signupIpHash: string | null;
  emailFingerprint: string | null;
  emailDomainKey: string | null;
  createdAt: Date;
};

const ELIGIBLE_REFERRED: Prisma.UserWhereInput = {
  isActive: true,
  emailVerified: true,
  generations: { some: { status: GenerationStatus.COMPLETED } },
};
const ELIGIBLE_REFERRER: Prisma.UserWhereInput = { isActive: true, emailVerified: true };

/** Interrompe a transação do pagamento (rollback) com o destino da indicação. */
class RewardStop extends Error {
  constructor(
    readonly outcome: ReferralRewardOutcome,
    readonly status: ReferralStatus | null,
    readonly reason: string | null,
  ) {
    super(outcome);
  }
}

/**
 * Indicação entre usuários: cada conta tem um código; quem entra pelo link vira Referral PENDING e, quando o
 * indicado conclui a 1ª geração com o e-mail verificado, quem indicou (também com e-mail verificado) ganha
 * créditos bônus (REFERRAL_BONUS). Não mexe no programa de afiliado (comissão em dinheiro, `referredByCode`).
 *
 * Travas:
 * - 1 indicação por conta indicada (unique); sem auto-indicação, alias do próprio e-mail ou caixa temporária;
 * - alias repetido do mesmo indicador bloqueia; IP de cadastro ou domínio próprio repetido vai para revisão;
 * - teto total por indicador (revisão), teto por dia (espera o dia seguinte) e teto global por dia (revisão),
 *   contados dentro da transação com a linha do código do indicador travada: rajada paralela não passa do teto;
 * - indicação desligada (valor 0) não atribui ninguém, para não acumular pagamento para quando religar.
 * Nada aqui quebra o cadastro, a verificação de e-mail ou a geração: os ganchos só registram erro.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  // ─── configuração ──────────────────────────────────────────────────────────

  /** Erro de configuração aparece uma vez por processo, não a cada cadastro. */
  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.error(message);
  }

  /**
   * Créditos por indicação. app_settings manda; sem linha, env; sem env, 200. Linha ou env inválidos (negativo,
   * texto, acima de 5.000) DESLIGAM: configuração errada nunca liga a indicação com valor errado.
   */
  async getRewardAmount(): Promise<number> {
    const fromDb = await this.settings.getRaw(SETTING_KEYS.referralRewardCredits);
    const env = this.configService.get<string>('REFERRAL_REWARD_CREDITS');
    const raw = fromDb !== undefined ? fromDb : env;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return fromDb !== undefined ? this.invalidAmount(raw) : DEFAULT_REFERRAL_REWARD_CREDITS;
    }
    const value = parseStrictInt(raw);
    if (value === null) return this.invalidAmount(raw);
    if (value > MAX_REFERRAL_REWARD_CREDITS) {
      this.warnOnce(
        'reward-too-high',
        `referral_reward_credits=${value} passa de ${MAX_REFERRAL_REWARD_CREDITS}: indicação desligada até corrigir`,
      );
      return 0;
    }
    return value;
  }

  private invalidAmount(raw: unknown): number {
    this.warnOnce('reward-invalid', `referral_reward_credits inválido (${JSON.stringify(raw)}): indicação desligada`);
    return 0;
  }

  /** Teto inteiro; inválido cai no padrão com aviso. `allowZero` = 0 é válido (teto total 0 = tudo para revisão). */
  private async getLimit(key: string, envName: string, fallback: number, allowZero: boolean): Promise<number> {
    const fromDb = await this.settings.getRaw(key);
    const raw = fromDb !== undefined ? fromDb : this.configService.get<string>(envName);
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = parseStrictInt(raw);
    if (value === null || (!allowZero && value === 0)) {
      this.warnOnce(`limit-${key}`, `${key} inválido (${JSON.stringify(raw)}): usando ${fallback}`);
      return fallback;
    }
    return value;
  }

  private async getLimits(): Promise<Limits> {
    const [maxRewardsPerReferrer, maxRewardsPerDay, maxRewardsGlobalPerDay] = await Promise.all([
      this.getLimit(
        SETTING_KEYS.referralMaxRewardsPerReferrer,
        'REFERRAL_MAX_REWARDS_PER_REFERRER',
        DEFAULT_MAX_REWARDS_PER_REFERRER,
        true,
      ),
      this.getLimit(
        SETTING_KEYS.referralMaxRewardsPerDay,
        'REFERRAL_MAX_REWARDS_PER_DAY',
        DEFAULT_MAX_REWARDS_PER_DAY,
        false,
      ),
      this.getLimit(
        SETTING_KEYS.referralMaxRewardsGlobalPerDay,
        'REFERRAL_MAX_REWARDS_GLOBAL_PER_DAY',
        DEFAULT_MAX_REWARDS_GLOBAL_PER_DAY,
        false,
      ),
    ]);
    return { maxRewardsPerReferrer, maxRewardsPerDay, maxRewardsGlobalPerDay };
  }

  /**
   * Sal do HMAC do IP: REFERRAL_IP_SALT; sem ele, derivado do JWT_ACCESS_SECRET (segredo que já existe no
   * servidor). Sem nenhum dos dois, null e o IP não é guardado: um sal fixo no código (repo público) deixaria o
   * hash reversível por força bruta.
   */
  private ipSalt(): string | null {
    const explicit = this.configService.get<string>('REFERRAL_IP_SALT');
    if (explicit) return explicit;
    const jwtSecret = this.configService.get<string>('JWT_ACCESS_SECRET');
    if (jwtSecret && jwtSecret !== INSECURE_JWT_SECRET) {
      return createHmac('sha256', jwtSecret).update('referral-ip-salt-v1').digest('hex');
    }
    this.warnOnce('ip-salt', 'Sem REFERRAL_IP_SALT nem JWT_ACCESS_SECRET: a regra de IP da indicação está desligada');
    return null;
  }

  async getSettings(): Promise<ReferralSettings> {
    const [rewardCredits, limits] = await Promise.all([this.getRewardAmount(), this.getLimits()]);
    return { rewardCredits, ...limits, ipRuleActive: this.ipSalt() !== null };
  }

  /** Admin muda valor e tetos sem deploy nem SQL. */
  async updateSettings(input: Partial<Omit<ReferralSettings, 'ipRuleActive'>>): Promise<ReferralSettings> {
    const writes: Array<[string, number | undefined]> = [
      [SETTING_KEYS.referralRewardCredits, input.rewardCredits],
      [SETTING_KEYS.referralMaxRewardsPerReferrer, input.maxRewardsPerReferrer],
      [SETTING_KEYS.referralMaxRewardsPerDay, input.maxRewardsPerDay],
      [SETTING_KEYS.referralMaxRewardsGlobalPerDay, input.maxRewardsGlobalPerDay],
    ];
    for (const [key, value] of writes) {
      if (value !== undefined) await this.settings.setInt(key, value);
    }
    this.warned.clear();
    return this.getSettings();
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
    let code: string | null = null;
    let referrerId: string | null = null;
    try {
      code = normalizeReferralCode(input.rawCode);
      if (!code) return;
      // Desligada: o link não atribui ninguém, senão religar pagaria de uma vez tudo o que acumulou.
      if ((await this.getRewardAmount()) <= 0) return;

      const owner = await this.prisma.referralCode.findUnique({
        where: { code },
        select: { userId: true, user: { select: { email: true, isActive: true } } },
      });
      // Link de conta desativada (banida ou excluída) não atribui ninguém.
      if (!owner || owner.userId === input.referredUserId || !owner.user.isActive) return;
      referrerId = owner.userId;

      const fingerprint = emailFingerprint(input.referredEmail);
      const blockReason =
        fingerprint !== null && fingerprint === emailFingerprint(owner.user.email)
          ? 'self_alias'
          : isDisposableEmail(input.referredEmail)
            ? 'disposable_email'
            : null;
      const salt = this.ipSalt();

      await this.prisma.referral.create({
        data: {
          referrerId: owner.userId,
          referredUserId: input.referredUserId,
          code,
          status: blockReason ? ReferralStatus.BLOCKED : ReferralStatus.PENDING,
          reason: blockReason,
          signupIpHash: salt ? hashSignupIp(input.ipAddress, salt) : null,
          emailFingerprint: fingerprint,
          emailDomainKey: emailDomainKey(input.referredEmail),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return; // a conta já tinha indicação
      this.logger.error(
        `attachOnSignup falhou: referredUserId=${input.referredUserId} code=${code ?? '-'} ` +
          `referrerId=${referrerId ?? '-'}: ${messageOf(error)}`,
      );
    }
  }

  // ─── concessão ─────────────────────────────────────────────────────────────

  /**
   * Tenta pagar a indicação desta conta indicada. Idempotente e seguro sob concorrência: o pagamento trava a
   * linha do código do indicador, confere os tetos e vira PENDING → REWARDED numa transação só. Nunca lança.
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
          emailDomainKey: true,
          createdAt: true,
        },
      });
      if (!referral || referral.status !== ReferralStatus.PENDING) return 'not_pending';

      // A conta indicada precisa existir de verdade: ativa, e-mail confirmado e 1 geração concluída.
      const referred = await this.prisma.user.findFirst({
        where: { id: referredUserId, ...ELIGIBLE_REFERRED },
        select: { id: true },
      });
      if (!referred) return 'not_eligible';

      // Quem indica também precisa estar ativo e com e-mail confirmado; senão a indicação espera.
      const referrer = await this.prisma.user.findFirst({
        where: { id: referral.referrerId, ...ELIGIBLE_REFERRER },
        select: { id: true },
      });
      if (!referrer) return 'not_eligible';

      const approvedByAdmin = referral.reason === APPROVED_BY_ADMIN;
      if (!approvedByAdmin) {
        const verdict = await this.signalVerdict(referral);
        if (verdict) return this.settle(referral, verdict);
      }

      const limits = await this.getLimits();
      try {
        await this.prisma.$transaction(async (tx) => {
          // O UPDATE trava a linha do código do indicador até o fim da transação: outra concessão do mesmo
          // indicador espera aqui, e as contagens abaixo já enxergam o que ela pagou.
          const slot = await tx.referralCode.updateMany({
            where: {
              userId: referral.referrerId,
              ...(approvedByAdmin ? {} : { rewardedCount: { lt: limits.maxRewardsPerReferrer } }),
            },
            data: { rewardedCount: { increment: 1 } },
          });
          if (slot.count !== 1) {
            if (approvedByAdmin) throw new Error('código de indicação do indicador não encontrado');
            throw new RewardStop('review', ReferralStatus.REVIEW, 'cap_total');
          }

          if (!approvedByAdmin) {
            const since = new Date(Date.now() - DAY_MS);
            const today = await tx.referral.count({
              where: { referrerId: referral.referrerId, status: ReferralStatus.REWARDED, rewardedAt: { gte: since } },
            });
            if (today >= limits.maxRewardsPerDay) throw new RewardStop('deferred', null, 'cap_daily');
            const global = await tx.referral.count({
              where: { status: ReferralStatus.REWARDED, rewardedAt: { gte: since } },
            });
            if (global >= limits.maxRewardsGlobalPerDay) {
              throw new RewardStop('review', ReferralStatus.REVIEW, 'cap_global');
            }
          }

          const flipped = await tx.referral.updateMany({
            where: { id: referral.id, status: ReferralStatus.PENDING, reason: referral.reason },
            data: {
              status: ReferralStatus.REWARDED,
              rewardedAt: new Date(),
              creditsAwarded: amount,
              reason: approvedByAdmin ? APPROVED_BY_ADMIN : null,
            },
          });
          if (flipped.count !== 1) throw new RewardStop('not_pending', null, null);

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
        });
      } catch (error) {
        if (error instanceof RewardStop) return this.settle(referral, error);
        throw error;
      }

      this.logger.log(
        `Indicação paga: referralId=${referral.id} referrerId=${referral.referrerId} amount=${amount}`,
      );
      return 'rewarded';
    } catch (error) {
      this.logger.error(`tryReward falhou para referredUserId=${referredUserId}: ${messageOf(error)}`);
      // Joga a linha para o fim da fila: um erro que se repete não trava a varredura das outras.
      await this.prisma.referral
        .updateMany({
          where: { referredUserId, status: ReferralStatus.PENDING },
          data: { updatedAt: new Date() },
        })
        .catch(() => undefined);
      return 'error';
    }
  }

  /**
   * Grava o destino da indicação só se ninguém mexeu nela desde a leitura (mesmo status e motivo): uma decisão
   * velha nunca apaga a liberação do admin. Sem status novo = adiada (só o motivo muda, e ela vai para o fim
   * da fila da varredura).
   */
  private async settle(
    referral: PendingReferral,
    stop: { outcome?: ReferralRewardOutcome; status: ReferralStatus | null; reason: string | null },
  ): Promise<ReferralRewardOutcome> {
    if (stop.outcome === 'not_pending') return 'not_pending';
    await this.prisma.referral.updateMany({
      where: { id: referral.id, status: ReferralStatus.PENDING, reason: referral.reason },
      data: stop.status ? { status: stop.status, reason: stop.reason } : { reason: stop.reason },
    });
    if (!stop.status) return 'deferred';
    return stop.status === ReferralStatus.REVIEW ? 'review' : 'blocked';
  }

  /**
   * Sinais da conta indicada contra as indicações ANTERIORES do mesmo indicador: a 1ª conta de um e-mail, IP ou
   * domínio passa; só as seguintes caem na regra. Lê só linhas que já existem desde o cadastro, então rajada
   * paralela não escapa.
   */
  private async signalVerdict(
    referral: PendingReferral,
  ): Promise<{ status: ReferralStatus; reason: string } | null> {
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

    if (referral.emailDomainKey) {
      const sameDomain = await this.prisma.referral.count({
        where: { ...earlierOfSameReferrer, emailDomainKey: referral.emailDomainKey },
      });
      if (sameDomain >= SAME_DOMAIN_ALLOWED) return { status: ReferralStatus.REVIEW, reason: 'shared_domain' };
    }

    return null;
  }

  /**
   * Varredura do cron: paga as pendentes cujo indicado e indicador já cumpriram as condições. Lote inteiro com
   * erro e nenhum pagamento lança, para o cron_executions mostrar ERROR em vez de SUCCESS.
   */
  async sweepPending(): Promise<Record<ReferralRewardOutcome | 'staleReview', number>> {
    const counts = emptyOutcomeCounts();
    if ((await this.getRewardAmount()) <= 0) return { ...counts, staleReview: 0 };

    const candidates = await this.prisma.referral.findMany({
      where: {
        status: ReferralStatus.PENDING,
        referredUser: ELIGIBLE_REFERRED,
        referrer: ELIGIBLE_REFERRER,
      },
      select: { referredUserId: true },
      orderBy: { updatedAt: 'asc' },
      take: SWEEP_BATCH,
    });
    for (const candidate of candidates) {
      counts[await this.tryReward(candidate.referredUserId)] += 1;
    }

    const staleReview = await this.prisma.referral.count({
      where: { status: ReferralStatus.REVIEW, updatedAt: { lt: new Date(Date.now() - STALE_REVIEW_MS) } },
    });
    if (staleReview > 0) {
      this.logger.warn(`${staleReview} indicação(ões) em revisão há mais de 48 h: GET /api/v1/admin/referrals?status=REVIEW`);
    }
    if (counts.error > 0) {
      this.logger.warn(`Varredura de indicações: ${JSON.stringify(counts)}`);
      if (counts.rewarded === 0) {
        throw new Error(`Varredura de indicações: ${counts.error} erro(s) e nenhum pagamento no lote`);
      }
    }
    return { ...counts, staleReview };
  }

  // ─── painel do usuário ─────────────────────────────────────────────────────

  async getSummary(userId: string): Promise<ReferralSummary> {
    const [code, rewardCredits, me] = await Promise.all([
      this.getOrCreateCode(userId),
      this.getRewardAmount(),
      this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerified: true } }),
    ]);

    // Quem abre o painel não espera o cron: as pendentes já elegíveis são pagas agora.
    if (rewardCredits > 0 && me?.emailVerified) {
      const ready = await this.prisma.referral.findMany({
        where: { referrerId: userId, status: ReferralStatus.PENDING, referredUser: ELIGIBLE_REFERRED },
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
          reason: true,
          creditsAwarded: true,
          createdAt: true,
          referredUser: {
            select: {
              name: true,
              emailVerified: true,
              generations: {
                where: { status: GenerationStatus.COMPLETED },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      }),
    ]);

    const countOf = (status: ReferralStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;

    return {
      enabled: rewardCredits > 0,
      code,
      rewardCredits,
      needsEmailVerification: !me?.emailVerified,
      totals: {
        invited: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        rewarded: countOf(ReferralStatus.REWARDED),
        pending: countOf(ReferralStatus.PENDING) + countOf(ReferralStatus.REVIEW),
        creditsEarned: earned._sum.creditsAwarded ?? 0,
      },
      recent: recent.map((row) => ({
        id: row.id,
        name: displayFirstName(row.referredUser?.name),
        stage: stageOf(row.status, row.reason, {
          created: (row.referredUser?.generations.length ?? 0) > 0,
          emailVerified: !!row.referredUser?.emailVerified,
        }),
        credits: row.creditsAwarded,
        // só o dia: o horário exato do cadastro de outra pessoa não precisa sair daqui
        createdAt: row.createdAt.toISOString().slice(0, 10),
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
    const staleBefore = new Date(Date.now() - STALE_REVIEW_MS);
    const [byStatus, earned, staleReview, oldestReview, rewardedToday, settings] = await Promise.all([
      this.prisma.referral.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.referral.aggregate({
        where: { status: ReferralStatus.REWARDED },
        _sum: { creditsAwarded: true },
      }),
      this.prisma.referral.count({ where: { status: ReferralStatus.REVIEW, updatedAt: { lt: staleBefore } } }),
      this.prisma.referral.findFirst({
        where: { status: ReferralStatus.REVIEW },
        orderBy: { updatedAt: 'asc' },
        select: { updatedAt: true },
      }),
      this.prisma.referral.count({
        where: { status: ReferralStatus.REWARDED, rewardedAt: { gte: new Date(Date.now() - DAY_MS) } },
      }),
      this.getSettings(),
    ]);
    return {
      settings,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
      creditsAwarded: earned._sum.creditsAwarded ?? 0,
      rewardedLast24h: rewardedToday,
      review: { staleOver48h: staleReview, oldestAt: oldestReview?.updatedAt ?? null },
    };
  }

  /**
   * Libera uma indicação em revisão ou bloqueada. Volta para PENDING marcada como liberada pelo admin (pula as
   * regras de fraude e os tetos) e já tenta pagar; se o indicado ainda não cumpriu as condições, paga quando cumprir.
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

/** O que quem indicou vê. A etapa diz o que falta, nunca qual regra de fraude pegou. */
export function stageOf(
  status: ReferralStatus,
  reason: string | null,
  referred: { created: boolean; emailVerified: boolean },
): ReferralStage {
  switch (status) {
    case ReferralStatus.REWARDED:
      return 'rewarded';
    case ReferralStatus.REVIEW:
      return 'in_review';
    case ReferralStatus.BLOCKED:
      return 'not_eligible';
    default:
      if (reason === 'cap_daily') return 'scheduled';
      if (referred.created && !referred.emailVerified) return 'waiting_email';
      return 'waiting_first_creation';
  }
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
