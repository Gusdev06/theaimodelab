/**
 * Base líquida da comissão de afiliado, por gateway.
 *
 * Padrão = comportamento de sempre: toda venda desconta a taxa da Stripe
 * (3,99% + 39 centavos), seja qual for o gateway. A env
 * `AFFILIATE_GATEWAY_FEE_PERCENT` troca a taxa só dos gateways que ela cita:
 *   AFFILIATE_GATEWAY_FEE_PERCENT="perfectpay:20,cakto:6"
 * Gateway citado → líquido = bruto × (1 − taxa). Gateway ausente → fórmula da Stripe.
 * Percentual inteiro ou decimal com ponto, de 0 a 60; entrada inválida é ignorada.
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

export function parseAffiliateGatewayFees(raw: string | undefined | null): Map<string, number> {
  const fees = new Map<string, number>();
  for (const entry of (raw ?? '').split(',')) {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex <= 0) continue;

    const gateway = entry.slice(0, separatorIndex).trim().toLowerCase();
    const percentText = entry.slice(separatorIndex + 1).trim();
    if (!gateway || !/^\d{1,2}(\.\d{1,4})?$/.test(percentText)) continue;

    const percent = Number.parseFloat(percentText);
    if (!Number.isFinite(percent) || percent < 0 || percent > AFFILIATE_GATEWAY_FEE_MAX_PERCENT) continue;
    fees.set(gateway, percent);
  }
  return fees;
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
