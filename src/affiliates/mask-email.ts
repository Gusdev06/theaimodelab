/**
 * E-mail do cliente indicado como o afiliado pode ver: 2 primeiras letras + *** + @domínio
 * (`joana@gmail.com` → `jo***@gmail.com`). Parte local de até 2 caracteres mostra só 1
 * (`ab@x.io` → `a***@x.io`), senão a máscara entregaria o endereço inteiro.
 * Texto sem cara de e-mail vira só `***`.
 */
export function maskEmail(email: string | undefined | null): string {
  const value = (email ?? '').trim();
  const atIndex = value.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) return '***';

  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);
  const visibleLength = localPart.length <= 2 ? 1 : 2;
  return `${localPart.slice(0, visibleLength)}***@${domain}`;
}

/**
 * Nome do cliente indicado como o afiliado pode ver: primeiro nome + inicial do último
 * (`Maria Souza Silva` → `Maria S.`). Nome único fica como está; nome que é um e-mail
 * (cadastro sem nome usa o e-mail) passa pela máscara de e-mail. Vazio vira null.
 */
export function abbreviateCustomerName(name: string | undefined | null): string | null {
  const value = (name ?? '').trim();
  if (!value) return null;
  if (value.includes('@')) return maskEmail(value);

  const parts = value.split(/\s+/);
  if (parts.length === 1) return parts[0];

  const lastInitial = Array.from(parts[parts.length - 1])[0];
  return `${parts[0]} ${lastInitial.toUpperCase()}.`;
}
