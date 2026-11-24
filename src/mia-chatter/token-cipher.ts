import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Cifra dos tokens da Fanvue de cada cliente (AES-256-GCM). O banco guarda só `v1:<iv>:<tag>:<texto cifrado>` em
 * base64url; sem a chave (MIA_CHATTER_TOKEN_KEY, fora do banco e do repo) ninguém fala em nome da cliente.
 */
const VERSION = 'v1';
const IV_BYTES = 12;

/** Aceita 32 bytes em base64/base64url ou 64 caracteres hex. Qualquer outra coisa = null (conexão fica desligada). */
export function parseTokenKey(raw: string | null | undefined): Buffer | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch {
    return null;
  }
}

export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

/** Devolve null quando o texto foi adulterado, a chave mudou ou o formato não é o nosso (nunca lança). */
export function decryptToken(sealed: string | null | undefined, key: Buffer): string | null {
  if (!sealed) return null;
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** PKCE (RFC 7636): verificador aleatório e o desafio S256 que vai na URL de autorização. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomState(): string {
  return randomBytes(24).toString('base64url');
}
