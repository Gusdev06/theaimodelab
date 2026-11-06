/**
 * Ponte Pack → plataforma: quem vendeu a isca (Pack) na Perfect Pay como AFILIADO
 * fica com o cliente quando ele cria a conta na plataforma.
 *
 * Este arquivo só LÊ o postback. O formato do afiliado no postback ainda é hipótese
 * (documentação da Perfect Pay, sem venda real conferida), por isso o leitor aceita
 * vários formatos, nunca lança e devolve null na dúvida:
 *   1. `commission[]` / `commissions[]` (lista, objeto único ou objeto de objetos): a linha
 *      com `affiliation_type_enum` 5 (affiliate). Tipos 0 plataforma, 1 produtor,
 *      2 coprodutor, 3 gerente de afiliados, 4 parceiro, 6 premium e 7 fornecedor ficam de
 *      fora. Linha SEM tipo só conta quando PERFECTPAY_OWN_ACCOUNT_EMAILS diz quais são
 *      as contas próprias (senão não dá para separar produtor de afiliado).
 *   2. `affiliate` / `affiliation` no topo (texto ou objeto).
 *   3. `metadata.src` / `metadata.utm_content` com `convite:CODIGO` ou `aff:CODIGO`
 *      (código de afiliado da PLATAFORMA posto no link do checkout).
 * E-mail de conta própria (produtor/coprodutor) nunca vira afiliado.
 */
export interface PerfectpayAffiliateRef {
  /** E-mail do afiliado na Perfect Pay. */
  email?: string;
  /** Código do link (`convite:`/`aff:`) ou, na falta dele, o `affiliation_code` da Perfect Pay. */
  code?: string;
}

export type DecodedAffiliateRef = { kind: 'email' | 'code'; value: string };

const PERFECTPAY_AFFILIATE_TYPE_ENUM = 5;
const AFFILIATE_TYPE_NAMES = new Set(['affiliate', 'afiliado']);
const EMAIL_SHAPE = /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/;
const CODE_SHAPE = /^[A-Z0-9_-]{2,40}$/;
const LINK_CODE = /(?:^|[\s|,;+&])(?:convite|aff):([A-Za-z0-9_-]{2,40})(?=$|[\s|,;+&])/i;

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

export function isPackAffiliateBridgeEnabled(raw: string | undefined | null): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
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

function commissionEntries(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];

  const looksLikeEntry = [
    'affiliation_email',
    'email',
    'affiliation_code',
    'affiliation_type_enum',
    'affiliation_type',
    'commission_amount',
  ].some((key) => key in value);
  return looksLikeEntry ? [value] : Object.values(value).filter(isRecord);
}

function entryRole(entry: UnknownRecord): 'affiliate' | 'other' | 'unknown' {
  for (const key of ['affiliation_type_enum', 'affiliation_type', 'type_enum', 'type']) {
    const raw = entry[key];
    if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
      return Number(raw) === PERFECTPAY_AFFILIATE_TYPE_ENUM ? 'affiliate' : 'other';
    }
  }
  for (const key of ['affiliation_type_enum_key', 'affiliation_type', 'type', 'role']) {
    const raw = entry[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return AFFILIATE_TYPE_NAMES.has(raw.trim().toLowerCase()) ? 'affiliate' : 'other';
    }
  }
  return 'unknown';
}

function fromCommissions(payload: UnknownRecord, ownEmails: Set<string>): PerfectpayAffiliateRef | null {
  const entries = [...commissionEntries(payload.commission), ...commissionEntries(payload.commissions)];
  let untyped: PerfectpayAffiliateRef | null = null;

  for (const entry of entries) {
    const role = entryRole(entry);
    if (role === 'other') continue;

    const email = normalizeEmail(entry.affiliation_email) ?? normalizeEmail(entry.email);
    if (email && ownEmails.has(email)) continue;
    const code = normalizeCode(entry.affiliation_code);

    if (role === 'affiliate' && (email || code)) {
      return { ...(email && { email }), ...(code && { code }) };
    }
    // Linha sem tipo: só com e-mail, e só quando sabemos quais são as contas próprias.
    if (role === 'unknown' && email && ownEmails.size > 0 && !untyped) {
      untyped = { email, ...(code && { code }) };
    }
  }
  return untyped;
}

function fromAffiliateNode(payload: UnknownRecord, ownEmails: Set<string>): PerfectpayAffiliateRef | null {
  for (const node of [payload.affiliate, payload.affiliation]) {
    if (typeof node === 'string') {
      const email = normalizeEmail(node);
      if (email) {
        if (!ownEmails.has(email)) return { email };
        continue;
      }
      const code = normalizeCode(node);
      if (code) return { code };
      continue;
    }
    if (!isRecord(node)) continue;

    const email = normalizeEmail(node.affiliation_email) ?? normalizeEmail(node.email);
    if (email && ownEmails.has(email)) continue;
    const code = normalizeCode(node.affiliation_code) ?? normalizeCode(node.code);
    if (email || code) return { ...(email && { email }), ...(code && { code }) };
  }
  return null;
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
  ownEmails: Iterable<string> = [],
): PerfectpayAffiliateRef | null {
  try {
    if (!isRecord(payload)) return null;
    const own = new Set<string>();
    for (const email of ownEmails) {
      if (typeof email === 'string' && email.trim()) own.add(email.trim().toLowerCase());
    }

    const seller = fromCommissions(payload, own) ?? fromAffiliateNode(payload, own);
    // O código do link é da plataforma: vale mais que o `affiliation_code` da Perfect Pay.
    const code = linkCode(payload) ?? seller?.code;
    const email = seller?.email;

    if (!email && !code) return null;
    return { ...(email && { email }), ...(code && { code }) };
  } catch {
    return null;
  }
}

/** Texto gravado na grant: `email:<e-mail>` (afiliado identificado pela Perfect Pay) ou `code:<CODIGO>`. */
export function encodeAffiliateRef(ref: PerfectpayAffiliateRef | null | undefined): string | null {
  if (ref?.email) return `email:${ref.email}`;
  if (ref?.code) return `code:${ref.code}`;
  return null;
}

export function decodeAffiliateRef(raw: string | null | undefined): DecodedAffiliateRef | null {
  if (typeof raw !== 'string') return null;
  const separatorIndex = raw.indexOf(':');
  if (separatorIndex <= 0) return null;

  const kind = raw.slice(0, separatorIndex);
  const value = raw.slice(separatorIndex + 1);
  if (kind === 'email') {
    const email = normalizeEmail(value);
    return email ? { kind, value: email } : null;
  }
  if (kind === 'code') {
    const code = normalizeCode(value);
    return code ? { kind, value: code } : null;
  }
  return null;
}
