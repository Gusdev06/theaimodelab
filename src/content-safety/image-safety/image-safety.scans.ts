import type {
  FaceSignal,
  InputSummary,
  LabelSignal,
  ModerationSignal,
  ScanScores,
  ScanSignals,
  ScanStage,
  ScanVerdict,
  StylizedSignal,
} from './types';
import { VERDICT_SEVERITY } from './types';
import type { SafetyThresholds } from './image-safety.config';
import {
  aggregatePreflightStatus,
  hasPersonWithoutFace,
  nonExplicitNudityScore,
} from './image-safety.rules';
import type { PreflightStatus } from '../preflight-status';

/**
 * Leitura das checagens gravadas (content_safety_scans): a última rodada de cada mídia, o status do preflight, o motivo
 * de uma geração IN_REVIEW, o resumo da entrada para a S7 e a reconstrução dos sinais do cache por sha256. Funções
 * puras sobre as linhas já lidas do banco.
 */

/** Marca as linhas TEXT da saída do agente refinador (não entram no status do preflight da entrada). */
export const REFINER_TEXT_MEDIA_KEY = 'refiner-output';

/** O mínimo de uma linha de checagem que estas funções leem. */
export interface ScanRowLike {
  stage: ScanStage;
  verdict: ScanVerdict;
  mediaKey: string | null;
  sha256: string | null;
  createdAt: Date;
  scores?: unknown;
  /** o veredito agiu no modo da rodada (só registro = false); linha antiga sem o campo conta como agida */
  enforced?: boolean;
}

const INPUT_STAGES: ReadonlySet<ScanStage> = new Set<ScanStage>([
  'INPUT',
  'INPUT_FRAME',
]);
const OUTPUT_STAGES: ReadonlySet<ScanStage> = new Set<ScanStage>([
  'OUTPUT',
  'OUTPUT_FRAME',
]);

export function isInputStage(stage: ScanStage): boolean {
  return INPUT_STAGES.has(stage);
}

export function isOutputStage(stage: ScanStage): boolean {
  return OUTPUT_STAGES.has(stage);
}

function groupKeyOf(row: ScanRowLike): string {
  if (row.stage === 'TEXT') return `text|${row.mediaKey ?? ''}`;
  const family = isInputStage(row.stage) ? 'in' : 'out';
  return `${family}|${row.mediaKey ?? row.sha256 ?? ''}`;
}

/**
 * A última rodada de cada mídia (e do texto): a mesma mídia pode ter sido checada de novo (fila depois de
 * indisponível, nova tentativa do BullMQ). Cada rodada grava todas as linhas da mídia com o mesmo createdAt, então
 * vale o grupo com o maior createdAt; rodadas velhas (inclusive a indisponível que veio antes) saem.
 */
export function latestScanBatch<T extends ScanRowLike>(
  rows: readonly T[],
): T[] {
  const latest = new Map<string, number>();
  for (const row of rows) {
    const key = groupKeyOf(row);
    const at = new Date(row.createdAt).getTime();
    if (!latest.has(key) || at > (latest.get(key) as number)) {
      latest.set(key, at);
    }
  }
  return rows.filter(
    (row) => new Date(row.createdAt).getTime() === latest.get(groupKeyOf(row)),
  );
}

/**
 * Status do preflight lido das checagens da geração: só entrada e texto do pedido (nunca o refinador), a última
 * rodada de cada mídia. `textExpected` = o classificador de texto está ligado. A imagem é sempre esperada: este status
 * só é consultado quando o pedido tem mídia do usuário, e mídia sem checagem nunca é limpa.
 */
export function preflightStatusFromScans(
  rows: readonly ScanRowLike[],
  textExpected: boolean,
): PreflightStatus {
  const relevant = latestScanBatch(
    rows.filter(
      (row) =>
        isInputStage(row.stage) ||
        (row.stage === 'TEXT' && row.mediaKey !== REFINER_TEXT_MEDIA_KEY),
    ),
  );
  return aggregatePreflightStatus(relevant, {
    image: true,
    text: textExpected,
  });
}

/** Por que uma geração está IN_REVIEW (define o prazo do cron da quarentena). */
export type HoldReason = 'output_unchecked' | 'output_review' | 'input_review';

/**
 * Motivo do IN_REVIEW a partir das checagens: resultado com HOLD/BLOCK que AGIU = revisão do resultado; resultado sem
 * veredito de suspeita agido (checagem indisponível, promoção que falhou, regra só de sombra) = resultado não checado;
 * sem linha de resultado = entrada segurada antes do provedor (E3a, marcador no negativo). `hasOutputHold` = a geração
 * guardou a saída na quarentena (parameters.safetyHold): sem linha gravada, conta como não checado.
 */
export function holdReasonOf(
  rows: readonly ScanRowLike[],
  hasOutputHold: boolean,
): HoldReason {
  const output = latestScanBatch(
    rows.filter((row) => isOutputStage(row.stage)),
  );
  if (output.length === 0) {
    return hasOutputHold ? 'output_unchecked' : 'input_review';
  }
  return output.some(
    (row) =>
      (row.verdict === 'HOLD' || row.verdict === 'BLOCK') &&
      row.enforced !== false,
  )
    ? 'output_review'
    : 'output_unchecked';
}

function scoresOf(row: { scores?: unknown }): ScanScores {
  return row.scores && typeof row.scores === 'object'
    ? (row.scores as ScanScores)
    : {};
}

/**
 * Resumo da entrada para a S7 a partir das checagens gravadas: pior veredito da última rodada de cada mídia, se houve
 * rosto e o menor ponto médio. `hasMedia` = o pedido tem mídia visual; com mídia e nenhuma checagem, o veredito é
 * UNAVAILABLE (nunca limpo por ausência); sem mídia, null.
 */
export function inputSummaryFromScans(
  rows: readonly ScanRowLike[],
  hasMedia: boolean,
): InputSummary {
  const input = latestScanBatch(rows.filter((row) => isInputStage(row.stage)));
  if (input.length === 0) {
    return {
      verdict: hasMedia ? 'UNAVAILABLE' : null,
      hadFace: false,
      youngestAgeMid: null,
    };
  }
  let worst: ScanVerdict = 'CLEAN';
  let youngest: number | null = null;
  for (const row of input) {
    if (VERDICT_SEVERITY[row.verdict] > VERDICT_SEVERITY[worst]) {
      worst = row.verdict;
    }
    for (const face of scoresOf(row).faces ?? []) {
      if (typeof face.ageMid === 'number' && Number.isFinite(face.ageMid)) {
        youngest =
          youngest === null ? face.ageMid : Math.min(youngest, face.ageMid);
      }
    }
  }
  return {
    verdict: worst,
    hadFace: youngest !== null,
    youngestAgeMid: youngest,
  };
}

/**
 * Status da entrada para o desvio SEM CENSURA (fallbackToSeedream e fallback de modelo cujo alvo é sem censura). O
 * preflight julgou a foto no contexto do pedido original (modelo e ferramenta com filtro), onde a zona de dúvida (E4)
 * e o estilizado sem juiz (E5) nem disparam. O destino é sexual por definição, então a entrada é reavaliada como
 * pedido sexual a partir das checagens gravadas (última rodada de cada mídia): rosto mais jovem abaixo de
 * `ageGrayMax` ou estilizado/pessoa sem rosto sem julgamento adulto = 'gray'; juiz apontando traço infantil =
 * 'flagged'. Só rebaixa: nunca transforma outro status em 'clean'. Linha sem sinais (minimizada) nunca é limpa.
 */
export function uncensoredFallbackStatus(
  base: PreflightStatus,
  rows: readonly ScanRowLike[],
  thresholds: Pick<SafetyThresholds, 'ageGrayMax'>,
): PreflightStatus {
  if (base !== 'clean') return base;
  const input = latestScanBatch(rows.filter((row) => isInputStage(row.stage)));
  if (input.length === 0) return 'unavailable';
  let status: PreflightStatus = 'clean';
  for (const row of input) {
    // linha sem sinais (ou já minimizada pela guarda mínima) nunca prova que a foto é adulta
    if (
      !row.scores ||
      typeof row.scores !== 'object' ||
      (row.scores as { minimized?: unknown }).minimized === true
    ) {
      return 'unavailable';
    }
    const signals = signalsFromScores({
      scores: row.scores,
      phash: null,
      sha256: null,
    });
    if (
      signals.stylized.status === 'judged' &&
      signals.stylized.childlike === true
    ) {
      return 'flagged';
    }
    const stylizedOrFaceless =
      signals.illustrated || hasPersonWithoutFace(signals);
    const judgedAdult =
      signals.stylized.status === 'judged' &&
      signals.stylized.childlike === false;
    if (stylizedOrFaceless && !judgedAdult) status = 'gray';
    if (
      signals.faces.some(
        (face) =>
          Number.isFinite(face.ageMid) && face.ageMid < thresholds.ageGrayMax,
      )
    ) {
      status = 'gray';
    }
  }
  return status;
}

/** A entrada teve nudez (explícita ou não) com o mínimo, pelas checagens gravadas (pista de pedido sexual). */
export function inputNudityFromScans(
  rows: readonly ScanRowLike[],
  nudityMin: number,
): boolean | null {
  const input = latestScanBatch(rows.filter((row) => isInputStage(row.stage)));
  const checked = input.filter((row) => row.verdict !== 'UNAVAILABLE');
  if (checked.length === 0) return null;
  return checked.some((row) => {
    const scores = scoresOf(row);
    return (
      (scores.nudity ?? 0) >= nudityMin ||
      nonExplicitNudityScore(scores.moderation ?? []) >= nudityMin
    );
  });
}

/** Intenção sexual lida pelo classificador de texto do pedido (linha TEXT), ou null. */
export function textSexualFromScans(
  rows: readonly ScanRowLike[],
): boolean | null {
  const text = latestScanBatch(
    rows.filter(
      (row) => row.stage === 'TEXT' && row.mediaKey !== REFINER_TEXT_MEDIA_KEY,
    ),
  );
  for (const row of text) {
    const sexual = scoresOf(row).sexual;
    if (typeof sexual === 'boolean') return sexual;
  }
  return null;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Sinais de uma checagem gravada (cache por sha256): rostos sem caixa, os rótulos que as regras usam e a moderação
 * gravada (≥ 50). O hash da lista de bloqueio NÃO vem do cache (a lista muda): quem chama confere de novo.
 */
export function signalsFromScores(row: {
  scores?: unknown;
  phash: string | null;
  sha256: string | null;
}): ScanSignals {
  const scores = scoresOf(row);
  const faces: FaceSignal[] = (scores.faces ?? []).map((face) => ({
    ageLow: finiteOr(face.ageLow, 0),
    ageHigh: finiteOr(face.ageHigh, 0),
    ageMid: finiteOr(face.ageMid, 0),
    box: null,
    confidence: finiteOr(face.confidence, 0),
    fromCrop: face.fromCrop === true,
  }));
  const labels: LabelSignal[] = (scores.labels ?? []).map((label) => ({
    name: String(label.name),
    confidence: finiteOr(label.confidence, 0),
    instanceCount: finiteOr(label.instanceCount, 0),
  }));
  const moderation: ModerationSignal[] = (scores.moderation ?? []).map(
    (signal) => ({
      name: String(signal.name),
      parent: typeof signal.parent === 'string' ? signal.parent : null,
      confidence: finiteOr(signal.confidence, 0),
      taxonomyLevel: finiteOr(signal.taxonomyLevel, 1),
    }),
  );
  const stylized: StylizedSignal =
    scores.stylized && typeof scores.stylized === 'object'
      ? scores.stylized
      : { status: 'not_run' };
  return {
    faces,
    labels,
    moderation,
    illustrated: scores.illustrated === true,
    cropPassRan: scores.cropPassRan === true,
    phash: row.phash,
    sha256: row.sha256,
    hashMatch: null,
    stylized,
    scanner: 'cache',
    region: null,
    latencyMs: 0,
  };
}
