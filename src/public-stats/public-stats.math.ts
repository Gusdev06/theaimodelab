/**
 * Números reais da prova social (L14, molde Candy "Aprovado por 50M de usuários"), sempre ARREDONDADOS PARA BAIXO:
 * nunca mostramos mais do que existe.
 */

/** Pisos: abaixo deles o número sai null e a tela fica com o texto de hoje (molde fetchSocialProof, piso 50). */
export const PUBLIC_STATS_FLOORS = Object.freeze({
  accounts: 1000,
  generations: 1000,
  payingCreators: 100,
});

/** Validade do cache em memória e do Cache-Control (1 h). */
export const PUBLIC_STATS_TTL_MS = 60 * 60 * 1000;

/**
 * Arredonda para baixo em 2 algarismos significativos: 12.345 → 12.000; 1.534 → 1.500; 987 → 980;
 * 1.234.567 → 1.200.000. Valor inválido ou negativo → 0.
 */
export function floorToTwoSignificant(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const whole = Math.floor(value);
  if (whole < 100) return whole;
  const magnitude = 10 ** (Math.floor(Math.log10(whole)) - 1);
  return Math.floor(whole / magnitude) * magnitude;
}

/** Arredonda para baixo e aplica o piso: abaixo do piso = null (a tela cai no texto de hoje). */
export function displayCount(value: number, floor: number): number | null {
  if (!Number.isFinite(value) || value < floor) return null;
  return floorToTwoSignificant(value);
}

export interface PublicStatsRaw {
  accounts: number;
  generations: number;
  payingCreators: number;
}

export interface PublicStats {
  /** contas criadas (arredondado para baixo; null = abaixo do piso) */
  accounts: number | null;
  /** fotos e vídeos concluídos */
  generations: number | null;
  /** contas com pelo menos 1 pagamento concluído */
  payingCreators: number | null;
  /** quando a contagem foi feita (ISO) */
  updatedAt: string;
}

export function toPublicStats(raw: PublicStatsRaw, now: Date): PublicStats {
  return {
    accounts: displayCount(raw.accounts, PUBLIC_STATS_FLOORS.accounts),
    generations: displayCount(raw.generations, PUBLIC_STATS_FLOORS.generations),
    payingCreators: displayCount(raw.payingCreators, PUBLIC_STATS_FLOORS.payingCreators),
    updatedAt: now.toISOString(),
  };
}

/** PUBLIC_STATS_ENABLED: só 'on'/'true'/'1' liga. Padrão desligado. */
export function isPublicStatsEnabled(raw: string | undefined | null): boolean {
  return /^(on|true|1|yes)$/i.test(String(raw ?? '').trim());
}
