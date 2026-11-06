/**
 * Comissão de afiliado sobre as RENOVAÇÕES de assinatura (Perfect Pay e Cakto).
 *
 * Padrão = comportamento de sempre: o afiliado recebe só na primeira ativação.
 * A env `AFFILIATE_RECURRING_MONTHS` liga a recorrência sem deploy de código:
 *   - vazia, `0` ou inválida → só a primeira ativação (como hoje);
 *   - `all`                  → toda renovação, enquanto a assinatura durar;
 *   - `N` (1 a 120)          → renovações até N meses depois da primeira comissão
 *                              que o afiliado recebeu desse cliente.
 *
 * Packs de créditos não passam por aqui: já pagam comissão em toda compra.
 */
export type AffiliateRecurringWindow =
  | { mode: 'first-only' }
  | { mode: 'lifetime' }
  | { mode: 'months'; months: number };

export const AFFILIATE_RECURRING_MAX_MONTHS = 120;

export function resolveAffiliateRecurringWindow(raw: string | undefined | null): AffiliateRecurringWindow {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return { mode: 'first-only' };
  if (value === 'all') return { mode: 'lifetime' };
  if (!/^\d+$/.test(value)) return { mode: 'first-only' };

  const months = Number.parseInt(value, 10);
  if (months <= 0) return { mode: 'first-only' };
  return { mode: 'months', months: Math.min(months, AFFILIATE_RECURRING_MAX_MONTHS) };
}

/**
 * A renovação que chegou agora paga comissão?
 * `firstEarningAt` = data da primeira comissão do afiliado com esse cliente
 * (null quando ainda não houve nenhuma: a janela começa nesta cobrança).
 */
export function renewalEarnsCommission(
  window: AffiliateRecurringWindow,
  firstEarningAt: Date | null,
  now: Date,
): boolean {
  if (window.mode === 'first-only') return false;
  if (window.mode === 'lifetime') return true;
  if (!firstEarningAt) return true;

  const windowEnd = new Date(firstEarningAt);
  windowEnd.setMonth(windowEnd.getMonth() + window.months);
  return now.getTime() < windowEnd.getTime();
}
