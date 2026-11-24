import { createHash } from 'crypto';

/**
 * Paywall de curiosidade (L02, molde Candy: "Vídeo privado · {nome} gravou um vídeo só para você. Desbloqueie").
 * Variante A (custo zero): mídia 18+ do acervo, borrada, com selo "exemplo da cena". Variante B (vídeo real LTX da
 * modelo dela, US$ 0,20 por conta) é SÓ documentação até a A medir: CURIOSITY_LOCK_REAL_VIDEO_PCT separa o balde
 * pelo hash do userId (molde welcomeAbExtraFor), mas o que se serve continua sendo a A (a B não foi construída).
 * Conta: a B só fecha se ≥ 3,6% de quem vê assinar o Creator (0,20 ÷ 5,56); abaixo disso fica em 0.
 */

/** Até quantas gerações concluídas o card ainda conta como "o 1º resultado" (a contagem pode chegar 1 à frente). */
export const CURIOSITY_LOCK_MAX_COMPLETED = 1;

export type CuriosityAbBucket = 'A' | 'B';

/** Balde do A/B pelo hash do userId. pct inválido, vazio ou ≤ 0 = todo mundo na A. */
export function curiosityAbBucketFor(userId: string, pctRaw?: string | null): CuriosityAbBucket {
  const pct = Number.parseInt(String(pctRaw ?? '').trim(), 10);
  if (!Number.isFinite(pct) || pct <= 0) return 'A';
  const bucket = createHash('sha256').update(`curiosity-lock:${userId}`).digest().readUInt32BE(0) % 100;
  return bucket < Math.min(pct, 100) ? 'B' : 'A';
}

/** Acervo escolhido pelo dono (CURIOSITY_LOCK_MEDIA_URLS, https separados por vírgula). Fora de https = ignorado. */
export function parseCuriosityMediaUrls(raw?: string | null): string[] {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map((url) => url.trim())
    .filter((url) => /^https:\/\/[^\s]+$/i.test(url));
}

/** Uma mídia do acervo por conta, sempre a mesma para a mesma conta (hash do userId). */
export function pickCuriosityMedia(userId: string, urls: readonly string[]): string | null {
  if (urls.length === 0) return null;
  const index = createHash('sha256').update(`curiosity-media:${userId}`).digest().readUInt32BE(0) % urls.length;
  return urls[index];
}

export interface CuriosityEligibilityInput {
  completedGenerations: number;
  everPaid: boolean;
  hasPaidPlan: boolean;
}

/** Só quem nunca pagou, sem plano pago ativo, no 1º resultado concluído. */
export function isCuriosityLockEligible(input: CuriosityEligibilityInput): boolean {
  if (input.everPaid || input.hasPaidPlan) return false;
  return input.completedGenerations >= 1 && input.completedGenerations <= CURIOSITY_LOCK_MAX_COMPLETED;
}
