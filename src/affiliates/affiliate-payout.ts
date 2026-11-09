/**
 * Como o afiliado recebe a comissão.
 *   PIX            → chave Pix (Brasil), como sempre;
 *   PAYPAL / WISE  → e-mail da conta, para quem está fora do Brasil.
 * Corpo sem `payoutMethod` é o formato antigo e vale como PIX.
 * Trocar de forma limpa os dados da outra: nunca ficam duas formas gravadas.
 */
export const PAYOUT_METHODS = ['PIX', 'PAYPAL', 'WISE'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export const PIX_KEY_TYPES = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM'] as const;
export type PayoutPixKeyType = (typeof PIX_KEY_TYPES)[number];

export const PIX_KEY_MAX_LENGTH = 140;
export const PAYOUT_EMAIL_MAX_LENGTH = 254;

/** Percentual do afiliado que se cadastra sozinho quando a env não diz outro. */
export const SELF_SERVICE_DEFAULT_COMMISSION_PERCENT = 20;
export const SELF_SERVICE_MAX_COMMISSION_PERCENT = 50;

export interface PayoutInput {
  payoutMethod?: string | null;
  pixKeyType?: string | null;
  pixKey?: string | null;
  payoutEmail?: string | null;
}

export interface PayoutData {
  payoutMethod: PayoutMethod;
  payoutEmail: string | null;
  pixKey: string | null;
  pixKeyType: PayoutPixKeyType | null;
}

export type PayoutResolution = { ok: true; data: PayoutData } | { ok: false; reason: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isPixPayoutMethod(payoutMethod: string | null | undefined): boolean {
  return payoutMethod === undefined || payoutMethod === null || payoutMethod === 'PIX';
}

export function resolvePayout(input: PayoutInput): PayoutResolution {
  const method = input.payoutMethod ?? 'PIX';
  if (!(PAYOUT_METHODS as readonly string[]).includes(method)) {
    return { ok: false, reason: 'Forma de recebimento inválida: use PIX, PAYPAL ou WISE' };
  }

  if (method === 'PIX') {
    const pixKey = typeof input.pixKey === 'string' ? input.pixKey.trim() : '';
    const pixKeyType = input.pixKeyType ?? '';
    if (!(PIX_KEY_TYPES as readonly string[]).includes(pixKeyType)) {
      return { ok: false, reason: 'Tipo de chave Pix inválido' };
    }
    if (!pixKey || pixKey.length > PIX_KEY_MAX_LENGTH) {
      return { ok: false, reason: 'Informe a chave Pix' };
    }
    return {
      ok: true,
      data: { payoutMethod: 'PIX', payoutEmail: null, pixKey, pixKeyType: pixKeyType as PayoutPixKeyType },
    };
  }

  const payoutEmail = typeof input.payoutEmail === 'string' ? input.payoutEmail.trim().toLowerCase() : '';
  if (!payoutEmail || payoutEmail.length > PAYOUT_EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(payoutEmail)) {
    return { ok: false, reason: 'Informe o e-mail da conta PayPal ou Wise' };
  }
  return {
    ok: true,
    data: { payoutMethod: method as PayoutMethod, payoutEmail, pixKey: null, pixKeyType: null },
  };
}

/**
 * Percentual de quem vira afiliado pelo próprio painel: env AFFILIATE_SELF_SERVICE_PERCENT,
 * inteiro de 1 a 50. Vazia ou inválida = 20, o de sempre.
 */
export function resolveSelfServiceCommissionPercent(raw: string | undefined | null): number {
  const value = (raw ?? '').trim();
  if (!/^\d{1,2}$/.test(value)) return SELF_SERVICE_DEFAULT_COMMISSION_PERCENT;

  const percent = Number.parseInt(value, 10);
  if (percent < 1 || percent > SELF_SERVICE_MAX_COMMISSION_PERCENT) {
    return SELF_SERVICE_DEFAULT_COMMISSION_PERCENT;
  }
  return percent;
}

/** Texto do destino do pagamento no e-mail ao afiliado. */
export function describePayoutDestination(payoutMethod: string | null | undefined): string {
  if (payoutMethod === 'PAYPAL') return 'sua conta PayPal cadastrada';
  if (payoutMethod === 'WISE') return 'sua conta Wise cadastrada';
  return 'sua chave Pix cadastrada';
}
