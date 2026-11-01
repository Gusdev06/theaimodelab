/**
 * Idioma do comprador da isca (Perfect Pay), para o e-mail de acesso sair na
 * língua certa (TKT-004: antes saía num idioma só para todo mundo, e o botão
 * levava ao /login em português).
 *
 * Ordem de decisão: código do produto comprado → país do comprador → moeda da
 * venda. Sem pista nenhuma, inglês (o comportamento antigo).
 */
export type BuyerLocale = 'en' | 'es' | 'pt';

/**
 * Produtos da isca na Perfect Pay, conta CPF e conta CNPJ, por idioma.
 * Fonte: PERFECTPAY-MIGRACAO/2026-10-15/cnpj/mapa-codigos.json (papel de cada
 * produto). Pode ser estendido sem deploy por PERFECTPAY_PRODUCT_LOCALES.
 */
export const DEFAULT_PERFECTPAY_PRODUCT_LOCALES: Readonly<Record<string, BuyerLocale>> = {
  // Pack 300 prompts (principal)
  PPPBFHBE: 'es',
  PPPBFJAQ: 'es',
  PPPBFHC5: 'en',
  PPPBFJAR: 'en',
  // Voz humanizada (order bump)
  PPPBFHC2: 'es',
  PPPBFJAH: 'es',
  PPPBFHD0: 'en',
  PPPBFJAI: 'en',
  // Pack de vídeo (order bump)
  PPPBFKG0: 'es',
  PPPBFKG1: 'en',
  // Instagram vivo (upsell 1)
  PPPBFHBS: 'es',
  PPPBFJAN: 'es',
  PPPBFHD9: 'en',
  PPPBFJAO: 'en',
  // Consistência do personagem (upsell 2)
  PPPBFHBR: 'es',
  PPPBFJAK: 'es',
  PPPBFHCQ: 'en',
  PPPBFJAL: 'en',
};

const SPANISH_COUNTRIES = new Set([
  'MX', 'ES', 'AR', 'CL', 'CO', 'PE', 'EC', 'VE', 'UY', 'PY', 'BO', 'GT', 'HN',
  'SV', 'NI', 'CR', 'PA', 'DO', 'CU', 'PR', 'GQ',
]);
const PORTUGUESE_COUNTRIES = new Set(['BR', 'PT', 'AO', 'MZ', 'CV', 'GW', 'ST', 'TL']);

/** Nomes de país que a Perfect Pay pode mandar por extenso (minúsculo, sem acento). */
const COUNTRY_NAMES: Record<string, BuyerLocale> = {
  mexico: 'es', espana: 'es', spain: 'es', argentina: 'es', chile: 'es', colombia: 'es',
  peru: 'es', ecuador: 'es', venezuela: 'es', uruguay: 'es', paraguay: 'es', bolivia: 'es',
  guatemala: 'es', honduras: 'es', 'el salvador': 'es', nicaragua: 'es', 'costa rica': 'es',
  panama: 'es', 'republica dominicana': 'es', 'dominican republic': 'es', cuba: 'es',
  'puerto rico': 'es',
  brasil: 'pt', brazil: 'pt', portugal: 'pt',
};

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Idioma pelo país (código ISO de 2 letras ou nome por extenso). País conhecido
 * fora do espanhol/português devolve inglês; valor vazio ou irreconhecível
 * devolve null para a próxima pista decidir.
 */
export function localeFromCountry(country: unknown): BuyerLocale | null {
  if (typeof country !== 'string') return null;
  const trimmed = country.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase();
    if (SPANISH_COUNTRIES.has(code)) return 'es';
    if (PORTUGUESE_COUNTRIES.has(code)) return 'pt';
    return 'en';
  }
  const byName = COUNTRY_NAMES[normalizeName(trimmed)];
  return byName ?? null;
}

/**
 * `PERFECTPAY_PRODUCT_LOCALES="PPPBXXXXX:es,PPPBYYYYY:en"` soma ou sobrescreve o
 * mapa padrão. Entrada mal formada é ignorada (nunca derruba o webhook).
 */
export function parseProductLocales(raw: string | null | undefined): Record<string, BuyerLocale> {
  const out: Record<string, BuyerLocale> = {};
  if (typeof raw !== 'string') return out;
  for (const pair of raw.split(',')) {
    const [code, locale] = pair.split(':').map((s) => s.trim());
    if (!code || !locale) continue;
    const lower = locale.toLowerCase();
    if (lower !== 'en' && lower !== 'es' && lower !== 'pt') continue;
    out[code.toUpperCase()] = lower;
  }
  return out;
}

/** Idioma do comprador a partir do postback da Perfect Pay. */
export function resolvePerfectpayBuyerLocale(
  payload: any,
  productLocales: Readonly<Record<string, BuyerLocale>> = DEFAULT_PERFECTPAY_PRODUCT_LOCALES,
): BuyerLocale {
  const rawCode = payload?.product?.code ?? payload?.product_code ?? null;
  if (typeof rawCode === 'string' || typeof rawCode === 'number') {
    const code = String(rawCode).trim().toUpperCase();
    const byProduct = code ? productLocales[code] : undefined;
    if (byProduct) return byProduct;
  }

  const countryCandidates: unknown[] = [
    payload?.customer?.country,
    payload?.customer?.country_code,
    payload?.customer?.country_iso,
    payload?.customer?.address?.country,
    payload?.customer?.address?.country_code,
    payload?.customer?.address?.country_iso,
    payload?.buyer?.country,
  ];
  for (const candidate of countryCandidates) {
    const byCountry = localeFromCountry(candidate);
    if (byCountry) return byCountry;
  }

  const currency =
    typeof payload?.currency_enum_key === 'string'
      ? payload.currency_enum_key.trim().toUpperCase()
      : '';
  if (currency === 'BRL') return 'pt';

  return 'en';
}
