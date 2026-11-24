/**
 * Nome da cobrança na fatura do cartão (candy-retencao, L17, 24/11/2026).
 *
 * Molde: a Candy escreve no checkout "Charge shown as "EverAI" on your bank statement" (candy.ai/subscriptions,
 * 24/11/2026). Quem não reconhece o nome na fatura liga para o banco e abre disputa (a nossa está em 0,8%, meta < 0,5%,
 * TKT-353). O texto só aparece quando o nome real está configurado: sem env = nada muda.
 *
 * - BILLING_DESCRIPTOR_PERFECTPAY (ou BILLING_DESCRIPTOR): o que a Perfect Pay imprime na fatura (US$).
 * - BILLING_DESCRIPTOR_CAKTO: o que a Cakto imprime (R$).
 * O valor tem de ser conferido no extrato de uma compra real antes de ligar (passo 1 da spec).
 */

type EnvLike = Record<string, string | undefined>;

/** Só letras, números, espaço e * . - _ (o que os adquirentes imprimem), até 40 caracteres. */
export function sanitizeDescriptor(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!value || value.length > 40) return null;
  return /^[A-Za-z0-9 *._-]+$/.test(value) ? value : null;
}

export function billingDescriptorFor(provider: string | null | undefined, env: EnvLike = process.env): string | null {
  const key = (provider ?? '').trim().toLowerCase();
  if (key === 'cakto') return sanitizeDescriptor(env.BILLING_DESCRIPTOR_CAKTO);
  if (key === 'perfectpay' || key === '') {
    return sanitizeDescriptor(env.BILLING_DESCRIPTOR_PERFECTPAY ?? env.BILLING_DESCRIPTOR);
  }
  return null;
}

export type DescriptorLocale = 'pt-BR' | 'es' | 'en';

/** Frase do nome na fatura, nos 3 idiomas (texto da spec L17). */
export function descriptorSentence(locale: DescriptorLocale, descriptor: string): string {
  if (locale === 'pt-BR') return `A cobrança aparece na fatura como ${descriptor}.`;
  if (locale === 'es') return `El cobro aparece en tu estado de cuenta como ${descriptor}.`;
  return `The charge shows on your statement as ${descriptor}.`;
}
