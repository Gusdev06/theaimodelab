/**
 * Chaves do pacote candy-retencao (24/11/2026). Todas DESLIGADAS por padrão: sem a env, nada muda.
 * - PROACTIVE_MODEL_NUDGE=on: "sua modelo está esperando" (L10), sino com foto + e-mail.
 * - RENEWAL_REMINDER_EMAIL=on: e-mail 3 dias antes da renovação da Perfect Pay/Cakto (L17).
 * - RECOVERY_PP_ENABLED=on: régua D0/D3/D7 da renovação recusada (L04, pending-grants/renewal-decline-recovery).
 */

export function isFlagOn(raw: string | null | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1';
}

export const PROACTIVE_MODEL_NUDGE_ENV = 'PROACTIVE_MODEL_NUDGE';
export const RENEWAL_REMINDER_EMAIL_ENV = 'RENEWAL_REMINDER_EMAIL';

/** Chave da preferência "Receber fotos da minha modelo" desligada (1 linha por conta em email_sequence_logs). */
export const PROACTIVE_OPT_OUT_SEQUENCE = 'proactive_media_pref';
export const PROACTIVE_OPT_OUT_KEY = 'proactive_media:optout';
