import { createHash, createHmac } from 'crypto';

/** Sem 0/O e 1/I/L: o código é ditado e digitado à mão. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REFERRAL_CODE_LENGTH = 8;

const CODE_PATTERN = /^[A-Z0-9_-]{4,50}$/;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
/** No Yahoo o `-` cria endereço descartável (`base-palavra@`); nome de usuário de lá não tem hífen. */
const YAHOO_DOMAINS = new Set([
  'yahoo.com', 'yahoo.com.br', 'yahoo.es', 'yahoo.com.mx', 'yahoo.com.ar', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
]);

/** Provedores públicos: muita gente diferente usa o mesmo domínio, então ele não diz nada. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.br', 'hotmail.es', 'hotmail.co.uk', 'outlook.com',
  'outlook.com.br', 'outlook.es', 'live.com', 'live.com.mx', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'zoho.com', 'yandex.com',
  'yandex.ru', 'mail.ru', 'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com', 'globomail.com',
  'r7.com', 'libero.it', 'web.de', 't-online.de', 'orange.fr', 'free.fr', 'laposte.net', 'qq.com', '163.com',
  ...YAHOO_DOMAINS,
]);

/** Caixas temporárias mais usadas para farm de conta. Lista curta de propósito: a contenção real são os tetos. */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'sharklasers.com', 'grr.la', 'pokemail.net', 'spam4.me', '10minutemail.com', '10minutemail.net', 'temp-mail.org',
  'temp-mail.io', 'tempmail.com', 'tempmailo.com', 'tempmail.dev', 'tempmail.plus', 'yopmail.com', 'yopmail.fr',
  'yopmail.net', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email', 'maildrop.cc', 'dispostable.com',
  'emailondeck.com', 'mohmal.com', 'mintemail.com', 'throwawaymail.com', 'fakeinbox.com', 'mailnesia.com',
  'mailcatch.com', 'spamgourmet.com', 'tempinbox.com', 'moakt.com', 'tmail.ws', 'tempr.email', 'discard.email',
  'mail.tm', 'mail.gw', 'inboxkitten.com', 'burnermail.io', 'mytemp.email', 'emailfake.com', 'crazymailing.com',
  '1secmail.com', '1secmail.org', '1secmail.net', 'minuteinbox.com', 'mailpoof.com', 'tmpmail.org', 'tmpmail.net',
  'dropmail.me', 'mailto.plus', 'fexpost.com', 'fexbox.org', 'emltmp.com', 'tmpbox.net', 'luxusmail.org',
]);

const STRICT_INT = /^\d{1,9}$/;

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
 * Inteiro não negativo escrito por gente (app_settings/env). Só dígitos: `-1`, `2OO`, `1e3` ou vazio viram null,
 * para o chamador desligar em vez de cair num padrão por engano.
 */
export function parseStrictInt(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  return STRICT_INT.test(text) ? Number(text) : null;
}

function splitEmail(email: string | null | undefined): { local: string; domain: string } | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  return { local: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
}

/**
 * E-mail normalizado para achar contas do mesmo dono: sem `+tag`, no Gmail sem pontos
 * (`fu.lano+2@gmail.com` = `fulano@googlemail.com`) e no Yahoo sem o `-palavra` do endereço descartável.
 */
export function normalizeEmailForFingerprint(email: string | null | undefined): string | null {
  const parts = splitEmail(email);
  if (!parts) return null;
  let { local, domain } = parts;
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  if (YAHOO_DOMAINS.has(domain)) {
    const dash = local.indexOf('-');
    if (dash >= 0) local = local.slice(0, dash);
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

/** sha256 do e-mail normalizado: compara sem guardar o e-mail de novo. */
export function emailFingerprint(email: string | null | undefined): string | null {
  const normalized = normalizeEmailForFingerprint(email);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

/**
 * sha256 do domínio quando ele é próprio (não é provedor público). Muitas contas do mesmo indicador num domínio
 * próprio é o sinal do farm por catch-all, em que cada endereço é diferente mas tudo cai na mesma caixa.
 */
export function emailDomainKey(email: string | null | undefined): string | null {
  const parts = splitEmail(email);
  if (!parts || PUBLIC_EMAIL_DOMAINS.has(parts.domain)) return null;
  return createHash('sha256').update(parts.domain).digest('hex');
}

/** E-mail de caixa temporária (o domínio ou um subdomínio dele está na lista). */
export function isDisposableEmail(email: string | null | undefined): boolean {
  const parts = splitEmail(email);
  if (!parts) return false;
  const labels = parts.domain.split('.');
  for (let index = 0; index < labels.length - 1; index += 1) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(index).join('.'))) return true;
  }
  return false;
}

/**
 * IPv6 vira o prefixo /64: no celular o fim do endereço muda o tempo todo, mas o /64 é da mesma linha.
 * Endereço que não dá para ler direito devolve null (a regra de IP não age, nunca acusa por engano).
 */
export function ipv6Prefix64(ip: string): string | null {
  const clean = ip.split('%')[0];
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const tail = halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** HMAC do IP do cadastro (IPv6 pelo /64). Sem IP utilizável, null (a regra de IP simplesmente não age). */
export function hashSignupIp(ip: string | null | undefined, salt: string): string | null {
  if (typeof ip !== 'string') return null;
  const trimmed = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!trimmed || trimmed === 'unknown') return null;
  let key: string | null = trimmed;
  if (trimmed.includes(':')) key = ipv6Prefix64(trimmed);
  else if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) key = null;
  return key ? createHmac('sha256', salt).update(key).digest('hex') : null;
}

/**
 * Nome que quem indicou vê. Primeiro nome quando parece nome de verdade; senão só a inicial
 * (conta Google sem nome de exibição fica com a parte local do e-mail, e isso não pode vazar).
 */
export function displayFirstName(name: string | null | undefined): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  if (/^\p{L}[\p{L}'’-]{1,19}$/u.test(first)) return first;
  const initial = [...first].find((char) => /\p{L}/u.test(char));
  return initial ? `${initial.toUpperCase()}•••` : '';
}
