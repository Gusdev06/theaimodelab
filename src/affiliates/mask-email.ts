/**
 * E-mail do cliente indicado como o afiliado pode ver: 2 primeiras letras + *** + @domínio
 * (`joana@gmail.com` → `jo***@gmail.com`). Texto sem cara de e-mail vira só `***`.
 */
export function maskEmail(email: string | undefined | null): string {
  const value = (email ?? '').trim();
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) return '***';

  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  return `${localPart.slice(0, 2)}***@${domain}`;
}
