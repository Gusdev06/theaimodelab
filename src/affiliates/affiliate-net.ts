/**
 * Base líquida da comissão de afiliado, por gateway.
 *
 * Padrão = comportamento de sempre: toda venda desconta a taxa da Stripe
 * (3,99% + 39 centavos), seja qual for o gateway. A env
 * `AFFILIATE_GATEWAY_FEE_PERCENT` troca a taxa só dos gateways que ela cita:
 *   AFFILIATE_GATEWAY_FEE_PERCENT="perfectpay:20,cakto:6"
 * Gateway citado → líquido = bruto × (1 − taxa). Gateway ausente → fórmula da Stripe.
 * Percentual inteiro ou decimal com ponto, de 0 a 60; entrada inválida não vale
 * (o gateway dela fica na fórmula da Stripe) e sai num aviso no log.
 */
export const AFFILIATE_GATEWAY_FEE_MAX_PERCENT = 60;

const STRIPE_FEE_RATE = 0.0399;
const STRIPE_FEE_FIXED_CENTS = 39;

export interface AffiliateNetAmount {
  netCents: number;
  feeCents: number;
  /** De onde saiu a taxa: a env do gateway ou a fórmula padrão (Stripe). */
  rule: 'gateway-percent' | 'stripe-default';
}

export interface AffiliateGatewayFeesParse {
  fees: Map<string, number>;
  /** Entradas escritas na env que não valeram ("perfectpay:20%", "perfectpay=20", "perfectpay:100"). */
  discarded: string[];
}

const GATEWAY_FEE_PERCENT_PATTERN = /^\d{1,2}(\.\d{1,4})?$/;

export function parseAffiliateGatewayFeesDetailed(raw: string | undefined | null): AffiliateGatewayFeesParse {
  const fees = new Map<string, number>();
  const discarded: string[] = [];

  for (const rawEntry of (raw ?? '').split(',')) {
    const entry = rawEntry.trim();
    // Vírgula sobrando não é erro de digitação que mereça aviso.
    if (!entry) continue;

    const separatorIndex = entry.indexOf(':');
    const gateway = separatorIndex > 0 ? entry.slice(0, separatorIndex).trim().toLowerCase() : '';
    const percentText = separatorIndex > 0 ? entry.slice(separatorIndex + 1).trim() : '';
    const percent = GATEWAY_FEE_PERCENT_PATTERN.test(percentText) ? Number.parseFloat(percentText) : Number.NaN;

    if (!gateway || !Number.isFinite(percent) || percent < 0 || percent > AFFILIATE_GATEWAY_FEE_MAX_PERCENT) {
      discarded.push(entry);
      continue;
    }
    fees.set(gateway, percent);
  }

  return { fees, discarded };
}

export function parseAffiliateGatewayFees(raw: string | undefined | null): Map<string, number> {
  return parseAffiliateGatewayFeesDetailed(raw).fees;
}

/** Valores da env já avisados: o aviso sai uma vez por valor, não a cada venda. */
const warnedGatewayFeeValues = new Set<string>();
const WARNED_GATEWAY_FEE_VALUES_LIMIT = 50;

/**
 * Avisa no log, uma vez por valor distinto da env, as entradas que não valeram.
 * Devolve as entradas avisadas nesta chamada (vazio quando não há nada novo a dizer).
 */
export function warnDiscardedAffiliateGatewayFees(
  raw: string | undefined | null,
  warn: (message: string) => void,
): string[] {
  const value = (raw ?? '').trim();
  if (!value || warnedGatewayFeeValues.has(value)) return [];

  const { discarded } = parseAffiliateGatewayFeesDetailed(value);
  if (discarded.length === 0) return [];

  if (warnedGatewayFeeValues.size >= WARNED_GATEWAY_FEE_VALUES_LIMIT) warnedGatewayFeeValues.clear();
  warnedGatewayFeeValues.add(value);
  warn(
    `AFFILIATE_GATEWAY_FEE_PERCENT tem entrada inválida, ignorada: ${discarded
      .map((entry) => `"${entry}"`)
      .join(', ')}. Formato: gateway:percentual (0 a ${AFFILIATE_GATEWAY_FEE_MAX_PERCENT}, decimal com ponto). O gateway dessas entradas segue na taxa padrão.`,
  );
  return discarded;
}

/** Só para teste: esquece os valores já avisados. */
export function resetAffiliateGatewayFeeWarnings(): void {
  warnedGatewayFeeValues.clear();
}

export function computeAffiliateNetCents(
  amountCents: number,
  provider: string | undefined | null,
  rawGatewayFees: string | undefined | null,
): AffiliateNetAmount {
  const gateway = (provider ?? '').trim().toLowerCase();
  const gatewayPercent = gateway ? parseAffiliateGatewayFees(rawGatewayFees).get(gateway) : undefined;

  if (gatewayPercent !== undefined) {
    const feeCents = Math.round((amountCents * gatewayPercent) / 100);
    return { netCents: amountCents - feeCents, feeCents, rule: 'gateway-percent' };
  }

  const feeCents = Math.round(amountCents * STRIPE_FEE_RATE) + STRIPE_FEE_FIXED_CENTS;
  return { netCents: amountCents - feeCents, feeCents, rule: 'stripe-default' };
}
