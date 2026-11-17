/**
 * Plano pré-pago de 30 dias (desde 17/11/2026): pagamento único na Perfect Pay, sem
 * recorrência. O slug é o do plano mensal + '-30d' (pro-30d, advanced-30d, studio-30d,
 * creator-30d). Vence no fim do período e só continua com uma nova compra.
 */
export const PREPAID_PLAN_SLUG_SUFFIX = '-30d';

export function isPrepaidPlanSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.endsWith(PREPAID_PLAN_SLUG_SUFFIX);
}

/**
 * Código do link de checkout do pré-pago → código do link da ASSINATURA recorrente do
 * mesmo plano (o link que a vitrine tinha antes de 17/11).
 */
export const PREPAID_TO_SUBSCRIPTION_CHECKOUT_CODE: Readonly<Record<string, string>> = {
  PPU38CQHN67: 'PPU38CQDTOD', // pro
  PPU38CQHQPQ: 'PPU38CQDTOH', // advanced
  PPU38CQHQPR: 'PPU38CQDTOA', // studio
  PPU38CQHQPS: 'PPU38CQDTOF', // creator
};

/**
 * Link de assinatura equivalente a um link de pré-pago, trocando só o código no fim do
 * caminho (host, query string e âncora ficam iguais). Devolve null quando o link não é
 * de pré-pago.
 */
export function subscriptionCheckoutUrlFor(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url) return null;
  const suffixAt = url.search(/[?#]/);
  const base = suffixAt === -1 ? url : url.slice(0, suffixAt);
  const suffix = suffixAt === -1 ? '' : url.slice(suffixAt);
  const lastSlash = base.lastIndexOf('/');
  const code = base.slice(lastSlash + 1);
  const subscriptionCode = PREPAID_TO_SUBSCRIPTION_CHECKOUT_CODE[code];
  if (!subscriptionCode) return null;
  return `${base.slice(0, lastSlash + 1)}${subscriptionCode}${suffix}`;
}

/**
 * A chamada anônima ao /plans veio da Início do app (/home, com ou sem prefixo de língua)?
 * O cartão "upgrade pelo ritmo" do site congelado (9f3c8ec) pede /plans SEM token e só
 * aparece para assinante da Perfect Pay. O site chama a API same-origin (rewrite da
 * Vercel), então o Referer traz o caminho. Chamada cross-origin só manda a origem e cai
 * no false (link de pré-pago, como antes).
 */
export function isInAppHomeReferer(referer: unknown): boolean {
  const raw = Array.isArray(referer) ? referer[0] : referer;
  if (typeof raw !== 'string' || !raw) return false;
  try {
    return /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?home\/?$/i.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}

type EnvLike = Record<string, string | undefined>;

/** Chave de desligar: 'off' (ou 'false'/'0') desliga; ausente ou qualquer outro valor = ligado. */
function flagOn(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value !== 'off' && value !== 'false' && value !== '0';
}

/**
 * PREPAID_LOCK_ON_EXPIRY: pré-pago vencido perde as gerações grátis. Padrão DESLIGADO
 * (só 'on'/'true'/'1' liga): o plano não dá geração grátis, então o que a trava corta é o
 * bundle do Pack/isca (entregue também pelo admin, sem origem gravada), conteúdo pago.
 * Ligar é decisão do dono.
 */
export function isPrepaidLockOnExpiryEnabled(env: EnvLike = process.env): boolean {
  const value = (env.PREPAID_LOCK_ON_EXPIRY ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1';
}

/** PREPAID_NOTICES: avisos D-3/D-1/D0 do pré-pago no sino (padrão ligado). */
export function isPrepaidNoticesEnabled(env: EnvLike = process.env): boolean {
  return flagOn(env.PREPAID_NOTICES);
}

/** Por quantos dias depois do vencimento a trava do pré-pago continua valendo. */
export const PREPAID_LOCK_WINDOW_DAYS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PrepaidSubscriptionSnapshot {
  status: string;
  currentPeriodEnd: Date;
  updatedAt: Date;
  plan: { slug: string };
}

/**
 * A assinatura terminou por VENCIMENTO (não por estorno/chargeback)? O estorno cancela
 * antes do fim do período; o cron de vencimento só cancela depois dele. Por isso
 * CANCELED com updatedAt >= currentPeriodEnd = venceu. ACTIVE com o período já passado
 * = venceu e o cron ainda não rodou.
 */
export function endedByExpiry(sub: PrepaidSubscriptionSnapshot, now: Date): boolean {
  const end = sub.currentPeriodEnd.getTime();
  if (end > now.getTime()) return false;
  if (sub.status === 'ACTIVE') return true;
  return sub.status === 'CANCELED' && sub.updatedAt.getTime() >= end;
}

/**
 * Trava do pré-pago vencido: sem assinatura ACTIVE, a mais recente é de plano pré-pago,
 * venceu (não foi estornada) e venceu há no máximo PREPAID_LOCK_WINDOW_DAYS dias.
 */
export function isExpiredPrepaidLock(
  latest: PrepaidSubscriptionSnapshot | null,
  hasActiveSubscription: boolean,
  now: Date,
): boolean {
  if (hasActiveSubscription || !latest) return false;
  if (!isPrepaidPlanSlug(latest.plan.slug) || latest.status !== 'CANCELED') return false;
  if (!endedByExpiry(latest, now)) return false;
  return now.getTime() - latest.currentPeriodEnd.getTime() <= PREPAID_LOCK_WINDOW_DAYS * DAY_MS;
}
