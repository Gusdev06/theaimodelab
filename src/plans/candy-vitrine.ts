import { createHash } from 'node:crypto';
import { prepaidPeriodMonths } from './prepaid-plan';

/**
 * Pacote candy-vitrine (24/11/2026): mecânicas de venda da Candy.ai, OurDream e Promptchan.
 *
 *  - L03 1º mês de entrada (plano `*-entrada`, créditos do 1º mês em FIRST_MONTH_CREDITS);
 *  - L09 bump de créditos no checkout do plano (PERFECTPAY_PLAN_BUMP_CODES);
 *  - L13 plano trimestral (billingInterval 'quarter', créditos mês a mês);
 *  - L21 cobrança a cada 28 dias (billingInterval '28d');
 *  - L28 pacote avulso só para assinante, em A/B (PACKS_SUBSCRIBERS_ONLY_PCT).
 *
 * Tudo DESLIGADO por padrão: sem as envs abaixo nenhum plano novo aparece, nenhum código novo
 * casa no webhook e a API responde igual a antes. Os produtos na Perfect Pay/Cakto ainda não
 * existem; quando existirem, o link entra em CANDY_CHECKOUT_USD/BRL e o código do postback em
 * CANDY_PLAN_CODES (vazio = o card não aparece e a venda não casa).
 */
export type CandyEnv = Record<string, string | undefined>;

export const CANDY_CHECKOUT_USD_ENV = 'CANDY_CHECKOUT_USD';
export const CANDY_CHECKOUT_BRL_ENV = 'CANDY_CHECKOUT_BRL';
export const CANDY_PLAN_CODES_ENV = 'CANDY_PLAN_CODES';
export const PERFECTPAY_PLAN_BUMP_CODES_ENV = 'PERFECTPAY_PLAN_BUMP_CODES';
export const FIRST_MONTH_CREDITS_ENV = 'FIRST_MONTH_CREDITS';
export const PACKS_SUBSCRIBERS_ONLY_PCT_ENV = 'PACKS_SUBSCRIBERS_ONLY_PCT';
export const CANDY_AFFILIATE_MAX_PCT_ENV = 'CANDY_AFFILIATE_MAX_PCT';

/** Intervalos novos (Plan.billingInterval é String livre: não há enum a migrar). */
export const QUARTER_INTERVAL = 'quarter';
export const BILLING_28D_INTERVAL = '28d';
export const BILLING_28D_DAYS = 28;
/** Planos cobrados de uma vez por vários meses cujos créditos saem mês a mês (cron AnnualCreditsRefill). */
export const MONTHLY_REFILL_INTERVALS: readonly string[] = ['year', QUARTER_INTERVAL];

/** Sufixo do plano de 1º mês de entrada (ex.: creator-entrada, basePlanSlug creator). */
export const FIRST_MONTH_OFFER_SUFFIX = '-entrada';

/** Sufixo do id externo do bump: a Perfect Pay pode mandar o bump com o MESMO código de venda do plano. */
export const PLAN_BUMP_SALE_SUFFIX = '-bump';

/**
 * Teto de comissão de afiliado por plano novo (a casa nunca perde no pior caso, US$ 0,000805/cr,
 * PP ~10% + US$ 1,50, imposto 6%):
 *  - creator-entrada US$ 14,90 / R$ 69,90 com 8.000 cr: +4,58 / +16,64 sem afiliado → teto 25%
 *    (a spec pedia 27%, mas no BRL 27% do líquido dá −0,35; 25% fecha nas duas moedas);
 *  - creator-trimestral US$ 44,90 / R$ 219,90 com 36.000 cr: +7,24 / +23,18 → teto 10%;
 *  - pro-trimestral US$ 89,90 / R$ 489,90 com 90.000 cr: +1,57 / +19,57 → teto 1%.
 * Os 28 dias têm a mesma margem do mensal por ciclo: sem teto próprio.
 * CANDY_AFFILIATE_MAX_PCT ("slug=pct,...") sobrescreve.
 */
export const DEFAULT_CANDY_AFFILIATE_MAX_PCT: Readonly<Record<string, number>> = {
  'creator-entrada': 25,
  'creator-trimestral': 10,
  'pro-trimestral': 1,
};

/** "chave=valor,chave2=valor2" → Map. Separa no 1º '=' (URL com query continua inteira). */
export function parsePairs(raw: string | undefined, lowerKeys = true): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const chunk of (raw ?? '').split(',')) {
    const at = chunk.indexOf('=');
    if (at <= 0) continue;
    const key = chunk.slice(0, at).trim();
    const value = chunk.slice(at + 1).trim();
    if (!key || !value) continue;
    pairs.set(lowerKeys ? key.toLowerCase() : key, value);
  }
  return pairs;
}

/** Links de checkout dos planos novos na moeda pedida (slug → URL). Vazio = nenhum card novo. */
export function candyCheckoutUrls(currency: string, env: CandyEnv = process.env): Map<string, string> {
  const name = currency.toUpperCase() === 'BRL' ? CANDY_CHECKOUT_BRL_ENV : CANDY_CHECKOUT_USD_ENV;
  const urls = parsePairs(env[name]);
  for (const [slug, url] of urls) {
    if (!/^https:\/\//i.test(url)) urls.delete(slug);
  }
  return urls;
}

/** Código do postback (plan.code da PP ou oferta da Cakto) → slug do plano novo. */
export function candyPlanSlugForCodes(candidates: readonly string[], env: CandyEnv = process.env): string | null {
  const codes = parsePairs(env[CANDY_PLAN_CODES_ENV]);
  if (codes.size === 0) return null;
  for (const candidate of candidates) {
    const slug = codes.get(String(candidate).trim().toLowerCase());
    if (slug) return slug.toLowerCase();
  }
  return null;
}

/** Código do bump no checkout do plano → nome do pacote de créditos (ex.: "Plus"). */
export function bumpPackageNameForCodes(candidates: readonly string[], env: CandyEnv = process.env): string | null {
  const codes = parsePairs(env[PERFECTPAY_PLAN_BUMP_CODES_ENV]);
  if (codes.size === 0) return null;
  for (const candidate of candidates) {
    const name = codes.get(String(candidate).trim().toLowerCase());
    if (name) return name;
  }
  return null;
}

type PeriodPlan = { billingInterval?: string | null; slug: string };

/** Meses que a cobrança cobre: anual 12, trimestral 3, pré-pago 1 ou 3, o resto 1 (inclusive 28 dias). */
export function billingPeriodMonths(plan: PeriodPlan): number {
  if (plan.billingInterval === 'year') return 12;
  if (plan.billingInterval === QUARTER_INTERVAL) return 3;
  return prepaidPeriodMonths(plan.slug);
}

/** Avança `date` (muta e devolve) um período de cobrança: 28 dias no plano '28d', `months` meses no resto. */
export function addBillingPeriod(date: Date, plan: { billingInterval?: string | null }, months: number): Date {
  if (plan.billingInterval === BILLING_28D_INTERVAL) {
    date.setDate(date.getDate() + BILLING_28D_DAYS);
    return date;
  }
  date.setMonth(date.getMonth() + months);
  return date;
}

export function isFirstMonthOfferSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.trim().toLowerCase().endsWith(FIRST_MONTH_OFFER_SUFFIX);
}

/** FIRST_MONTH_CREDITS: créditos do 1º mês do plano de entrada. Vazio/0/inválido = 0 (desligado). */
export function resolveFirstMonthCredits(env: CandyEnv = process.env): number {
  const parsed = Number.parseInt((env[FIRST_MONTH_CREDITS_ENV] ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Créditos do plano concedidos na ATIVAÇÃO. Plano de entrada com FIRST_MONTH_CREDITS: esse número
 * (nunca acima do plano cheio); qualquer outro caso: os créditos do plano, como sempre.
 */
export function activationPlanCredits(
  plan: { slug: string; creditsPerMonth: number },
  env: CandyEnv = process.env,
): number {
  if (!isFirstMonthOfferSlug(plan.slug)) return plan.creditsPerMonth;
  const firstMonth = resolveFirstMonthCredits(env);
  return firstMonth > 0 ? Math.min(firstMonth, plan.creditsPerMonth) : plan.creditsPerMonth;
}

/** Teto de % de comissão do afiliado para o plano (null = sem teto, a % do afiliado vale). */
export function affiliateMaxPercentForPlan(slug: string | null | undefined, env: CandyEnv = process.env): number | null {
  if (typeof slug !== 'string') return null;
  const key = slug.trim().toLowerCase();
  const override = parsePairs(env[CANDY_AFFILIATE_MAX_PCT_ENV]).get(key);
  if (override !== undefined) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed, 100);
  }
  return DEFAULT_CANDY_AFFILIATE_MAX_PCT[key] ?? null;
}

/** PACKS_SUBSCRIBERS_ONLY_PCT: % das contas sem plano no braço "pacote só para assinante". 0 = desligado. */
export function resolvePacksSubscribersOnlyPct(env: CandyEnv = process.env): number {
  const parsed = Number.parseInt((env[PACKS_SUBSCRIBERS_ONLY_PCT_ENV] ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 100);
}

/** Balde estável 0..99 do usuário (sha256 do id): o mesmo usuário cai sempre no mesmo braço. */
export function userBucket(userId: string): number {
  const digest = createHash('sha256').update(`packs-subscribers-only:${userId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function inSubscribersOnlyArm(userId: string, pct: number): boolean {
  return pct > 0 && userBucket(userId) < pct;
}

/**
 * Marca os pacotes do braço B: sem plano, só o pacote de entrada fica comprável; os outros voltam
 * com `locked: true` e sem link (o site mostra o cadeado "Exclusivo para assinantes").
 */
export function lockPackagesForNonSubscribers<T extends { name: string; checkoutUrl?: string | null }>(
  packages: T[],
  entryNames: Set<string>,
): (T & { locked?: boolean })[] {
  return packages.map((pkg) =>
    entryNames.has(pkg.name.trim().toLowerCase()) ? pkg : { ...pkg, checkoutUrl: null, locked: true },
  );
}

/** É plano novo do candy-vitrine (1º mês de entrada, trimestral ou 28 dias)? */
export function isCandyBillingPlan(plan: { slug: string; billingInterval?: string | null }): boolean {
  return (
    isFirstMonthOfferSlug(plan.slug) ||
    plan.billingInterval === QUARTER_INTERVAL ||
    plan.billingInterval === BILLING_28D_INTERVAL
  );
}

function formatMoney(cents: number, currency: string): string {
  const upper = currency.toUpperCase();
  const value = (cents / 100).toFixed(2);
  return upper === 'BRL' ? `R$ ${value.replace('.', ',')}` : `US$ ${value}`;
}

/**
 * Linha de cobrança do e-mail de boas-vindas (anti-chargeback, lição DreamGF: a renovação cheia escrita
 * antes da 1ª renovação). Só nos planos novos; null = e-mail igual a hoje.
 *  - entrada: créditos do 1º mês + preço e créditos da renovação (preço do mensal irmão, se conhecido);
 *  - trimestral: cobrado a cada 3 meses, créditos todo mês;
 *  - 28 dias: cobrado a cada 28 dias.
 */
export function subscriptionBillingNote(
  plan: { slug: string; billingInterval?: string | null; creditsPerMonth: number },
  opts: { firstMonthCredits: number; amountCents: number; currency: string; renewalPriceCents?: number | null },
): string | null {
  const credits = (n: number) => n.toLocaleString('en-US');
  if (isFirstMonthOfferSlug(plan.slug)) {
    const renewal = opts.renewalPriceCents && opts.renewalPriceCents > 0 ? `${formatMoney(opts.renewalPriceCents, opts.currency)}/month` : 'the full monthly price';
    return `Your first month: ${credits(opts.firstMonthCredits)} credits. From month 2 it renews at ${renewal} with ${credits(plan.creditsPerMonth)} credits a month. Cancel anytime before the renewal date.`;
  }
  if (plan.billingInterval === QUARTER_INTERVAL) {
    return `Billed ${formatMoney(opts.amountCents, opts.currency)} every 3 months. ${credits(plan.creditsPerMonth)} credits land every month. Cancel anytime.`;
  }
  if (plan.billingInterval === BILLING_28D_INTERVAL) {
    return `Billed ${formatMoney(opts.amountCents, opts.currency)} every 28 days, with ${credits(plan.creditsPerMonth)} credits each cycle. Cancel anytime.`;
  }
  return null;
}
