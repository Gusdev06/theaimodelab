import { Prisma, SubscriptionStatus } from '@prisma/client';

/**
 * "Já pagou" para os créditos diários (candy-retencao, L26, 24/11/2026): assinatura paga ativa OU um pagamento
 * concluído (plano, pré-pago, pacote) OU a compra do Pack na Perfect Pay (bundle de gerações grátis consumido) nos
 * últimos N dias.
 *
 * Mesma definição de pagante do bônus semanal (RewardsService.userIsPaying: assinatura ACTIVE de plano que não é o
 * free), estendida ao pack como a spec pede. A janela fecha a conta de prejuízo zero: 30 cr × 30 dias = 900 cr =
 * US$ 0,72 por pagamento (pack US$ 7,80 líquido − 0,72 = +7,08). Sem janela, quem comprou 1 pack ganharia para sempre.
 */
export const DEFAULT_PAID_WINDOW_DAYS = 30;

type PayingClient = Pick<Prisma.TransactionClient, 'subscription' | 'payment' | 'pendingFreeGenerationGrant'>;

export async function isPayingCustomer(
  client: PayingClient,
  userId: string,
  now: Date = new Date(),
  windowDays: number = DEFAULT_PAID_WINDOW_DAYS,
): Promise<boolean> {
  const activePlan = await client.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.ACTIVE, plan: { slug: { not: 'free' } } },
    select: { id: true },
  });
  if (activePlan) return true;

  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const recentPayment = await client.payment.findFirst({
    where: { userId, status: 'COMPLETED', amountCents: { gt: 0 }, createdAt: { gte: since } },
    select: { id: true },
  });
  if (recentPayment) return true;

  // Pack 300+ e demais produtos da Perfect Pay: entram como bundle de gerações grátis (sem Payment); estorno vira
  // source "perfectpay:refunded" e sai daqui.
  const recentPack = await client.pendingFreeGenerationGrant.findFirst({
    where: { consumedByUserId: userId, source: 'perfectpay', createdAt: { gte: since } },
    select: { id: true },
  });
  return !!recentPack;
}

type EnvLike = Record<string, string | undefined>;

/** DAILY_CREDITS_PAID_ONLY=true (ou on/1) liga a trava; padrão desligado (todo mundo com e-mail confirmado, como hoje). */
export function isDailyPaidOnly(env: EnvLike = process.env): boolean {
  const value = (env.DAILY_CREDITS_PAID_ONLY ?? '').trim().toLowerCase();
  return value === 'true' || value === 'on' || value === '1';
}

export function dailyPaidWindowDays(env: EnvLike = process.env): number {
  const parsed = Number.parseInt(env.DAILY_CREDITS_PAID_WINDOW_DAYS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : DEFAULT_PAID_WINDOW_DAYS;
}
