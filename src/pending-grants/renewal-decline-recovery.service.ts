import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { CreditTransactionType, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../email/email.service';
import { sitePathFor } from '../email/brand-email';
import { recoveryPlanFromName } from '../email/x1-footer';
import { PREPAID_TO_SUBSCRIPTION_CHECKOUT_CODE, isPrepaidPlanSlug } from '../plans/prepaid-plan';
import { PREPAID_RENEW_BASE_URL, prepaidPlanDisplayName } from '../cron/prepaid-expiry-notices.service';
import { showMiaFor, miaImageUrl } from '../email-sequences/mia-email';
import { emailLocaleOf, sendMiaEmail, toMailLocale } from '../email-sequences/mia-mailer';
import {
  RenewalDeclinedData,
  RenewalRecoveryStep,
  buildRenewalDeclinedEmail,
  recoveryBonusBellText,
  renewCtaLabel,
  renewalDeclinedBellText,
} from '../email-sequences/retencao-templates';
import { isDeclinedPerfectpaySale } from './decline-fallback.service';

/**
 * Régua de recuperação da RENOVAÇÃO recusada na Perfect Pay e na Cakto (candy-retencao, L04, 24/11/2026).
 *
 * Molde: Baremetrics Q3/2026 (203.756 cobranças): mediana de recuperação 29,4%; o e-mail do D0 recupera 32%, o do D3
 * 33% e o do D7 24%; 52% pagam em 3 dias, 75% em 7 e 90% em 14. Candy: cobra um meio de pagamento reserva quando a
 * renovação falha (candy.ai/terms-of-service).
 *
 * - Gatilho: postback de cobrança recusada de quem JÁ pagou a assinatura ao menos 1 vez (a 1ª compra recusada é do
 *   DeclineFallbackService, que pula de propósito quem já paga).
 * - D0 na hora do postback; D3 e D7 pelo cron abaixo. Canal: e-mail da Mia (com WhatsApp + Telegram no rodapé, o bot já
 *   abre no assunto do plano) + sino com foto e botão. O link é o pré-pago de 30 dias do mesmo plano (pagamento único
 *   aprova ~94% contra ~31% da recorrência no cartão estrangeiro), e a vitrine quando o plano não tem avulso.
 * - Bônus de volta: quem paga de novo dentro de RECOVERY_PP_BONUS_WINDOW_DAYS (padrão 10) a partir do D0 ganha o bônus
 *   do plano. Prejuízo zero: bônus = mínimo entre 2.000 cr e 50% da margem do plano (2.000 cr = US$ 1,61 no pior custo
 *   de 0,000805/cr): Creator/Pro/Advanced 2.000, Studio 1.000; plano sem conta feita = 0 (sem bônus e sem D7).
 * - Dedupe por claim em email_sequence_logs (sequence `pp_renewal_recovery`): 1 campanha por assinatura e ciclo
 *   (data do fim do período), 1 linha por passo, reserva ANTES de enviar e apagada no erro.
 * - Desligado por padrão: RECOVERY_PP_ENABLED=on liga. Sem ela, nem o D0 nem o cron fazem nada.
 */
export const RENEWAL_RECOVERY_SEQUENCE = 'pp_renewal_recovery';
export const RENEWAL_DECLINED_TYPE = 'payment-renewal-declined';
export const RENEWAL_BONUS_TYPE = 'payment-renewal-bonus';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Teto do bônus (spec: mínimo entre 2.000 cr e 50% da margem do plano). */
export const RECOVERY_BONUS_MAX_CREDITS = 2000;
/** Bônus por plano (slug base). Plano fora daqui = 0: sem a conta da margem, não dá bônus. */
export const DEFAULT_RECOVERY_BONUS_BY_PLAN: Readonly<Record<string, number>> = {
  creator: 2000,
  pro: 2000,
  advanced: 2000,
  studio: 1000,
};
const DEFAULT_BONUS_WINDOW_DAYS = 10;
/** Cada passo tem 2 dias de janela: um cron perdido não vira rajada retroativa. */
const STEP_CATCHUP_MS = 2 * DAY_MS;
const SWEEP_LIMIT = 500;

type EnvLike = Record<string, string | undefined>;

export function isRenewalRecoveryEnabled(env: EnvLike = process.env): boolean {
  const value = (env.RECOVERY_PP_ENABLED ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1';
}

/** Slug do plano sem o sufixo de anual ou pré-pago: "pro-anual" → "pro", "studio-30d" → "studio". */
export function basePlanSlugOf(plan: { slug: string; basePlanSlug?: string | null }): string {
  const raw = (plan.basePlanSlug || plan.slug).trim().toLowerCase();
  return raw.replace(/-(30d|90d|anual|annual|yearly|ano)$/, '');
}

/** "creator:2000,pro:2000,studio:1000" → mapa. Valor inválido some (o plano fica sem bônus). */
export function parseBonusByPlan(raw: string | undefined): Record<string, number> | null {
  if (!raw || !raw.trim()) return null;
  const out: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [slug, value] = part.split(':').map((x) => x?.trim().toLowerCase());
    const credits = Number.parseInt(value ?? '', 10);
    if (slug && Number.isFinite(credits) && credits >= 0) out[slug] = credits;
  }
  return out;
}

export function recoveryBonusCreditsFor(
  plan: { slug: string; basePlanSlug?: string | null },
  env: EnvLike = process.env,
): number {
  const table = parseBonusByPlan(env.RECOVERY_PP_BONUS_CREDITS) ?? DEFAULT_RECOVERY_BONUS_BY_PLAN;
  const credits = table[basePlanSlugOf(plan)] ?? 0;
  return Math.max(0, Math.min(RECOVERY_BONUS_MAX_CREDITS, Math.floor(credits)));
}

export function recoveryBonusWindowDays(env: EnvLike = process.env): number {
  const parsed = Number.parseInt(env.RECOVERY_PP_BONUS_WINDOW_DAYS ?? '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BONUS_WINDOW_DAYS;
  return Math.max(1, Math.min(30, parsed));
}

/** 1 campanha por assinatura e ciclo: as retentativas da PP no mesmo ciclo caem no mesmo D0. */
export function recoveryCampaignKey(userId: string, subscriptionId: string, periodEnd: Date): string {
  return `${RENEWAL_RECOVERY_SEQUENCE}:${userId}:${subscriptionId}:${periodEnd.toISOString().slice(0, 10)}`;
}

export function parseRecoveryKey(
  emailKey: string,
): { campaign: string; userId: string; subscriptionId: string; step: string } | null {
  const parts = emailKey.split(':');
  if (parts.length !== 5 || parts[0] !== RENEWAL_RECOVERY_SEQUENCE) return null;
  return { campaign: parts.slice(0, 4).join(':'), userId: parts[1], subscriptionId: parts[2], step: parts[4] };
}

/** Passo devido pela idade da campanha (a partir do D0). D7 só quando há bônus para oferecer. */
export function dueRecoveryStep(ageMs: number, done: ReadonlySet<string>, hasBonus: boolean): RenewalRecoveryStep | null {
  if (done.has('won')) return null;
  if (hasBonus && !done.has('d7') && ageMs >= 7 * DAY_MS && ageMs < 7 * DAY_MS + STEP_CATCHUP_MS) return 'd7';
  if (!done.has('d3') && !done.has('d7') && ageMs >= 3 * DAY_MS && ageMs < 3 * DAY_MS + STEP_CATCHUP_MS) return 'd3';
  return null;
}

/**
 * Link do avulso de 30 dias a partir do link da ASSINATURA do plano (Perfect Pay: código PPU…; Cakto: código curto),
 * trocando só o código no fim do caminho. Null quando o link não tem avulso do mesmo gateway.
 */
export function prepaidUrlForProvider(subscriptionUrl: string | null | undefined, provider: string): string | null {
  if (typeof subscriptionUrl !== 'string' || !subscriptionUrl) return null;
  const clean = subscriptionUrl.split(/[?#]/)[0];
  const lastSlash = clean.lastIndexOf('/');
  const code = clean.slice(lastSlash + 1);
  const wantPerfectpay = provider !== 'cakto';
  const prepaid = Object.entries(PREPAID_TO_SUBSCRIPTION_CHECKOUT_CODE).find(
    ([prepaidCode, subscriptionCode]) => subscriptionCode === code && prepaidCode.startsWith('PPU') === wantPerfectpay,
  )?.[0];
  return prepaid ? `${clean.slice(0, lastSlash + 1)}${prepaid}` : null;
}

export type RenewalDeclineResult =
  | 'created'
  | 'disabled'
  | 'not_declined'
  | 'no_email'
  | 'no_account'
  | 'no_subscription'
  | 'prepaid'
  | 'first_purchase'
  | 'duplicate'
  | 'error';

type CampaignSubscription = {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  paymentProvider: string | null;
  plan: { id: string; slug: string; name: string; basePlanSlug: string | null; checkoutUrl: string | null };
};

type CampaignUser = {
  id: string;
  email: string;
  name: string | null;
  locale: string | null;
  country: string | null;
  signupBrand: string | null;
  isActive: boolean;
  marketingOptOut: boolean;
};

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  locale: true,
  country: true,
  signupBrand: true,
  isActive: true,
  marketingOptOut: true,
} as const;

const SUB_SELECT = {
  id: true,
  userId: true,
  status: true,
  currentPeriodEnd: true,
  paymentProvider: true,
  plan: { select: { id: true, slug: true, name: true, basePlanSlug: true, checkoutUrl: true } },
} as const;

@Injectable()
export class RenewalDeclineRecoveryService {
  private readonly logger = new Logger(RenewalDeclineRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  /** Envs da régua lidas pelo ConfigService (padrão desligado). */
  private env(): EnvLike {
    return {
      RECOVERY_PP_ENABLED: this.configService.get<string>('RECOVERY_PP_ENABLED'),
      RECOVERY_PP_BONUS_CREDITS: this.configService.get<string>('RECOVERY_PP_BONUS_CREDITS'),
      RECOVERY_PP_BONUS_WINDOW_DAYS: this.configService.get<string>('RECOVERY_PP_BONUS_WINDOW_DAYS'),
    };
  }

  /** Entrada do webhook da Perfect Pay (evento não pago). Nunca lança. */
  async onPerfectpayPostback(payload: any, email: string | null, subscriptionCode: string | null): Promise<RenewalDeclineResult> {
    return this.onRenewalDeclined({
      provider: 'perfectpay',
      declined: isDeclinedPerfectpaySale(payload),
      email,
      subscriptionCode,
    });
  }

  /** D0: cobrança recusada de quem já pagou a assinatura. Nunca lança (o webhook responde 200 ao gateway). */
  async onRenewalDeclined(input: {
    provider: 'perfectpay' | 'cakto';
    declined: boolean;
    email: string | null;
    subscriptionCode: string | null;
    now?: Date;
  }): Promise<RenewalDeclineResult> {
    const now = input.now ?? new Date();
    try {
      if (!isRenewalRecoveryEnabled(this.env())) return 'disabled';
      if (!input.declined) return 'not_declined';
      if (!input.email) return 'no_email';

      const user = await this.prisma.user.findUnique({ where: { email: input.email }, select: USER_SELECT });
      if (!user) return 'no_account';

      const subscription = await this.prisma.subscription.findFirst({
        where: {
          userId: user.id,
          paymentProvider: input.provider,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE, SubscriptionStatus.CANCELED] },
          ...(input.subscriptionCode ? { externalSubscriptionId: input.subscriptionCode } : {}),
        },
        orderBy: { createdAt: 'desc' },
        select: SUB_SELECT,
      });
      if (!subscription || subscription.plan.slug === 'free') return 'no_subscription';
      if (isPrepaidPlanSlug(subscription.plan.slug)) return 'prepaid';

      // Já pagou esta assinatura ao menos 1 vez: senão é 1ª compra (DeclineFallbackService cuida).
      const paidBefore = await this.prisma.payment.count({
        where: { subscriptionId: subscription.id, status: 'COMPLETED' },
      });
      if (paidBefore === 0) return 'first_purchase';

      const campaign = recoveryCampaignKey(user.id, subscription.id, subscription.currentPeriodEnd);
      const sent = await this.sendStep('d0', campaign, user, subscription, now, now);
      return sent;
    } catch (error: unknown) {
      this.logger.error(`Recuperação da renovação (D0) falhou: ${messageOf(error)}`);
      return 'error';
    }
  }

  /** D3, D7 e o bônus de volta. A cada 30 min; com a flag desligada não lê nada. */
  @Cron('*/30 * * * *')
  async runSteps(now: Date = new Date()): Promise<{ won: number; sent: number }> {
    const result = { won: 0, sent: 0 };
    if (!isRenewalRecoveryEnabled(this.env())) return result;
    try {
      const windowDays = recoveryBonusWindowDays(this.env());
      const since = new Date(now.getTime() - Math.max(windowDays * DAY_MS, 7 * DAY_MS + STEP_CATCHUP_MS) - DAY_MS);
      const starts = await this.prisma.emailSequenceLog.findMany({
        where: { sequence: RENEWAL_RECOVERY_SEQUENCE, sentAt: { gte: since }, emailKey: { endsWith: ':d0' } },
        select: { userId: true, emailKey: true, sentAt: true },
        orderBy: { sentAt: 'asc' },
        take: SWEEP_LIMIT,
      });
      if (!starts.length) return result;

      const logs = await this.prisma.emailSequenceLog.findMany({
        where: { sequence: RENEWAL_RECOVERY_SEQUENCE, userId: { in: [...new Set(starts.map((s) => s.userId))] } },
        select: { emailKey: true },
      });
      const doneByCampaign = new Map<string, Set<string>>();
      for (const log of logs) {
        const parsed = parseRecoveryKey(log.emailKey);
        if (!parsed) continue;
        const set = doneByCampaign.get(parsed.campaign) ?? new Set<string>();
        set.add(parsed.step);
        doneByCampaign.set(parsed.campaign, set);
      }

      for (const start of starts) {
        const parsed = parseRecoveryKey(start.emailKey);
        if (!parsed) continue;
        const done = doneByCampaign.get(parsed.campaign) ?? new Set<string>();
        if (done.has('won')) continue;
        try {
          const outcome = await this.advanceCampaign(parsed, start.sentAt, done, now, windowDays);
          if (outcome === 'won') result.won++;
          if (outcome === 'sent') result.sent++;
        } catch (error: unknown) {
          this.logger.error(`Recuperação ${parsed.campaign}: ${messageOf(error)}`);
        }
      }
      if (result.won || result.sent) {
        this.logger.log(`Recuperação da renovação: ${result.sent} envio(s), ${result.won} volta(s)`);
      }
    } catch (error: unknown) {
      this.logger.error(`Varredura da recuperação da renovação falhou: ${messageOf(error)}`);
    }
    return result;
  }

  private async advanceCampaign(
    parsed: { campaign: string; userId: string; subscriptionId: string },
    startedAt: Date,
    done: Set<string>,
    now: Date,
    windowDays: number,
  ): Promise<'won' | 'sent' | 'idle'> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: parsed.subscriptionId },
      select: SUB_SELECT,
    });
    if (!subscription) return 'idle';

    // Voltou a pagar (renovação tardia, outro cartão ou o avulso): fecha a campanha e dá o bônus se foi no prazo.
    const paid = await this.prisma.payment.findFirst({
      where: { userId: parsed.userId, type: 'SUBSCRIPTION', status: 'COMPLETED', createdAt: { gt: startedAt } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true },
    });
    if (paid) {
      const inWindow = paid.createdAt.getTime() - startedAt.getTime() <= windowDays * DAY_MS;
      const bonus = inWindow ? recoveryBonusCreditsFor(subscription.plan, this.env()) : 0;
      const granted = await this.closeCampaign(parsed.campaign, parsed.userId, bonus, subscription, paid.id);
      return granted ? 'won' : 'idle';
    }

    const bonus = recoveryBonusCreditsFor(subscription.plan, this.env());
    const step = dueRecoveryStep(now.getTime() - startedAt.getTime(), done, bonus > 0);
    if (!step) return 'idle';

    const user = await this.prisma.user.findUnique({ where: { id: parsed.userId }, select: USER_SELECT });
    if (!user || !user.isActive) return 'idle';
    // D7 é oferta (bônus): quem pediu para não receber marketing fica só com o aviso de cobrança (D0/D3)
    if (step === 'd7' && user.marketingOptOut) return 'idle';
    const outcome = await this.sendStep(step, parsed.campaign, user, subscription, startedAt, now);
    if (outcome === 'created') done.add(step);
    return outcome === 'created' ? 'sent' : 'idle';
  }

  /** Reserva o passo, manda o e-mail e o sino; sem envio, libera a reserva. */
  private async sendStep(
    step: RenewalRecoveryStep,
    campaign: string,
    user: CampaignUser,
    subscription: CampaignSubscription,
    startedAt: Date,
    now: Date,
  ): Promise<RenewalDeclineResult> {
    let claimId: string;
    try {
      const claim = await this.prisma.emailSequenceLog.create({
        data: { userId: user.id, sequence: RENEWAL_RECOVERY_SEQUENCE, emailKey: `${campaign}:${step}` },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code === 'P2002') return 'duplicate';
      throw error;
    }

    try {
      const locale = emailLocaleOf(user);
      const provider = subscription.paymentProvider ?? 'perfectpay';
      const balance = await this.prisma.creditBalance.findUnique({
        where: { userId: user.id },
        select: { planCreditsRemaining: true, bonusCreditsRemaining: true },
      });
      const bonus = recoveryBonusCreditsFor(subscription.plan, this.env());
      const data: RenewalDeclinedData = {
        planName: prepaidPlanDisplayName(subscription.plan.name),
        savedCredits: (balance?.planCreditsRemaining ?? 0) + (balance?.bonusCreditsRemaining ?? 0),
        payUrl: await this.payUrlFor(subscription, provider, toMailLocale(locale)),
        bonusCredits: bonus,
        bonusDeadline: new Date(startedAt.getTime() + recoveryBonusWindowDays(this.env()) * DAY_MS),
      };
      const { subject, body } = buildRenewalDeclinedEmail(step, data, locale, { mia: showMiaFor(user.signupBrand) });

      const resendId = user.isActive
        ? await sendMiaEmail(this.emailService, {
            recipient: user,
            subject,
            bodyMarkdown: body,
            plan: subscription.plan.name,
            x1Options: { recoveryPlan: recoveryPlanFromName(subscription.plan.name) },
          })
        : null;
      if (resendId) {
        await this.prisma.emailSequenceLog
          .update({ where: { id: claimId }, data: { resendEmailId: resendId } })
          .catch(() => undefined);
      }

      await this.notifications.create(user.id, RENEWAL_DECLINED_TYPE, {
        key: `${campaign}:${step}`,
        step,
        reason: renewalDeclinedBellText(step, data, locale),
        planSlug: subscription.plan.slug,
        planName: data.planName,
        checkoutUrl: data.payUrl,
        ctaUrl: data.payUrl,
        ctaLabel: renewCtaLabel(locale),
        imageUrl: miaImageUrl(step === 'd7' ? 'renewal_bonus' : 'renewal_failed'),
        bonusCredits: step === 'd7' ? bonus : 0,
        declinedAt: startedAt.toISOString(),
        sentAt: now.toISOString(),
      });
      this.logger.log(`Recuperação ${step.toUpperCase()} de ${subscription.plan.slug} (user ${user.id}) enviada.`);
      return 'created';
    } catch (error: unknown) {
      await this.prisma.emailSequenceLog.delete({ where: { id: claimId } }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Fecha a campanha (linha `won`) e credita o bônus na MESMA transação: a 2ª instância bate no P2002 e não
   * credita de novo. Devolve true quando fechou agora.
   */
  private async closeCampaign(
    campaign: string,
    userId: string,
    bonus: number,
    subscription: CampaignSubscription,
    paymentId: string,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.emailSequenceLog.create({
          data: { userId, sequence: RENEWAL_RECOVERY_SEQUENCE, emailKey: `${campaign}:won` },
        });
        if (bonus <= 0) return;
        await tx.creditBalance.upsert({
          where: { userId },
          create: { userId, bonusCreditsRemaining: bonus, planCreditsRemaining: 0, planCreditsUsed: 0 },
          update: { bonusCreditsRemaining: { increment: bonus } },
        });
        await tx.creditTransaction.create({
          data: {
            userId,
            // mesmo tipo do bônus de volta da campanha Stripe (payments.service.ts closeRecoveryCampaignIfAny)
            type: CreditTransactionType.REFERRAL_BONUS,
            amount: bonus,
            source: 'bonus',
            description: `Bônus de retorno: +${bonus} créditos (renovação recusada recuperada, ${subscription.paymentProvider ?? 'perfectpay'})`,
            paymentId,
            metadata: { campaign },
          },
        });
      });
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code === 'P2002') return false;
      throw error;
    }

    if (bonus > 0) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true, country: true } });
      const locale = emailLocaleOf(user ?? {});
      await this.notifications
        .create(userId, RENEWAL_BONUS_TYPE, {
          key: `${campaign}:won`,
          reason: recoveryBonusBellText(bonus, locale),
          bonusCredits: bonus,
          planSlug: subscription.plan.slug,
        })
        .catch((error: unknown) => this.logger.warn(`Sino do bônus de volta falhou: ${messageOf(error)}`));
      this.logger.log(`Bônus de volta +${bonus} cr (user ${userId}, ${subscription.plan.slug}).`);
    }
    return true;
  }

  /** Avulso de 30 d do mesmo plano no mesmo gateway; sem ele, a vitrine no idioma dela. */
  private async payUrlFor(subscription: CampaignSubscription, provider: string, locale: 'pt' | 'es' | 'en'): Promise<string> {
    const monthly = subscription.plan.basePlanSlug
      ? await this.prisma.plan.findFirst({
          where: { slug: subscription.plan.basePlanSlug },
          select: { checkoutUrl: true, prices: { select: { checkoutUrl: true } } },
        })
      : await this.prisma.plan.findUnique({
          where: { id: subscription.plan.id },
          select: { checkoutUrl: true, prices: { select: { checkoutUrl: true } } },
        });
    const candidates = [monthly?.checkoutUrl, ...(monthly?.prices ?? []).map((price) => price.checkoutUrl)];
    for (const url of candidates) {
      const prepaid = prepaidUrlForProvider(url, provider);
      if (prepaid) return prepaid;
    }
    return `${PREPAID_RENEW_BASE_URL}/${sitePathFor(locale)}/pricing`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
