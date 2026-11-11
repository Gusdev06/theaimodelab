/**
 * O que o resgate de quarta entrega.
 *
 * Até 03/11/2026 eram 4 gerações grátis do THEAIMODELAB_FAST (Veo 3.1 Fast no provedor próprio), um modelo que está
 * desligado: em 30 dias ninguém resgatou. Agora o padrão é crédito de bônus, que vale em qualquer modelo na hora.
 *
 * `WEEKLY_CLAIM_CREDITS` (env, opcional) troca o valor sem deploy: número inteiro de créditos (padrão 300, teto
 * 5.000). `0` volta ao bônus antigo de 4 gerações grátis.
 */
export const DEFAULT_WEEKLY_CLAIM_CREDITS = 300;
export const MAX_WEEKLY_CLAIM_CREDITS = 5_000;
/** bônus antigo: gerações grátis do THEAIMODELAB_FAST (não acumulam entre semanas) */
export const LEGACY_WEEKLY_FREE_GENERATIONS = 4;

export type WeeklyRewardKind = 'credits' | 'free_generations';

export interface WeeklyReward {
  kind: WeeklyRewardKind;
  amount: number;
}

/** Lê a env: vazio ou inválido = padrão; 0 = bônus antigo; acima do teto = teto. */
export function resolveWeeklyReward(raw: string | undefined | null): WeeklyReward {
  const text = (raw ?? '').trim();
  if (!text) return { kind: 'credits', amount: DEFAULT_WEEKLY_CLAIM_CREDITS };
  if (!/^\d+$/.test(text)) return { kind: 'credits', amount: DEFAULT_WEEKLY_CLAIM_CREDITS };
  const value = Number(text);
  if (value === 0) return { kind: 'free_generations', amount: LEGACY_WEEKLY_FREE_GENERATIONS };
  return { kind: 'credits', amount: Math.min(value, MAX_WEEKLY_CLAIM_CREDITS) };
}
