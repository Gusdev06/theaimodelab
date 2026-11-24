/**
 * Bônus de créditos do plano anual no 1º mês (molde OurDream: 2.000 moedas no anual
 * contra 1.000 no mensal).
 *
 * Controlado pela env ANNUAL_FIRST_MONTH_BONUS_PERCENT (inteiro, % sobre os
 * `creditsPerMonth` do plano). Ausente, inválida ou <= 0 => DESLIGADO (padrão).
 * O teto de 100% protege contra erro de digitação (ex.: "1000" em vez de "10").
 *
 * O bônus é crédito "bonus" (não expira, não é zerado na renovação do plano), então
 * conferir a conta no crédito mais barato (anual) antes de ligar a env.
 */
export const ANNUAL_FIRST_MONTH_BONUS_ENV = 'ANNUAL_FIRST_MONTH_BONUS_PERCENT';
export const ANNUAL_FIRST_MONTH_BONUS_MAX_PERCENT = 100;

/** Marcador gravado em `CreditTransaction.metadata.kind` para achar/deduplicar o bônus. */
export const ANNUAL_FIRST_MONTH_BONUS_KIND = 'annual_first_month';

export const ANNUAL_FIRST_MONTH_BONUS_DESCRIPTION = 'Bônus do plano anual (1º mês)';

export function resolveAnnualFirstMonthBonusPercent(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ANNUAL_FIRST_MONTH_BONUS_ENV];
  if (raw == null || raw.trim() === '') return 0;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, ANNUAL_FIRST_MONTH_BONUS_MAX_PERCENT);
}

/**
 * Créditos de bônus a conceder na ativação do plano. 0 quando a env está desligada
 * ou quando o plano não é anual (mensal nunca ganha o bônus).
 */
export function computeAnnualFirstMonthBonusCredits(
  plan: { billingInterval: string; creditsPerMonth: number; slug?: string | null },
  env: Record<string, string | undefined> = process.env,
): number {
  if (plan.billingInterval !== 'year') return 0;
  if (!isAnnualBonusPlanAllowed(plan.slug, env)) return 0;
  const percent = resolveAnnualFirstMonthBonusPercent(env);
  if (percent <= 0) return 0;
  return Math.round((plan.creditsPerMonth * percent) / 100);
}

/**
 * ANNUAL_BONUS_PLANS (candy-vitrine, L08): slugs anuais que podem ganhar o bônus
 * ("creator-anual,pro-anual"). Vazia/ausente = como antes (todo anual). Advanced e Studio
 * anual já são negativos no pior caso SEM bônus: preencher a lista ANTES de ligar a %.
 */
export const ANNUAL_BONUS_PLANS_ENV = 'ANNUAL_BONUS_PLANS';

export function resolveAnnualBonusPlans(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env[ANNUAL_BONUS_PLANS_ENV] ?? '')
      .split(',')
      .map((slug) => slug.trim().toLowerCase())
      .filter((slug) => slug.length > 0),
  );
}

export function isAnnualBonusPlanAllowed(
  slug: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const allowed = resolveAnnualBonusPlans(env);
  if (allowed.size === 0) return true;
  return typeof slug === 'string' && allowed.has(slug.trim().toLowerCase());
}
