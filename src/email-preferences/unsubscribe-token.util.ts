import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Token stateless de descadastro: HMAC-SHA256(email_normalizado, secret).
 * Não precisa armazenar nada por usuário — o link é auto-verificável e não
 * enumerável (quem não tem o secret não consegue forjar o token de um email).
 */
export function signUnsubscribe(email: string, secret: string): string {
  const normalized = email.trim().toLowerCase();
  return createHmac('sha256', secret).update(normalized).digest('hex');
}

export function verifyUnsubscribe(
  email: string,
  token: string,
  secret: string,
): boolean {
  const expected = signUnsubscribe(email, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(token || '', 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
