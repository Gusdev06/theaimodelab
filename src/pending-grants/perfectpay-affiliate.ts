/**
 * Ponte Pack → plataforma: quem vendeu a isca (Pack) na Perfect Pay como AFILIADO
 * fica com o cliente quando ele cria a conta na plataforma.
 *
 * Este arquivo só LÊ o postback, no formato da documentação da Perfect Pay; nunca lança
 * e devolve null na dúvida:
 *   - `commission` é uma lista, um item por participante da venda:
 *     `{ affiliation_code, affiliation_type_enum, name, email, identification_number, commission_amount }`.
 *     Tipos: 0 plataforma, 1 produtor, 2 coprodutor, 3 gerente de afiliados, 4 parceiro,
 *     5 afiliado, 6 premium, 7 fornecedor. SÓ o tipo 5 conta; linha sem tipo não conta.
 *     O e-mail pode vir ofuscado (com `*`): aí só o `affiliation_code` identifica o afiliado.
 *   - `metadata.src` / `metadata.utm_content` com `convite:CODIGO` ou `aff:CODIGO`: código de
 *     afiliado da PLATAFORMA posto no link do checkout. Quem monta o link controla esse
 *     texto, então ele só vale com `allowLinkCodes` (env PACK_AFFILIATE_BRIDGE_LINK_CODES)
 *     e apenas em venda SEM afiliado tipo 5.
 *
 * Dois espaços de nomes que nunca se misturam:
 *   - `ppcode:` = `affiliation_code` da Perfect Pay. Casa só com `Affiliate.perfectpayAffiliateCode`.
 *   - `code:`   = código da plataforma (`Affiliate.code`), vindo do link.
 * E-mail de conta própria (PERFECTPAY_OWN_ACCOUNT_EMAILS) nunca vira afiliado.
 */
export interface PerfectpayAffiliateRef {
  /** `affiliation_code` do afiliado na Perfect Pay. */
  perfectpayCode?: string;
  /** E-mail do afiliado na Perfect Pay, quando não veio ofuscado. */
  email?: string;
  /** Código de afiliado da plataforma posto no link (`convite:`/`aff:`). */
  linkCode?: string;
}

export type AffiliateRefKind = 'ppcode' | 'email' | 'code';
export type DecodedAffiliateRef = { kind: AffiliateRefKind; value: string };

export interface ExtractAffiliateRefOptions {
  /** E-mails das contas próprias na Perfect Pay (produtor/coprodutor). */
  ownEmails?: Iterable<string>;
  /** Aceita o código do link (`convite:CODIGO`). Desligado por padrão. */
  allowLinkCodes?: boolean;
}

const PERFECTPAY_AFFILIATE_TYPE_ENUM = 5;
// Sem `|` no e-mail: é o separador das partes da referência gravada na isca.
const EMAIL_SHAPE = /^[^\s@*|]+@[^\s@*|]+\.[^\s@*|]+$/;
const CODE_SHAPE = /^[A-Z0-9_-]{2,40}$/;
const LINK_CODE = /(?:^|[\s|,;+&])(?:convite|aff):([A-Za-z0-9_-]{2,40})(?=$|[\s|,;+&])/i;
const REF_SEPARATOR = '|';
const REF_KIND_ORDER: AffiliateRefKind[] = ['ppcode', 'email', 'code'];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  // E-mail ofuscado (us***@dominio) não identifica ninguém.
  return email.length <= 254 && EMAIL_SHAPE.test(email) ? email : undefined;
}

function normalizeCode(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const code = String(value).trim().toUpperCase();
  return CODE_SHAPE.test(code) ? code : undefined;
}

function isEnvTrue(raw: string | undefined | null): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

export function isPackAffiliateBridgeEnabled(raw: string | undefined | null): boolean {
  return isEnvTrue(raw);
}

/** PACK_AFFILIATE_BRIDGE_LINK_CODES: aceita `convite:CODIGO` do link do checkout. Padrão desligado. */
export function isPackBridgeLinkCodesEnabled(raw: string | undefined | null): boolean {
  return isEnvTrue(raw);
}

/** PERFECTPAY_OWN_ACCOUNT_EMAILS: e-mails das contas próprias na Perfect Pay, por vírgula. */
export function parseOwnAccountEmails(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * PERFECTPAY_PACK_PRODUCTS: `product.code` dos Packs que entram na ponte, por vírgula.
 * Env vazia = qualquer produto de isca entra; com a lista, só os que estão nela.
 */
export function isPackProductAllowed(productCode: unknown, rawProducts: string | undefined | null): boolean {
  const allowed = (rawProducts ?? '')
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);
  if (allowed.length === 0) return true;
  if (typeof productCode !== 'string' && typeof productCode !== 'number') return false;
  return allowed.includes(String(productCode).trim().toUpperCase());
}

function commissionEntries(payload: UnknownRecord): UnknownRecord[] {
  const value = payload.commission;
  if (Array.isArray(value)) return value.filter(isRecord);
  // Um participante só pode chegar como objeto solto em vez de lista de um item.
  return isRecord(value) ? [value] : [];
}

function isAffiliateEntry(entry: UnknownRecord): boolean {
  const raw = entry.affiliation_type_enum;
  if (typeof raw === 'number') return raw === PERFECTPAY_AFFILIATE_TYPE_ENUM;
  return typeof raw === 'string' && raw.trim() === String(PERFECTPAY_AFFILIATE_TYPE_ENUM);
}

function linkCode(payload: UnknownRecord): string | undefined {
  const metadata = payload.metadata;
  if (!isRecord(metadata)) return undefined;
  for (const field of [metadata.src, metadata.utm_content]) {
    if (typeof field !== 'string') continue;
    const match = LINK_CODE.exec(field);
    if (match) return match[1].toUpperCase();
  }
  return undefined;
}

export function extractPerfectpayAffiliateRef(
  payload: unknown,
  options: ExtractAffiliateRefOptions = {},
): PerfectpayAffiliateRef | null {
  try {
    if (!isRecord(payload)) return null;
    const own = new Set<string>();
    for (const email of options.ownEmails ?? []) {
      if (typeof email === 'string' && email.trim()) own.add(email.trim().toLowerCase());
    }

    const affiliateEntries = commissionEntries(payload).filter(isAffiliateEntry);
    for (const entry of affiliateEntries) {
      const email = normalizeEmail(entry.email);
      if (email && own.has(email)) continue;
      const perfectpayCode = normalizeCode(entry.affiliation_code);
      if (email || perfectpayCode) {
        return { ...(perfectpayCode && { perfectpayCode }), ...(email && { email }) };
      }
    }

    // Venda com afiliado da Perfect Pay (mesmo que seja conta própria): o link não manda.
    if (affiliateEntries.length > 0 || !options.allowLinkCodes) return null;
    const code = linkCode(payload);
    return code ? { linkCode: code } : null;
  } catch {
    return null;
  }
}

/**
 * Texto gravado na isca (`affiliateRef`), partes separadas por `|`:
 *   - venda de afiliado da Perfect Pay: `ppcode:<CODIGO>`, `email:<e-mail>` ou `ppcode:<CODIGO>|email:<e-mail>`;
 *   - venda sem afiliado, com código no link: `code:<CODIGO DA PLATAFORMA>`.
 */
export function encodeAffiliateRef(ref: PerfectpayAffiliateRef | null | undefined): string | null {
  const parts: string[] = [];
  if (ref?.perfectpayCode) parts.push(`ppcode:${ref.perfectpayCode}`);
  if (ref?.email) parts.push(`email:${ref.email}`);
  if (parts.length === 0 && ref?.linkCode) parts.push(`code:${ref.linkCode}`);
  return parts.length > 0 ? parts.join(REF_SEPARATOR) : null;
}

/** Partes válidas da referência, na ordem em que a resolução tenta: `ppcode`, `email`, `code`. */
export function decodeAffiliateRef(raw: string | null | undefined): DecodedAffiliateRef[] {
  if (typeof raw !== 'string') return [];

  const decoded: DecodedAffiliateRef[] = [];
  for (const part of raw.split(REF_SEPARATOR)) {
    const separatorIndex = part.indexOf(':');
    if (separatorIndex <= 0) continue;

    const kind = part.slice(0, separatorIndex);
    const rawValue = part.slice(separatorIndex + 1);
    const value =
      kind === 'email' ? normalizeEmail(rawValue) : kind === 'ppcode' || kind === 'code' ? normalizeCode(rawValue) : undefined;
    if (value && !decoded.some((item) => item.kind === kind)) {
      decoded.push({ kind: kind as AffiliateRefKind, value });
    }
  }
  return decoded.sort((a, b) => REF_KIND_ORDER.indexOf(a.kind) - REF_KIND_ORDER.indexOf(b.kind));
}
