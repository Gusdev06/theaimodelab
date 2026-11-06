/**
 * Totais de comissão separados por moeda.
 *
 * A plataforma vende em real (Cakto) e em dólar (Perfect Pay); somar centavos das
 * duas moedas num número só não diz quanto pagar ao afiliado. Os campos antigos
 * continuam somando tudo; `byCurrency` é o que vale para pagar.
 */
export const DEFAULT_EARNING_CURRENCY = 'BRL';

export interface CurrencyCommissionTotals {
  currency: string;
  totalRevenueCents: number;
  totalCommissionCents: number;
  pendingCommissionCents: number;
  /** Pendente que já passou do prazo de maturação. */
  availableCommissionCents: number;
  /** Pendente ainda dentro do prazo de maturação. */
  maturingCommissionCents: number;
  paidCommissionCents: number;
}

export interface EarningCurrencySlice {
  /** Moeda gravada na comissão (null nas comissões anteriores à coluna). */
  currency: string | null | undefined;
  /** Moeda do pagamento ligado: vale quando a comissão não tem a sua. */
  paymentCurrency?: string | null;
  status: string;
  /** Só importa para PENDING: já passou do prazo de maturação? */
  matured: boolean;
  amountCents: number;
  commissionCents: number;
}

export function resolveEarningCurrency(
  earningCurrency: string | null | undefined,
  paymentCurrency?: string | null,
): string {
  const resolved = (earningCurrency ?? '').trim() || (paymentCurrency ?? '').trim();
  return resolved ? resolved.toUpperCase() : DEFAULT_EARNING_CURRENCY;
}

export function summarizeByCurrency(slices: EarningCurrencySlice[]): CurrencyCommissionTotals[] {
  const totalsByCurrency = new Map<string, CurrencyCommissionTotals>();

  for (const slice of slices) {
    const currency = resolveEarningCurrency(slice.currency, slice.paymentCurrency);
    const totals = totalsByCurrency.get(currency) ?? {
      currency,
      totalRevenueCents: 0,
      totalCommissionCents: 0,
      pendingCommissionCents: 0,
      availableCommissionCents: 0,
      maturingCommissionCents: 0,
      paidCommissionCents: 0,
    };

    totals.totalRevenueCents += slice.amountCents;
    totals.totalCommissionCents += slice.commissionCents;
    if (slice.status === 'PENDING') {
      totals.pendingCommissionCents += slice.commissionCents;
      if (slice.matured) totals.availableCommissionCents += slice.commissionCents;
      else totals.maturingCommissionCents += slice.commissionCents;
    } else if (slice.status === 'PAID') {
      totals.paidCommissionCents += slice.commissionCents;
    }
    totalsByCurrency.set(currency, totals);
  }

  return Array.from(totalsByCurrency.values()).sort(
    (a, b) => b.totalCommissionCents - a.totalCommissionCents || a.currency.localeCompare(b.currency),
  );
}

/** Valor da comissão para o e-mail de pagamento: sem moeda sai em real, como sempre. */
export function formatAffiliatePayoutAmount(totalCents: number, currency?: string | null): string {
  const code = (currency ?? '').trim().toUpperCase() || DEFAULT_EARNING_CURRENCY;
  const amount = totalCents / 100;
  try {
    return amount.toLocaleString('pt-BR', { style: 'currency', currency: code });
  } catch {
    // Código que o Intl não conhece: mostra o código cru na frente, nunca finge que é real.
    return `${code} ${amount.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
