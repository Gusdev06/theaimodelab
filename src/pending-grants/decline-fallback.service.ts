import { Injectable, Logger } from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailLocale, mailLocaleFor } from '../email/brand-email';
import { PREPAID_PLAN_SLUG_SUFFIX, PREPAID_TO_SUBSCRIPTION_CHECKOUT_CODE, isPrepaidPlanSlug } from '../plans/prepaid-plan';
import { prepaidPlanDisplayName } from '../cron/prepaid-expiry-notices.service';

/**
 * Avulso na hora da recusa (dono 23/11/2026: "assinatura como primeira e fallback da avulsa").
 *
 * Por quê: a assinatura aprova ~31% no cartão estrangeiro (o banco barra a cobrança recorrente de comerciante
 * brasileiro, ECOM 57/64) e o pagamento único do mesmo valor aprova ~94%. A oferta do avulso por e-mail horas depois
 * (recusados_volta) vendeu 0 em 140 envios até 20/11: a vontade de comprar já tinha passado. Aqui a recusa da 1ª compra
 * de um plano vira, no mesmo minuto, um aviso no sino com o link do pré-pago de 30 dias do mesmo plano; o site abre a
 * folha com 1 botão quando ela volta para a aba da plataforma.
 *
 * Não mexe em acesso, saldo nem assinatura: só cria a notificação. Quem já paga um plano (renovação, troca de plano)
 * fica de fora. Desligar sem deploy: DECLINE_FALLBACK_NOTICE=off.
 */
export const DECLINE_FALLBACK_TYPE = 'payment-declined-fallback';
/** `sequence` em email_sequence_logs que segura 1 aviso por cliente, plano e dia (não é e-mail). */
export const DECLINE_FALLBACK_SEQUENCE = 'decline_fallback';

type EnvLike = Record<string, string | undefined>;

export function isDeclineFallbackEnabled(env: EnvLike = process.env): boolean {
  const value = (env.DECLINE_FALLBACK_NOTICE ?? '').trim().toLowerCase();
  return value !== 'off' && value !== 'false' && value !== '0';
}

/**
 * Postback da Perfect Pay de cobrança RECUSADA no cartão: `rejected` (5) ou `cancelled` (6, que na PP é cartão
 * recusado, não cancelamento; ver classifyEvent). Pendente, boleto vencido e mediação não entram.
 */
export function isDeclinedPerfectpaySale(payload: any): boolean {
  const key = typeof payload?.sale_status_enum_key === 'string' ? payload.sale_status_enum_key.trim().toLowerCase() : '';
  if (key) return key === 'rejected' || key === 'cancelled' || key === 'canceled';
  const status = Number(payload?.sale_status_enum);
  return status === 5 || status === 6;
}

/** Slug do pré-pago de 30 dias que substitui o plano recusado (o anual cai no mensal irmão). Null = não há avulso. */
export function prepaidSlugForDeclinedPlan(plan: { slug: string; basePlanSlug?: string | null }): string | null {
  if (isPrepaidPlanSlug(plan.slug)) return null;
  const base = (plan.basePlanSlug ?? plan.slug).trim().toLowerCase();
  if (!base || base === 'free') return null;
  return `${base}${PREPAID_PLAN_SLUG_SUFFIX}`;
}

/**
 * Link do avulso de 30 d em US$ (Perfect Pay) a partir do link da ASSINATURA do plano. No banco, o pré-pago US$ não tem
 * checkout_url (a vitrine voltou à assinatura em 19/11): o par assinatura ↔ avulso mora em
 * PREPAID_TO_SUBSCRIPTION_CHECKOUT_CODE. Troca só o código no fim do caminho.
 */
export function prepaidCheckoutUrlFromSubscriptionUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url) return null;
  const clean = url.split(/[?#]/)[0];
  const lastSlash = clean.lastIndexOf('/');
  const code = clean.slice(lastSlash + 1);
  const prepaidCode = Object.entries(PREPAID_TO_SUBSCRIPTION_CHECKOUT_CODE).find(
    ([prepaid, subscription]) => subscription === code && prepaid.startsWith('PPU'),
  )?.[0];
  return prepaidCode ? `${clean.slice(0, lastSlash + 1)}${prepaidCode}` : null;
}

/** Texto do sino na língua da cliente (o site mostra a folha com o botão; o sino guarda o recado). */
export function declineFallbackText(locale: MailLocale, planName: string): string {
  const plan = prepaidPlanDisplayName(planName);
  if (locale === 'pt') {
    return `Seu banco bloqueou a cobrança automática do ${plan}. Leve 1 mês sem renovação: mesmo preço, mesmos créditos.`;
  }
  if (locale === 'es') {
    return `Tu banco bloqueó el cobro automático de ${plan}. Llévate 1 mes sin renovación: mismo precio, mismos créditos.`;
  }
  return `Your bank blocked the automatic billing for ${plan}. Get 1 month with no renewal: same price, same credits.`;
}

/** Chave do dia em UTC: várias tentativas recusadas no mesmo dia geram 1 aviso só. */
export function declineFallbackKey(userId: string, prepaidSlug: string, now: Date): string {
  return `${DECLINE_FALLBACK_SEQUENCE}:${userId}:${prepaidSlug}:${now.toISOString().slice(0, 10)}`;
}

export type DeclineFallbackResult =
  | 'created'
  | 'disabled'
  | 'not_declined'
  | 'no_email'
  | 'no_account'
  | 'no_plan'
  | 'no_prepaid'
  | 'already_paying'
  | 'duplicate'
  | 'error';

@Injectable()
export class DeclineFallbackService {
  private readonly logger = new Logger(DeclineFallbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Chamado pelo webhook da Perfect Pay para todo evento que não é pago nem estorno. Nunca lança: o webhook tem de
   * responder 200 à PP mesmo que o aviso falhe.
   */
  async notifyIfFirstPlanDecline(
    payload: any,
    email: string | null,
    planCandidates: string[],
    now: Date = new Date(),
  ): Promise<DeclineFallbackResult> {
    try {
      if (!isDeclineFallbackEnabled()) return 'disabled';
      if (!isDeclinedPerfectpaySale(payload)) return 'not_declined';
      if (!email) return 'no_email';

      const plan = await this.findDeclinedPlan(payload, planCandidates);
      if (!plan) return 'no_plan';
      const prepaidSlug = prepaidSlugForDeclinedPlan(plan);
      if (!prepaidSlug) return 'no_plan';

      const prepaid = await this.prisma.plan.findFirst({
        where: { slug: prepaidSlug, isActive: true },
        select: { slug: true },
      });
      // o avulso vem do link da assinatura MENSAL (o anual cai no mensal irmão)
      const monthly = plan.basePlanSlug
        ? await this.prisma.plan.findFirst({ where: { slug: plan.basePlanSlug }, select: { checkoutUrl: true } })
        : plan;
      const checkoutUrl = prepaidCheckoutUrlFromSubscriptionUrl(monthly?.checkoutUrl);
      if (!prepaid || !checkoutUrl) return 'no_prepaid';

      const user = await this.prisma.user.findUnique({
        where: { email },
        select: { id: true, locale: true, country: true },
      });
      if (!user) return 'no_account';

      // Renovação recusada ou troca de plano de quem já paga: não é 1ª compra, o avulso aqui atrapalharia.
      const paying = await this.prisma.subscription.findFirst({
        where: {
          userId: user.id,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE, SubscriptionStatus.TRIALING] },
          plan: { slug: { not: 'free' } },
        },
        select: { id: true },
      });
      if (paying) return 'already_paying';

      const key = declineFallbackKey(user.id, prepaidSlug, now);
      // Reserva antes de criar (molde do aviso do pré-pago): a 2ª recusa do dia bate no P2002 e sai.
      let claimId: string;
      try {
        const claim = await this.prisma.emailSequenceLog.create({
          data: { userId: user.id, sequence: DECLINE_FALLBACK_SEQUENCE, emailKey: key },
          select: { id: true },
        });
        claimId = claim.id;
      } catch (error: unknown) {
        if ((error as { code?: string } | null)?.code === 'P2002') return 'duplicate';
        throw error;
      }

      try {
        const locale = mailLocaleFor(user);
        await this.notifications.create(user.id, DECLINE_FALLBACK_TYPE, {
          key,
          reason: declineFallbackText(locale, plan.name),
          planSlug: plan.slug,
          planName: prepaidPlanDisplayName(plan.name),
          prepaidSlug: prepaid.slug,
          checkoutUrl,
          saleCode: typeof payload?.code === 'string' ? payload.code : null,
          declinedAt: now.toISOString(),
        });
      } catch (error: unknown) {
        await this.prisma.emailSequenceLog.delete({ where: { id: claimId } }).catch(() => undefined);
        throw error;
      }

      this.logger.log(`Recusa de ${plan.slug} (user ${user.id}): aviso do avulso ${prepaid.slug} criado.`);
      return 'created';
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Aviso do avulso na recusa falhou: ${message}`);
      return 'error';
    }
  }

  /** Plano recorrente da venda recusada: pelo código do postback e, se não casar, pelo nome do plano. */
  private async findDeclinedPlan(
    payload: any,
    planCandidates: string[],
  ): Promise<{ slug: string; name: string; basePlanSlug: string | null; checkoutUrl: string | null } | null> {
    const select = { slug: true, name: true, basePlanSlug: true, checkoutUrl: true } as const;
    if (planCandidates.length) {
      const byCode = await this.prisma.plan.findFirst({
        where: { perfectpayPlanCode: { in: planCandidates } },
        select,
      });
      if (byCode) return byCode;
    }
    const rawName = typeof payload?.plan?.name === 'string' ? payload.plan.name.toLowerCase().replace(/[-_]/g, ' ') : '';
    if (!rawName) return null;
    // o próprio avulso recusado ("Studio · 30 days (one-time payment)") não pode virar oferta de avulso de novo
    if (/\b(30|90)\s*(d|days|dias|días)\b|one.?time|pagamento [uú]nico|pago [uú]nico/.test(rawName)) return null;
    const plans = await this.prisma.plan.findMany({ where: { isActive: true }, select });
    // slug mais longo primeiro: "Plan Pro Anual" casa "pro-anual", não "pro"
    return (
      plans
        .slice()
        .sort((a, b) => b.slug.length - a.slug.length)
        .find((p) => new RegExp(`\\b${p.slug.toLowerCase().replace(/-/g, ' ')}\\b`).test(rawName)) ?? null
    );
  }
}
