/**
 * Comissão do afiliado por produto (programa público em rede, molde candy.ai/affiliate, L05 de 24/11/2026).
 *
 * Env AFFILIATE_PERCENT_BY_PLAN, lista "produto:percentual" separada por vírgula, por exemplo
 *   pack:40,creator:25,pro:15,advanced:0,studio:0
 * Vazia ou ausente = regra de hoje (o percentual único gravado no afiliado). Com ela, o produto citado troca o
 * percentual do afiliado pelo da lista, sempre limitado ao TETO DE PREJUÍZO ZERO do produto (abaixo). Produto que a
 * lista não cita, ou que não tem teto conhecido, segue com o percentual do afiliado, como hoje.
 *
 * Chaves: `pack` = qualquer compra de créditos avulsa (CREDIT_PURCHASE); plano = slug do plano MENSAL (creator, pro,
 * advanced, studio). O anual entra como `<slug>:year` e não tem teto aqui (a margem dele é outra), então nunca muda.
 *
 * Teto (conta da matriz de 24/11, pior caso: taxa PP ~10% + US$ 1,50, imposto 6%, crédito a US$ 0,000805):
 *   pack 12,99 → margem 7,80; 40% deixa +2,60 (teto do programa: 40)
 *   creator → margem 5,56 sobre o preço; teto 27,9% → 27
 *   pro → teto 19,7% → 19
 *   advanced → teto 8% → 8
 *   studio → teto 1,5% → 1
 * A comissão incide sobre o líquido (depois da taxa do gateway, affiliate-net.ts), o que só aumenta a folga.
 * CPA fixo não existe aqui: daria prejuízo em todos os produtos.
 */
export const AFFILIATE_PERCENT_CAP_BY_PRODUCT: Readonly<Record<string, number>> = Object.freeze({
  pack: 40,
  creator: 27,
  pro: 19,
  advanced: 8,
  studio: 1,
});

export type AffiliatePercentByProduct = ReadonlyMap<string, number>;

const ENTRY_SHAPE = /^([a-z0-9][a-z0-9_-]*(?::year)?)\s*[:=]\s*(\d{1,3})$/;

/** Lê a env. Entrada mal formada é ignorada (nunca derruba a venda); lista vazia = desligado. */
export function parseAffiliatePercentByPlan(raw: string | undefined | null): AffiliatePercentByProduct {
  const table = new Map<string, number>();
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return table;
  for (const chunk of text.split(/[,;\s]+/)) {
    const entry = chunk.trim();
    if (!entry) continue;
    // "creator:25" ou "creator=25"; o anual vem como "creator:year:25"
    const normalized = entry.replace(/^([a-z0-9_-]+):year[:=]/, '$1:year=');
    const match = ENTRY_SHAPE.exec(normalized);
    if (!match) continue;
    const percent = Number.parseInt(match[2], 10);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    table.set(match[1], percent);
  }
  return table;
}

export interface AffiliateProductRef {
  /** tipo do pagamento (SUBSCRIPTION | CREDIT_PURCHASE) */
  paymentType: string | null | undefined;
  /** slug do plano da assinatura do pagamento */
  planSlug?: string | null;
  /** slug do plano mensal irmão (só nos anuais) */
  basePlanSlug?: string | null;
  /** 'month' | 'year' */
  billingInterval?: string | null;
}

/** Chave do produto na tabela: `pack`, o slug do mensal, ou `<base>:year` no anual. null = produto desconhecido. */
export function affiliateProductKey(ref: AffiliateProductRef): string | null {
  if (ref.paymentType === 'CREDIT_PURCHASE') return 'pack';
  const slug = (ref.basePlanSlug || ref.planSlug || '').trim().toLowerCase();
  if (!slug) return null;
  return ref.billingInterval === 'year' ? `${slug}:year` : slug;
}

export interface EffectiveAffiliatePercent {
  percent: number;
  /** 'affiliate' = regra de hoje; 'by-plan' = veio da env (já com o teto aplicado) */
  source: 'affiliate' | 'by-plan';
  productKey: string | null;
}

/**
 * Percentual que vale nesta venda. Sem a env (tabela vazia) devolve SEMPRE o do afiliado: comportamento idêntico ao
 * de antes. Com a env, o produto citado e com teto conhecido usa min(lista, teto).
 */
export function resolveEffectiveAffiliatePercent(
  affiliatePercent: number,
  table: AffiliatePercentByProduct,
  ref: AffiliateProductRef,
): EffectiveAffiliatePercent {
  const productKey = affiliateProductKey(ref);
  if (table.size === 0 || !productKey) return { percent: affiliatePercent, source: 'affiliate', productKey };
  const wanted = table.get(productKey);
  const cap = AFFILIATE_PERCENT_CAP_BY_PRODUCT[productKey];
  if (wanted === undefined || cap === undefined) return { percent: affiliatePercent, source: 'affiliate', productKey };
  return { percent: Math.max(0, Math.min(wanted, cap)), source: 'by-plan', productKey };
}
