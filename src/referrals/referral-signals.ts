import { createHash, createHmac } from 'crypto';

/** Sem 0/O e 1/I/L: o código é ditado e digitado à mão. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REFERRAL_CODE_LENGTH = 8;

const CODE_PATTERN = /^[A-Z0-9_-]{4,50}$/;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Código como vem do link/cadastro → forma canônica, ou null se não pode ser um código. */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** Gera um código a partir de bytes aleatórios (injetados para o teste ser determinístico). */
export function generateReferralCode(bytes: Uint8Array): string {
  if (bytes.length < REFERRAL_CODE_LENGTH) {
    throw new Error(`generateReferralCode precisa de ${REFERRAL_CODE_LENGTH} bytes`);
  }
  let code = '';
  for (let index = 0; index < REFERRAL_CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * E-mail normalizado para achar contas do mesmo dono: sem `+tag` e, no Gmail, sem pontos
 * (`fu.lano+2@gmail.com` e `fulano@googlemail.com` caem na mesma caixa).
 */
export function normalizeEmailForFingerprint(email: string | null | undefined): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

/** sha256 do e-mail normalizado: compara sem guardar o e-mail de novo. */
export function emailFingerprint(email: string | null | undefined): string | null {
  const normalized = normalizeEmailForFingerprint(email);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

/** HMAC do IP do cadastro. Sem IP utilizável, null (a regra de IP simplesmente não age). */
export function hashSignupIp(ip: string | null | undefined, salt: string): string | null {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  if (!trimmed || trimmed === 'unknown') return null;
  return createHmac('sha256', salt).update(trimmed).digest('hex');
}
