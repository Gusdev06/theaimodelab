/**
 * Segundo nível do programa de afiliados.
 *
 * O afiliado que trouxe outro afiliado (o "pai") recebe uma fatia de cada comissão
 * que o filho ganhar. A fatia é paga pela casa, não sai da comissão do filho, e só
 * sobe UM nível (o avô não recebe).
 *
 * Padrão = comportamento de sempre: desligado. A env `AFFILIATE_SECOND_LEVEL_PERCENT`
 * liga sem deploy de código:
 *   - vazia, `0`, negativa ou inválida → desligado;
 *   - decimal de 0 a 20 (ponto como separador) → percentual da comissão direta;
 *   - acima de 20 → vale 20.
 */
export const AFFILIATE_SECOND_LEVEL_MAX_PERCENT = 20;

/** Níveis gravados em `AffiliateEarning.level`; comissão antiga sem nível conta como direta. */
export const AFFILIATE_EARNING_LEVEL_DIRECT = 1;
export const AFFILIATE_EARNING_LEVEL_PARENT = 2;

/** Percentual do segundo nível; 0 = desligado. */
export function resolveSecondLevelPercent(raw: string | undefined | null): number {
  const value = (raw ?? '').trim();
  if (!value) return 0;
  if (!/^\d+(\.\d+)?$/.test(value)) return 0;

  const percent = Number.parseFloat(value);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(percent, AFFILIATE_SECOND_LEVEL_MAX_PERCENT);
}

/** Fatia do pai sobre a comissão direta do filho, em centavos (0 = nada a gravar). */
export function computeSecondLevelCommissionCents(directCommissionCents: number, percent: number): number {
  if (percent <= 0 || directCommissionCents <= 0) return 0;
  return Math.max(0, Math.round((directCommissionCents * percent) / 100));
}
