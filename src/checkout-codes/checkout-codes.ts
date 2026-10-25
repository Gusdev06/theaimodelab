/**
 * Códigos de checkout extras (tabela `checkout_codes`). Regras puras, sem banco, para testar sem mock.
 *
 * O plano/pacote continua com o código e o link principais. Cada código extra:
 *  - faz o webhook reconhecer mais um código de venda (outra marca, outra conta do gateway, código antigo);
 *  - com `checkoutUrl`, troca o link da vitrine da marca dele. Na marca de origem o link do plano manda.
 */

export const CHECKOUT_GATEWAYS = ['perfectpay', 'cakto'] as const;
export type CheckoutGateway = (typeof CHECKOUT_GATEWAYS)[number];

export const CHECKOUT_CURRENCIES = ['USD', 'BRL', 'EUR'] as const;
export type CheckoutCurrency = (typeof CHECKOUT_CURRENCIES)[number];

export function isCheckoutGateway(value: unknown): value is CheckoutGateway {
  return typeof value === 'string' && (CHECKOUT_GATEWAYS as readonly string[]).includes(value);
}

/** Último trecho do caminho de um link (`…/pay/PPU38CQDTOD?x=1` → `PPU38CQDTOD`). */
function lastPathSegment(value: string): string | null {
  try {
    const url = new URL(value);
    const segment = url.pathname.replace(/\/+$/, '').split('/').pop();
    return segment ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

/**
 * Código como chega no webhook. Aceita o link de checkout inteiro: na Cakto `pay.cakto.com.br/<oferta>_<id>`
 * vira `<oferta>`; na Perfect Pay o último trecho do link. Devolve null para vazio ou formato estranho.
 */
export function normalizeCheckoutCode(gateway: CheckoutGateway, raw: string | null | undefined): string | null {
  let value = (raw ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) {
    const segment = lastPathSegment(value);
    if (!segment) return null;
    value = segment;
  }
  if (gateway === 'cakto') value = value.split('_')[0] ?? '';
  value = value.trim();
  if (!/^[A-Za-z0-9-]{3,64}$/.test(value)) return null;
  return value;
}

/** Link de checkout aceito na vitrine: só https. */
export function isSafeCheckoutUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface StorefrontRow {
  planId: string | null;
  creditPackageId: string | null;
  checkoutUrl: string | null;
}

/**
 * Link da vitrine por plano (ou pacote). Linhas já vêm do mais novo para o mais velho: o primeiro link válido de
 * cada item vence. Link que não é https fica de fora (o chamador mostra o da origem).
 */
export function linksByTarget(rows: readonly StorefrontRow[], target: 'plan' | 'package'): Map<string, string> {
  const links = new Map<string, string>();
  for (const row of rows) {
    const id = target === 'plan' ? row.planId : row.creditPackageId;
    if (!id || links.has(id) || !isSafeCheckoutUrl(row.checkoutUrl)) continue;
    links.set(id, row.checkoutUrl as string);
  }
  return links;
}

export interface SaleTargetRow<P, K> {
  code: string;
  plan: (P & { isActive: boolean }) | null;
  creditPackage: K | null;
}

export type SaleTarget<P, K> = { kind: 'plan'; plan: P } | { kind: 'package'; creditPackage: K };

/**
 * Plano ou pacote de uma venda pelos códigos extras. A ordem dos candidatos do webhook decide (o código do plano
 * vem antes do nome e do link). `activePlanOnly` segue a regra de cada gateway: a Perfect Pay só casa plano
 * ativo; a Cakto vende também os planos antigos desativados.
 */
export function pickSaleTarget<P extends object, K>(
  candidates: readonly string[],
  rows: readonly SaleTargetRow<P, K>[],
  activePlanOnly: boolean,
): SaleTarget<P, K> | null {
  for (const candidate of candidates) {
    const row = rows.find((item) => item.code === candidate);
    if (!row) continue;
    if (row.plan) {
      if (activePlanOnly && !row.plan.isActive) continue;
      const { isActive: _ignored, ...plan } = row.plan;
      return { kind: 'plan', plan: plan as unknown as P };
    }
    if (row.creditPackage) return { kind: 'package', creditPackage: row.creditPackage };
  }
  return null;
}
