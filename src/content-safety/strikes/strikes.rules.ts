import type { Prisma } from '@prisma/client';
import {
  RULES_VERSION,
  SAFETY_STRIKES,
} from '../image-safety/image-safety.config';
import type { ScanVerdict, Strength } from '../image-safety/types';
import {
  ACCOUNT_SUSPENDED_RULE,
  STRIKES_SCANNER,
  type StrikePhoto,
  type SuspensionCause,
} from './strikes.types';

/**
 * Regras puras da camada 6 (sem banco, sem rede): força de um evento, contagem de pontos, limite de novas tentativas
 * com foto, linhas que seguram o resultado da conta suspensa e o motivo gravado na trilha.
 */

const DAY_MS = 24 * 60 * 60_000;
const STRENGTHS: ReadonlySet<string> = new Set([
  'STRONG',
  'MEDIUM',
  'LIGHT',
  'NONE',
]);
const SHA256_FORMAT = /^[0-9a-f]{64}$/;

/** Janela dos pontos médios (90 dias). */
export const MEDIUM_STRIKE_WINDOW_MS =
  SAFETY_STRIKES.mediumStrikeWindowDays * DAY_MS;
/** Janela da repetição por hash na conta (24 h). */
export const REPEAT_WINDOW_MS = SAFETY_STRIKES.repeatWindowHours * 60 * 60_000;
/** Janelas do limite de novas tentativas com foto. */
export const PHOTO_RETRY_SHORT_WINDOW_MS = 10 * 60_000;
export const PHOTO_RETRY_LONG_WINDOW_MS = DAY_MS;

/** Força gravada no `match` do evento ("E2/STRONG", "T_CLASSIFIER/MEDIUM", "E7:E3a/MEDIUM"). Sem força = null. */
export function strengthOfMatch(
  match: string | null | undefined,
): Strength | null {
  if (typeof match !== 'string') return null;
  const suffix = match.slice(match.lastIndexOf('/') + 1);
  return match.includes('/') && STRENGTHS.has(suffix)
    ? (suffix as Strength)
    : null;
}

/**
 * Pontos médios: uma tentativa (geração) conta uma vez, mesmo com mais de um evento médio (entrada segurada e depois
 * confirmada, nova tentativa da fila). Evento sem geração (rota sem fila) conta sozinho. `unrecordedSignal` = o evento
 * deste sinal não chegou a ser gravado: conta assim mesmo.
 */
export function countMediumPoints(
  events: ReadonlyArray<{ id: string; generationId: string | null }>,
  unrecordedSignal: boolean,
): number {
  const attempts = new Set(
    events.map((event) => event.generationId ?? `event:${event.id}`),
  );
  return attempts.size + (unrecordedSignal ? 1 : 0);
}

/** Fotos que entram na repetição: só com hash válido (o caso leve nem chega aqui). */
export function usableStrikePhotos(
  photos: readonly StrikePhoto[] | undefined,
): StrikePhoto[] {
  return (photos ?? []).filter(
    (photo) =>
      Boolean(photo.phash) ||
      Boolean(photo.blockId) ||
      (typeof photo.sha256 === 'string' && SHA256_FORMAT.test(photo.sha256)),
  );
}

export function uniqueStrings(
  values: ReadonlyArray<string | null | undefined>,
): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === 'string' && value !== '',
      ),
    ),
  ];
}

/** Uma linha de checagem de entrada da conta (o que o limite de novas tentativas lê). */
export interface PhotoAttemptRow {
  generationId: string | null;
  createdAt: Date;
  verdict: ScanVerdict;
  enforced: boolean;
}

export interface PhotoRetryDecision {
  allowed: boolean;
  /** a conta está sob o limite (bloqueio de foto que agiu em 24 h ou evento de foto sem revisão em 90 dias) */
  restricted: boolean;
  attemptsLast10Min: number;
  attemptsCounted: number;
}

/**
 * Limite de novas tentativas com foto depois de um bloqueio de foto (camada 6, contra as muitas tentativas até passar):
 * 1 tentativa a cada 10 min e 5 em 24 h, até a revisão. Uma tentativa = uma geração (ou uma chamada de rota sem fila,
 * pelo horário da rodada). Contam as tentativas desde o 1º bloqueio da janela de 24 h (com evento de foto aberto mais
 * velho, as 24 h inteiras), inclusive a bloqueada. A geração atual não conta contra ela mesma (nova tentativa da fila).
 */
export function photoRetryDecision(
  rows: readonly PhotoAttemptRow[],
  options: {
    now: Date;
    currentGenerationId: string | null;
    /** evento de foto barrada ou segurada sem revisão nos últimos 90 dias */
    openPhotoEvent: boolean;
  },
): PhotoRetryDecision {
  const now = options.now.getTime();
  const others = rows.filter(
    (row) =>
      options.currentGenerationId === null ||
      row.generationId !== options.currentGenerationId,
  );
  const blockTimes = others
    .filter(
      (row) =>
        row.enforced && (row.verdict === 'BLOCK' || row.verdict === 'HOLD'),
    )
    .map((row) => new Date(row.createdAt).getTime())
    .filter(
      (at) => Number.isFinite(at) && at >= now - PHOTO_RETRY_LONG_WINDOW_MS,
    );
  const restricted = blockTimes.length > 0 || options.openPhotoEvent;
  if (!restricted) {
    return {
      allowed: true,
      restricted: false,
      attemptsLast10Min: 0,
      attemptsCounted: 0,
    };
  }
  const since = blockTimes.length
    ? Math.min(...blockTimes)
    : now - PHOTO_RETRY_LONG_WINDOW_MS;
  // cada tentativa vale pela 1ª rodada dela (a nova checagem depois de indisponível não vira outra tentativa)
  const firstAt = new Map<string, number>();
  for (const row of others) {
    const at = new Date(row.createdAt).getTime();
    // linha um pouco "no futuro" (relógio de outra instância adiantado) conta: nunca abre vaga a mais
    if (!Number.isFinite(at) || at < since) continue;
    const key = row.generationId ?? `batch:${at}`;
    const seen = firstAt.get(key);
    if (seen === undefined || at < seen) firstAt.set(key, at);
  }
  const times = [...firstAt.values()];
  const attemptsLast10Min = times.filter(
    (at) => at >= now - PHOTO_RETRY_SHORT_WINDOW_MS,
  ).length;
  const attemptsCounted = times.length;
  return {
    allowed:
      attemptsLast10Min < SAFETY_STRIKES.photoRetryPer10Min &&
      attemptsCounted < SAFETY_STRIKES.photoRetryPer24h,
    restricted: true,
    attemptsLast10Min,
    attemptsCounted,
  };
}

/**
 * Linhas que seguram o resultado de uma conta suspensa para revisão humana: uma por mídia, HOLD agida, com a regra
 * interna ACCOUNT_SUSPENDED. Viram a última rodada de cada mídia, então a quarentena trata a geração como "resultado
 * em revisão" (espera o revisor, nunca publica sozinha). O veredito real da checagem fica nas linhas anteriores.
 */
export function suspensionHoldRows(input: {
  generationId: string;
  userId: string | null;
  mediaKeys: ReadonlyArray<string | null | undefined>;
  mode: 'shadow' | 'enforce';
}): Prisma.ContentSafetyScanCreateManyInput[] {
  return uniqueStrings(input.mediaKeys).map((mediaKey) => ({
    generationId: input.generationId,
    userId: input.userId,
    stage: 'OUTPUT',
    mediaKey,
    sha256: null,
    phash: null,
    scores: {
      reason:
        'conta suspensa por segurança: resultado segurado para revisão humana',
    },
    verdict: 'HOLD',
    ruleId: ACCOUNT_SUSPENDED_RULE,
    strength: 'NONE',
    rulesVersion: RULES_VERSION,
    mode: input.mode,
    enforced: true,
    scanner: STRIKES_SCANNER,
    region: null,
    latencyMs: null,
    evidenceKey: null,
  }));
}

const CAUSE_LABEL: Readonly<Record<SuspensionCause, string>> = {
  strong: 'sinal forte',
  medium_points: `${SAFETY_STRIKES.mediumStrikesToSuspend} pontos médios em ${SAFETY_STRIKES.mediumStrikeWindowDays} dias`,
  repeat_hash: `${SAFETY_STRIKES.repeatBlocksToSuspend} bloqueios de foto parecida em ${SAFETY_STRIKES.repeatWindowHours} h`,
  cross_account: 'mesma foto bloqueada em outra conta',
};

/** Motivo interno na trilha (regra, força e ids; nunca texto do pedido). Até 300 caracteres. */
export function suspensionReasonOf(
  causes: readonly SuspensionCause[],
  details: {
    layer: string;
    match: string;
    eventId: string | null;
    generationId: string | null;
    points?: number;
    linkedAccounts?: readonly string[];
  },
): string {
  const parts = [
    causes.map((cause) => CAUSE_LABEL[cause]).join(' + ') || 'sem causa',
    `${details.layer}:${details.match}`,
    details.eventId ? `evento ${details.eventId}` : 'evento não gravado',
    details.generationId ? `geração ${details.generationId}` : null,
    details.points ? `pontos ${details.points}` : null,
    details.linkedAccounts?.length
      ? `contas ligadas ${details.linkedAccounts.join(',')}`
      : null,
  ].filter((part): part is string => !!part);
  return parts.join(' · ').slice(0, 300);
}

const USER_ID_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

/** Id de conta que veio de fora do processo (aviso entre instâncias): só o formato de id, nada mais. */
export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_FORMAT.test(value);
}

/** Dono do job (o BullMQ não indexa por conta: o cancelamento lê o campo do job). */
export function jobUserIdOf(data: unknown): string | null {
  const value =
    data && typeof data === 'object'
      ? (data as Record<string, unknown>).userId
      : null;
  return typeof value === 'string' && value !== '' ? value : null;
}

export function jobGenerationIdOf(data: unknown): string | null {
  const value =
    data && typeof data === 'object'
      ? (data as Record<string, unknown>).generationId
      : null;
  return typeof value === 'string' && value !== '' ? value : null;
}
