import { createHash, randomUUID } from 'crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ContentSafetyEventKind,
  GenerationStatus,
  Prisma,
  type GenerationType,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GENERATION_OUTPUT_ROOT,
  StorageReadError,
  UploadsService,
  contentTypeOfKey,
  type StoredMediaLocation,
} from '../../uploads/uploads.service';
import {
  ConsentRequiredSafetyError,
  InputImageSafetyBlockError,
  OutputImageSafetyBlockError,
  SafetyCheckPendingError,
  SafetyCheckUnavailableError,
  TextSafetyBlockError,
  UnverifiedContentBlockError,
  type PlatformSafetyBlockError,
} from '../../generations/errors/content-safety.error';
import { GenerationJobName } from '../../generations/queue/generation-queue.constants';
import {
  FACE_SWAP_SEEDREAM_PROMPT,
  UNDRESS_PROMPT,
} from '../../generations/queue/server-prompts';
import { jobMediaUrls } from '../../generations/queue/safety-fallback-guard';
import { ContentSafetyService } from '../content-safety.service';
import { isUncensoredModel } from '../content-safety.interceptor';
import type { PreflightStatus } from '../preflight-status';
import {
  AccountSuspendedSafetyError,
  PhotoRetryLimitError,
} from '../strikes/strikes.errors';
import { suspensionHoldRows } from '../strikes/strikes.rules';
import {
  ACCOUNT_SUSPENDED_RULE,
  STRIKES,
  type StrikePhoto,
  type StrikeSignalContext,
  type StrikesPort,
} from '../strikes/strikes.types';
import {
  TextClassifierService,
  textUnavailableAction,
} from '../text-classifier/text-classifier.service';
import {
  IMAGE_SAFETY_CONFIG,
  RULES_VERSION,
  SAFETY_TIMING,
  isRuleEnforced,
  type ImageSafetyConfig,
  type VideoSamplingConfig,
} from './image-safety.config';
import {
  aggregatePreflightStatus,
  combineInputVerdicts,
  combineOutputVerdicts,
  decideInputVerdict,
  decideOutputVerdict,
  decideVideoVerdict,
  hasPersonWithoutFace,
  isSexualRequest,
  nonExplicitNudityScore,
  nudityScore,
  surfaceOf,
  toScanScores,
  unavailableInputVerdict,
  unavailableOutputVerdict,
  type RuledInputVerdict,
  type RuledOutputVerdict,
} from './image-safety.rules';
import {
  REFINER_TEXT_MEDIA_KEY,
  holdReasonOf,
  inputNudityFromScans,
  inputSummaryFromScans,
  isInputStage,
  latestScanBatch,
  signalsFromScores,
  textSexualFromScans,
  type HoldReason,
} from './image-safety.scans';
import {
  BLOCKLIST,
  IMAGE_SCANNER,
  KNOWN_HASH_MATCHER,
  SAFETY_MEDIA_TOOLKIT,
  STYLIZED_JUDGE,
} from './image-safety.tokens';
import { sha256Hex, toRekognitionJpeg } from './normalize';
import { perceptualHash } from './phash';
import { sampleFrames, type SampledFrame } from './video-frames';
import {
  STRENGTH_RANK,
  SafetyProviderUnavailableError,
  type BlocklistPort,
  type EvidenceAction,
  type InputVerdict,
  type KnownHashPort,
  type MediaKind,
  type NormalizedImage,
  type OutputVerdict,
  type ProviderFailureKind,
  type RequestContext,
  type RuleId,
  type SafetyCallOptions,
  type SafetyTool,
  type ScanRecordInput,
  type ScanSignals,
  type ScanStage,
  type ScannerPort,
  type StorageArea,
  type Strength,
  type StylizedJudgePort,
  type TextClassifierInput,
  type TextVerdict,
} from './types';

/**
 * Orquestração da segurança de imagem e texto (camadas 2, 3 e 5): o porteiro da mídia de entrada ANTES do 1º provedor
 * (preflight), a checagem síncrona das rotas sem fila (checkInput) e a checagem do resultado antes de publicar
 * (checkOutput). Tudo desligado com IMAGE_SAFETY_MODE=off e TEXT_CLASSIFIER_MODE=off: nenhuma leitura, nenhuma escrita,
 * nenhuma chamada externa (comportamento da Onda 0).
 *
 * Princípios:
 *  - o veredito REAL é gravado em content_safety_scans em qualquer modo ligado; o que age é decidido por
 *    isRuleEnforced (sombra só age nas regras do 1º dia);
 *  - fornecedor fora nunca libera mídia para provedor (fila com nova tentativa até 10 min, depois falha com estorno);
 *  - a cliente recebe sempre o mesmo código e o mesmo texto; regra e score ficam só no registro;
 *  - nada de vetor facial: só faixa de idade, rótulos, scores, hashes e veredito;
 *  - logs sem prompt e sem URL assinada (só chave do storage e id da geração).
 */

/** Ferramentas de mídia (normalizar, quadros, pHash): trocáveis nos testes. */
export interface SafetyMediaToolkit {
  normalizeImage(
    buffer: Buffer,
    mimeType: string | null,
  ): Promise<NormalizedImage[]>;
  sampleVideoFrames(
    buffer: Buffer,
    extension: string,
    video: VideoSamplingConfig,
  ): Promise<SampledFrame[]>;
  phash(image: Buffer): Promise<string>;
}

export const defaultSafetyMediaToolkit: SafetyMediaToolkit = {
  normalizeImage: toRekognitionJpeg,
  sampleVideoFrames: (buffer, extension, video) =>
    sampleFrames({ buffer, extension }, video),
  phash: perceptualHash,
};

/** Resultado do preflight para quem despacha o job. */
export type PreflightOutcome =
  /** pode chamar o provedor; `status` é o que os desvios consultam (decideSafetyFallback) */
  | { action: 'proceed'; status: PreflightStatus }
  /** segurado para revisão (IN_REVIEW): o job conclui sem chamar provedor */
  | { action: 'held' }
  /** a geração já terminou ou está segurada: nada a fazer */
  | { action: 'skip' };

/** Cópia pública feita com a quarentena ainda inteira (a 2ª fase é de quem conclui: settleHeldPromotion). */
export interface StagedPromotion {
  quarantineKey: string;
  publicKey: string;
}

/** Resultado da checagem da saída. */
export type OutputCheckOutcome =
  /**
   * publicar estas URLs (já promovidas da quarentena). `staged` só na nova checagem do cron: a quarentena ainda não
   * saiu e quem concluir chama settleHeldPromotion (venceu = apaga a quarentena; perdeu = apaga as cópias públicas)
   */
  | { action: 'promote'; outputs: string[]; staged?: StagedPromotion[] }
  /** segurado na quarentena (IN_REVIEW): nada é publicado */
  | { action: 'held' }
  /** resultado com menor: evidência guardada; quem chama encerra com estorno */
  | { action: 'blocked'; error: OutputImageSafetyBlockError };

/** O que a conclusão precisa para publicar depois (o resultado segurado conclui pelo cron ou pelo revisor). */
export interface OutputCompletion {
  modelUsed: string;
  provider: string | null;
  processingTimeMs: number;
}

/** Saída guardada na quarentena enquanto a geração está IN_REVIEW (generation.parameters.safetyHold). */
export interface SafetyHoldRecord extends OutputCompletion {
  stage: 'output';
  outputs: Array<{ area: StorageArea; key: string; mimeType: string | null }>;
  heldAt: string;
  /** quando o cron avisou que a revisão venceu (o aviso não se repete depois de reiniciar o processo) */
  alertedAt?: string | null;
}

/** Estado de uma geração IN_REVIEW, para o cron da quarentena. */
export interface HoldState {
  reason: HoldReason;
  heldAt: Date;
  hold: SafetyHoldRecord | null;
  modelUsed: string;
  /** aviso de revisão vencida já dado (gravado no banco) */
  alertedAt?: Date | null;
}

/** Campos do job que guardam a janela de espera do preflight (job.updateData). */
export const SAFETY_JOB_FIRST_ATTEMPT_KEY = 'safetyFirstAttemptAt';
export const SAFETY_JOB_DEFERRALS_KEY = 'safetyDeferrals';

const IMAGE_READ_MAX_BYTES = 40 * 1024 * 1024;
const VIDEO_READ_MAX_BYTES = 150 * 1024 * 1024;
/** Imagens checadas ao mesmo tempo (a cota do Rekognition em São Paulo é 5/s em DetectLabels). */
const SCAN_CONCURRENCY = 2;
/** O cache de sinais só serve com o limite de nudez acima do que o registro guarda (moderação ≥ 50). */
const CACHED_MODERATION_MIN = 50;

/** Uma mídia (entrada ou resultado) a checar. */
interface CheckedMedia {
  kind: MediaKind;
  location: StoredMediaLocation | null;
  mimeType: string | null;
  /** URL original (só do resultado, para devolver a mesma quando não há quarentena); nunca vai para log nem banco */
  url: string | null;
}

interface ImageRead {
  stage: ScanStage;
  signals: ScanSignals;
  image: NormalizedImage | null;
}

interface MediaRead {
  media: CheckedMedia;
  sha256: string | null;
  body: Buffer | null;
  contentType: string | null;
  images: ImageRead[];
  video: boolean;
  failure: { provider: string; failure: ProviderFailureKind } | null;
}

interface MediaDecision<V extends InputVerdict | OutputVerdict> {
  read: MediaRead;
  /** veredito de cada imagem ou quadro (mesma ordem de read.images) */
  perImage: V[];
  /** pior veredito real da mídia */
  real: V;
  /** pior veredito que AGE no modo atual; null = nada age */
  acted: V | null;
  evidenceKey: string | null;
}

/** Resultado de levar uma mídia para a evidência: `failed` = devia guardar e não guardou (a prova não pode sumir). */
interface EvidenceOutcome {
  key: string | null;
  failed: boolean;
}

type PreflightDecision =
  | { kind: 'proceed'; status: PreflightStatus }
  | { kind: 'held' }
  | { kind: 'skip' }
  | { kind: 'block'; error: Error }
  | { kind: 'unavailable'; provider: string; failure: ProviderFailureKind };

interface GenerationForSafety {
  id: string;
  userId: string;
  status: GenerationStatus;
  type: GenerationType;
  modelUsed: string;
  prompt: string | null;
  negativePrompt: string | null;
  parameters: Prisma.JsonValue;
  safetyCheckedAt: Date | null;
  updatedAt: Date;
}

const GENERATION_SAFETY_SELECT = {
  id: true,
  userId: true,
  status: true,
  type: true,
  modelUsed: true,
  prompt: true,
  negativePrompt: true,
  parameters: true,
  safetyCheckedAt: true,
  updatedAt: true,
} as const;

/** Ids técnicos que os provedores devolvem para modelos sem censura (o slug do pedido some no modelUsed da saída). */
const UNCENSORED_PROVIDER_IDS: ReadonlyArray<[RegExp, string]> = [
  [/^wavespeed-ai\/minimax-h3\//i, 'wavespeed-minimax-h3'],
];

/**
 * Mídia do caso leve no registro: marcador por mídia, sem a chave (que leva o nome do arquivo) e sem nada derivado dos
 * bytes da foto. Mídia sem chave (rota sem fila) ganha um marcador aleatório.
 */
function lightMediaMarker(key: string | null): string {
  const source = key ?? randomUUID();
  return `light:${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Roda `fn` em cada item com no máximo `limit` ao mesmo tempo, mantendo a ordem. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Ferramenta do pedido deduzida NO SERVIDOR (nome do job, modelo, tipo da geração, modo do job), nunca de campo do
 * site: despir (deepdeep), troca de rosto Unlocked (nsfw ou modelo sem censura), provador, motion control.
 */
export function safetyToolOf(input: {
  jobName?: string | null;
  jobData?: unknown;
  modelUsed?: string | null;
  type?: GenerationType | null;
}): SafetyTool {
  const data = asRecord(input.jobData);
  const model = stringOr(data.model) ?? input.modelUsed ?? null;
  if (model === 'deepdeep' || input.modelUsed === 'deepdeep') return 'undress';
  if (
    input.jobName === GenerationJobName.FACE_SWAP ||
    input.type === 'FACE_SWAP'
  ) {
    return data.nsfw === true || isUncensoredModel(input.modelUsed)
      ? 'face_swap_unlocked'
      : 'face_swap';
  }
  if (
    input.jobName === GenerationJobName.VIRTUAL_TRY_ON ||
    input.type === 'VIRTUAL_TRY_ON'
  ) {
    return 'virtual_try_on';
  }
  if (
    input.jobName === GenerationJobName.MOTION_CONTROL ||
    input.type === 'MOTION_CONTROL'
  ) {
    return 'motion_control';
  }
  return 'generate';
}

/**
 * Modelo que recebe a mídia: o resolvido no job (resolvedModel, modelId, model) ou o da geração. Modo `spicy` do Grok
 * conta como sem censura (o slug ganha o sufixo que isUncensoredModel reconhece).
 */
export function safetyModelOf(
  jobData: unknown,
  modelUsed: string | null,
): string | null {
  const data = asRecord(jobData);
  const model =
    stringOr(data.resolvedModel) ??
    stringOr(data.modelId) ??
    stringOr(data.model) ??
    modelUsed;
  return data.mode === 'spicy' ? `${model ?? 'grok'}:spicy` : model;
}

/**
 * Modelo que decide o contexto da checagem do RESULTADO. O provedor devolve o id técnico ('wavespeed-ai/minimax-h3/…',
 * 'grok-imagine/…'), que não diz que o pedido era sem censura; aí a saída seria julgada como pedido comum e a S2b não
 * rodaria. Vale o primeiro sem censura entre o slug da geração, o id do provedor (com a tabela de ids técnicos) e o
 * modelo/modo guardado nos parâmetros; sem nenhum, o id do provedor (ou o da geração).
 */
export function outputSafetyModelOf(
  generationModel: string | null,
  completionModel: string | null,
  parameters: unknown,
): string | null {
  const fromProviderId = completionModel
    ? (UNCENSORED_PROVIDER_IDS.find(([pattern]) =>
        pattern.test(completionModel),
      )?.[1] ?? null)
    : null;
  const candidates = [
    generationModel,
    completionModel,
    fromProviderId,
    safetyModelOf(parameters, null),
  ];
  return (
    candidates.find((model) => isUncensoredModel(model)) ??
    (completionModel || generationModel || null)
  );
}

/** Prompt montado no servidor que vai ao provedor no lugar do texto da cliente (despir, troca de rosto Unlocked). */
function serverPromptOf(tool: SafetyTool): string | null {
  if (tool === 'undress') return UNDRESS_PROMPT;
  if (tool === 'face_swap_unlocked') return FACE_SWAP_SEEDREAM_PROMPT;
  return null;
}

/** Texto da cliente (o original, antes de uma reescrita automática). */
function clientPromptOf(
  prompt: string | null,
  parameters: Prisma.JsonValue,
): string | null {
  return stringOr(asRecord(parameters).originalPrompt) ?? prompt;
}

/** Prompt FINAL para as regras: texto da cliente, reescrita (se houve) e prompt fixo do servidor. */
function finalPromptOf(
  tool: SafetyTool,
  prompt: string | null,
  parameters: Prisma.JsonValue,
): string | null {
  const parts = [
    clientPromptOf(prompt, parameters),
    prompt,
    serverPromptOf(tool),
  ].filter((text): text is string => !!text);
  return parts.length ? [...new Set(parts)].join('\n') : null;
}

function kindOf(
  hint: string | null | undefined,
  mimeType: string | null,
  key: string | null,
): MediaKind {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  const lowered = (hint ?? '').toLowerCase();
  if (lowered === 'video' || lowered === 'audio') return lowered;
  const byKey = key ? contentTypeOfKey(key) : '';
  if (byKey.startsWith('video/')) return 'video';
  if (byKey.startsWith('audio/')) return 'audio';
  return 'image';
}

function videoExtensionOf(media: CheckedMedia): string {
  const fromKey = media.location?.key.split('.').pop()?.toLowerCase();
  if (fromKey && /^[a-z0-9]{1,8}$/.test(fromKey)) return fromKey;
  const mime = (media.mimeType ?? '').toLowerCase();
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('webm')) return 'webm';
  return 'mp4';
}

/** Motivo da falha de leitura para o registro (o porteiro decide se espera ou encerra). */
function failureOfError(error: unknown): {
  provider: string;
  failure: ProviderFailureKind;
} {
  if (error instanceof SafetyProviderUnavailableError) {
    return { provider: error.provider, failure: error.failure };
  }
  if (error instanceof StorageReadError) {
    const failure: ProviderFailureKind =
      error.reason === 'not_configured'
        ? 'not_configured'
        : error.reason === 'failed'
          ? 'server_error'
          : 'invalid_media';
    return { provider: 'storage', failure };
  }
  return { provider: 'image-safety', failure: 'server_error' };
}

/** Regra que decidiu (E7 com a regra do quadro). */
function ruleOf(verdict: { ruleId: string | null; cause?: string }): string {
  return verdict.ruleId === 'E7' && verdict.cause
    ? `E7:${verdict.cause}`
    : (verdict.ruleId ?? 'sem-regra');
}

/** `match` do evento: regra e força. Nunca texto do pedido. */
function matchOf(verdict: {
  ruleId: string | null;
  strength: Strength;
  cause?: string;
}): string {
  return `${ruleOf(verdict)}/${verdict.strength}`.slice(0, 80);
}

/** Hold guardado em generation.parameters.safetyHold (lido com cuidado: JSON antigo nunca vira hold válido). */
function holdOf(parameters: Prisma.JsonValue): SafetyHoldRecord | null {
  const hold = asRecord(asRecord(parameters).safetyHold);
  if (hold.stage !== 'output' || !Array.isArray(hold.outputs)) return null;
  const areas: ReadonlySet<string> = new Set([
    'public',
    'input-private',
    'quarantine',
    'evidence',
  ]);
  const outputs = (hold.outputs as unknown[])
    .map((item) => asRecord(item))
    .filter(
      (item) => typeof item.key === 'string' && areas.has(String(item.area)),
    )
    .map((item) => ({
      area: item.area as StorageArea,
      key: item.key as string,
      mimeType: stringOr(item.mimeType),
    }));
  return {
    stage: 'output',
    outputs,
    modelUsed: stringOr(hold.modelUsed) ?? '',
    provider: stringOr(hold.provider),
    processingTimeMs: numberOr(hold.processingTimeMs, 0),
    heldAt: stringOr(hold.heldAt) ?? new Date(0).toISOString(),
    alertedAt: stringOr(hold.alertedAt),
  };
}

@Injectable()
export class ImageSafetyService {
  private readonly logger = new Logger(ImageSafetyService.name);

  constructor(
    @Inject(IMAGE_SAFETY_CONFIG) private readonly config: ImageSafetyConfig,
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly contentSafety: ContentSafetyService,
    private readonly textClassifier: TextClassifierService,
    @Inject(BLOCKLIST) private readonly blocklist: BlocklistPort,
    @Inject(KNOWN_HASH_MATCHER) private readonly knownHash: KnownHashPort,
    @Inject(STYLIZED_JUDGE) private readonly judge: StylizedJudgePort,
    @Inject(SAFETY_MEDIA_TOOLKIT) private readonly media: SafetyMediaToolkit,
    @Optional()
    @Inject(IMAGE_SCANNER)
    private readonly scanner: ScannerPort | null = null,
    /** camada 6 (pontos e suspensão); ausente ou com o modo off = nenhum ponto, nenhuma suspensão */
    @Optional()
    @Inject(STRIKES)
    private readonly strikes: StrikesPort | null = null,
  ) {}

  /** Checagem de imagem ligada (shadow ou enforce). */
  get imageEnabled(): boolean {
    return this.config.imageMode !== 'off';
  }

  /** Leitor de sentido do texto ligado. */
  get textEnabled(): boolean {
    return this.config.textMode !== 'off';
  }

  /** Alguma checagem ligada (com tudo off o preflight não lê nem grava nada). */
  get enabled(): boolean {
    return this.imageEnabled || this.textEnabled;
  }

  /** O veredito de imagem age no modo atual? CLEAN nunca age. Para as rotas sem fila decidirem 422/503. */
  actsOn(verdict: {
    verdict: string;
    ruleId: RuleId | null;
    strength: Strength;
    cause?: RuleId;
  }): boolean {
    return (
      verdict.verdict !== 'CLEAN' &&
      isRuleEnforced(
        {
          layer: 'image',
          ruleId: verdict.ruleId,
          strength: verdict.strength,
          cause: verdict.cause,
        },
        this.config,
      )
    );
  }

  /* ════════════════════════════════════════════════════════════ preflight (fila) */

  /**
   * Porteiro ANTES do 1º provedor, uma vez por tentativa do job: texto (camada 2) e toda mídia de entrada (camada 3)
   * em paralelo. Bloqueio lança erro terminal (InputImageSafetyBlockError, TextSafetyBlockError,
   * ConsentRequiredSafetyError); fornecedor fora lança SafetyCheckPendingError (volta à fila) ou, sem fila / janela
   * vencida / arquivo ilegível, SafetyCheckUnavailableError (terminal, com estorno). `queued: false` = run*Directly.
   */
  async preflight(
    job: { name: string; data: unknown },
    options: { queued: boolean } = { queued: true },
  ): Promise<PreflightOutcome> {
    if (!this.enabled) return { action: 'proceed', status: 'unavailable' };
    const data = asRecord(job.data);
    const generationId = stringOr(data.generationId);
    if (!generationId) return { action: 'proceed', status: 'unavailable' };

    let decision: PreflightDecision;
    try {
      decision = await this.runPreflight(generationId, job.name, data);
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] gen=${generationId}: preflight falhou (${(error as Error).message?.slice(0, 200)}) — tratado como checagem indisponível`,
      );
      decision = {
        kind: 'unavailable',
        provider: 'image-safety',
        failure: 'server_error',
      };
    }

    switch (decision.kind) {
      case 'proceed':
        return { action: 'proceed', status: decision.status };
      case 'held':
        return { action: 'held' };
      case 'skip':
        return { action: 'skip' };
      case 'block':
        throw decision.error;
      case 'unavailable':
        throw this.unavailableError(
          decision.provider,
          decision.failure,
          data,
          options.queued,
        );
    }
  }

  /** Espera na fila (pendente) ou encerra (sem fila, janela vencida, arquivo que nunca vai dar para ler). */
  private unavailableError(
    provider: string,
    failure: ProviderFailureKind,
    data: Record<string, unknown>,
    queued: boolean,
  ): SafetyCheckPendingError | SafetyCheckUnavailableError {
    if (
      !queued ||
      failure === 'invalid_media' ||
      failure === 'not_configured'
    ) {
      return new SafetyCheckUnavailableError(provider, failure);
    }
    const now = Date.now();
    const firstAttemptAt = numberOr(data[SAFETY_JOB_FIRST_ATTEMPT_KEY], now);
    const deferrals = Math.max(
      0,
      Math.floor(numberOr(data[SAFETY_JOB_DEFERRALS_KEY], 0)),
    );
    const remaining =
      firstAttemptAt + SAFETY_TIMING.preflightRetryWindowMs - now;
    if (remaining <= 0)
      return new SafetyCheckUnavailableError(provider, failure);
    const backoff = Math.min(
      SAFETY_TIMING.preflightRetryBaseDelayMs * 2 ** Math.min(deferrals, 10),
      SAFETY_TIMING.preflightRetryMaxDelayMs,
    );
    const delayMs = Math.max(1_000, Math.min(backoff, remaining));
    this.logger.warn(
      `[IMAGE_SAFETY] checagem indisponível (${provider}, ${failure}); job volta à fila em ${Math.round(delayMs / 1000)} s (adiamento ${deferrals + 1})`,
    );
    return new SafetyCheckPendingError(
      provider,
      failure,
      delayMs,
      firstAttemptAt,
      deferrals,
    );
  }

  private async runPreflight(
    generationId: string,
    jobName: string,
    data: Record<string, unknown>,
  ): Promise<PreflightDecision> {
    const generation = (await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: GENERATION_SAFETY_SELECT,
    })) as GenerationForSafety | null;
    if (!generation) return { kind: 'proceed', status: 'unavailable' };
    if (generation.status !== GenerationStatus.PROCESSING) {
      // já terminou, já está segurada ou ainda nem começou: nenhum provedor é chamado por este job
      return { kind: 'skip' };
    }
    // conta suspensa (camada 6): nenhum job dela vai mais ao provedor, nem a nova tentativa de um job já checado
    if (await this.accountSuspended(generation.userId)) {
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId}: conta suspensa — job encerrado sem provedor`,
      );
      return { kind: 'block', error: new AccountSuspendedSafetyError() };
    }

    const tool = safetyToolOf({
      jobName,
      jobData: data,
      modelUsed: generation.modelUsed,
      type: generation.type,
    });
    const model = safetyModelOf(data, generation.modelUsed);
    const allMedia = await this.collectInputMedia(generationId, data);
    const visual = allMedia.filter((item) => item.kind !== 'audio');
    const hasUserMedia = visual.length > 0;

    const reused = await this.reusePreflight(generationId, hasUserMedia);
    if (reused) return reused;

    // depois de um bloqueio de foto: limite de novas tentativas com foto, recusadas sem checar (mesmo código genérico)
    if (
      this.imageEnabled &&
      hasUserMedia &&
      !(await this.photoRetryAllowed(generation.userId, generationId))
    ) {
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId} tool=${tool}: nova tentativa com foto acima do limite depois de um bloqueio — recusada sem checar`,
      );
      return { kind: 'block', error: new PhotoRetryLimitError() };
    }

    const base: Omit<RequestContext, 'surface'> = {
      userId: generation.userId,
      generationId,
      model,
      tool,
      type: generation.type,
      hasUserMedia,
      sexual: { classifier: null, inputNudity: null },
      prompt: finalPromptOf(tool, generation.prompt, generation.parameters),
      negativePrompt:
        generation.negativePrompt ?? stringOr(data.negativePrompt) ?? null,
    };
    const thresholds = this.config.thresholds;
    const batchAt = new Date();

    const [reads, firstText] = await Promise.all([
      this.imageEnabled && hasUserMedia
        ? mapLimited(visual, SCAN_CONCURRENCY, (item) =>
            this.readMedia(item, 'INPUT'),
          )
        : Promise.resolve([] as MediaRead[]),
      this.textEnabled
        ? this.classifyText(
            {
              prompt: clientPromptOf(generation.prompt, generation.parameters),
              negative: base.negativePrompt,
              serverPrompt: serverPromptOf(tool),
            },
            isSexualRequest(base, undefined, thresholds),
            'request',
          )
        : Promise.resolve(null),
    ]);

    const ctx = this.contextWithHints(base, reads, firstText);
    // o texto foi lido em paralelo com as fotos: se só a nudez da entrada (ou a intenção lida pelo classificador)
    // tornou o pedido sexual, o marcador de maturidade no negativo (T_NEGATIVE) é decidido de novo, sem nova chamada
    const text =
      firstText &&
      !isSexualRequest(base, undefined, thresholds) &&
      isSexualRequest(ctx, undefined, thresholds)
        ? this.textClassifier.withSexualRequest(firstText)
        : firstText;
    await this.judgeStylized(reads, ctx);
    const decisions = reads.map((read) => this.decideInputMedia(read, ctx));
    const textActs =
      !!text && text.verdict !== 'CLEAN' && this.textClassifier.shouldAct(text);

    const acted = decisions.filter((decision) => decision.acted);
    const actedImage = acted.length
      ? combineInputVerdicts(acted.map((decision) => decision.acted!))
      : null;

    const writeAll = () =>
      this.writeScans(
        [
          ...decisions.flatMap((decision) =>
            this.inputRows(decision, ctx, generation),
          ),
          ...(text ? [this.textRow(text, generation, textActs, null)] : []),
        ],
        batchAt,
      );

    // 1. foto, quadro ou vídeo barrado: evidência (ou apagar, no caso leve), lista de bloqueio, evento, terminal
    if (actedImage?.verdict === 'BLOCK') {
      const strongOrMedium =
        actedImage.strength === 'STRONG' || actedImage.strength === 'MEDIUM';
      const eventId = strongOrMedium
        ? await this.recordEvent(
            ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
            `input:${tool}`,
            matchOf(actedImage),
            generation,
          )
        : null;
      let evidencePending = false;
      for (const decision of acted) {
        if (decision.acted?.verdict !== 'BLOCK') continue;
        const evidence = await this.applyEvidence(
          decision.read,
          decision.acted.evidence,
        );
        decision.evidenceKey = evidence.key;
        evidencePending ||= evidence.failed;
        await this.addToBlocklist(decision, eventId, 'input');
      }
      await writeAll();
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId} tool=${tool}: entrada barrada (${matchOf(actedImage)})${evidencePending ? ' — evidência pendente, entradas mantidas' : ''}`,
      );
      // depois das checagens gravadas: a repetição por hash conta esta tentativa
      await this.applyStrike(generation.userId, actedImage.strength, eventId, {
        layer: 'input',
        match: matchOf(actedImage),
        generationId,
        photos: this.strikePhotos(acted),
      });
      return {
        kind: 'block',
        error: new InputImageSafetyBlockError(
          ruleOf(actedImage),
          actedImage.strength,
          { evidencePending },
        ),
      };
    }

    // 2. texto barrado pelo leitor de sentido
    if (textActs && text && text.verdict === 'BLOCK') {
      const textMatch = `${text.ruleId ?? 'sem-regra'}/${text.strength}`;
      const eventId = await this.recordEvent(
        ContentSafetyEventKind.TEXT_CLASSIFIER_FLAGGED,
        `text:${tool}`,
        textMatch,
        generation,
      );
      await writeAll();
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId} tool=${tool}: texto barrado (${text.ruleId}/${text.strength})`,
      );
      await this.applyStrike(generation.userId, text.strength, eventId, {
        layer: 'text',
        match: textMatch,
        generationId,
      });
      return {
        kind: 'block',
        error: new TextSafetyBlockError(text.ruleId, text.strength),
      };
    }

    // 3. segura sem gerar (E3a; marcador de maturidade no negativo)
    const imageHold = actedImage?.verdict === 'HOLD';
    const textHold = textActs && !!text && text.verdict === 'HOLD';
    if (imageHold || textHold) {
      for (const decision of acted) {
        // a mídia segurada fica no privado; se ainda estiver no bucket público, sai dele agora
        if (
          decision.acted?.verdict === 'HOLD' &&
          decision.read.media.location?.area === 'public'
        ) {
          // falha aqui não perde nada: a mídia fica onde está e o vencimento (expireHeldInput) tenta de novo
          decision.evidenceKey = (
            await this.applyEvidence(decision.read, 'keep')
          ).key;
        }
      }
      const holdMatch = imageHold
        ? matchOf(actedImage)
        : `${text!.ruleId ?? 'sem-regra'}/${text!.strength}`;
      const eventId = await this.recordEvent(
        ContentSafetyEventKind.INPUT_HELD,
        imageHold ? `input:${tool}` : `text:${tool}`,
        holdMatch,
        generation,
      );
      await writeAll();
      const { count } = await this.prisma.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.PROCESSING },
        data: {
          status: GenerationStatus.IN_REVIEW,
          safetyCheckedAt: new Date(),
        },
      });
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId} tool=${tool}: segurada para revisão sem gerar (${imageHold ? matchOf(actedImage) : text!.ruleId})`,
      );
      await this.applyStrike(
        generation.userId,
        imageHold ? actedImage.strength : text!.strength,
        eventId,
        {
          layer: imageHold ? 'input' : 'text',
          match: holdMatch,
          generationId,
          photos: imageHold ? this.strikePhotos(acted) : [],
        },
      );
      return count > 0 ? { kind: 'held' } : { kind: 'skip' };
    }

    // 4. não deu para checar: nunca segue para o provedor
    const imageUnavailable = actedImage?.verdict === 'UNAVAILABLE';
    const textUnavailable =
      textActs &&
      !!text &&
      text.verdict === 'UNAVAILABLE' &&
      textUnavailableAction({ model, hasUserMedia }) === 'retry';
    if (imageUnavailable || textUnavailable) {
      await writeAll();
      const failed = decisions.find((decision) => decision.read.failure);
      if (imageUnavailable && failed?.read.failure) {
        return { kind: 'unavailable', ...failed.read.failure };
      }
      return {
        kind: 'unavailable',
        provider: imageUnavailable ? 'image-safety' : 'safeguard',
        failure: 'server_error',
      };
    }

    // 5. zona de dúvida que age: sem atestado de imagem, não gera
    if (
      actedImage?.verdict === 'GRAY' &&
      actedImage.restrictions.requireConsent &&
      !(await this.hasConsent(generationId))
    ) {
      await writeAll();
      await this.markChecked(generationId);
      return {
        kind: 'block',
        error: new ConsentRequiredSafetyError(
          'checagem de imagem: zona de dúvida em pedido sexual exige o atestado',
          model ?? '',
        ),
      };
    }

    // 6. segue para o provedor
    await writeAll();
    await this.markChecked(generationId);
    const rows = [
      ...decisions.flatMap((decision) =>
        decision.read.failure
          ? [{ stage: 'INPUT' as ScanStage, verdict: decision.real.verdict }]
          : decision.read.images.map((image, index) => ({
              stage: image.stage,
              verdict: decision.perImage[index].verdict,
            })),
      ),
      ...(text ? [{ stage: 'TEXT' as ScanStage, verdict: text.verdict }] : []),
    ];
    return {
      kind: 'proceed',
      status: aggregatePreflightStatus(rows, {
        image: hasUserMedia,
        text: this.textEnabled,
      }),
    };
  }

  /**
   * Já há checagem desta geração com as regras atuais e nada indisponível (nova tentativa do BullMQ, desvio de modelo
   * da PR #3): reaproveita, sem chamar a AWS de novo. Entrada segurada ou barrada que age só segue se o revisor
   * liberou (INPUT_HELD com releasedAt); o status continua `flagged`, então nenhum desvio leva a mídia adiante.
   */
  private async reusePreflight(
    generationId: string,
    hasUserMedia: boolean,
  ): Promise<PreflightDecision | null> {
    const rows = await this.prisma.contentSafetyScan.findMany({
      where: {
        generationId,
        stage: { in: ['INPUT', 'INPUT_FRAME', 'TEXT'] },
      },
      select: {
        stage: true,
        verdict: true,
        mediaKey: true,
        sha256: true,
        createdAt: true,
        enforced: true,
        rulesVersion: true,
      },
    });
    const latest = latestScanBatch(
      rows.filter((row) => row.mediaKey !== REFINER_TEXT_MEDIA_KEY),
    );
    const actedBlock = latest.some(
      (row) => row.enforced && row.verdict === 'BLOCK',
    );
    const actedHold = latest.some(
      (row) => row.enforced && row.verdict === 'HOLD',
    );
    if (latest.length === 0) return null;
    if (
      latest.some(
        (row) =>
          row.rulesVersion !== RULES_VERSION || row.verdict === 'UNAVAILABLE',
      )
    ) {
      return null;
    }
    const hasImageRows = latest.some((row) => isInputStage(row.stage));
    const hasTextRow = latest.some((row) => row.stage === 'TEXT');
    if (this.imageEnabled && hasUserMedia && !hasImageRows) return null;
    if (this.textEnabled && !hasTextRow) return null;
    if (
      (actedBlock || actedHold) &&
      !(await this.inputHoldReleased(generationId))
    ) {
      // o hold da rodada anterior gravou checagem e evento, mas não chegou a pôr a geração em revisão (banco caiu
      // entre as escritas): aplica de novo, senão o job concluiria e a geração ficaria PROCESSING até o timeout
      if (actedHold && !actedBlock) {
        const { count } = await this.prisma.generation.updateMany({
          where: { id: generationId, status: GenerationStatus.PROCESSING },
          data: {
            status: GenerationStatus.IN_REVIEW,
            safetyCheckedAt: new Date(),
          },
        });
        if (count > 0) {
          this.logger.warn(
            `[IMAGE_SAFETY] gen=${generationId}: segurada para revisão (hold da rodada anterior reaplicado)`,
          );
          return { kind: 'held' };
        }
      }
      return { kind: 'skip' };
    }
    await this.markChecked(generationId);
    return {
      kind: 'proceed',
      status: aggregatePreflightStatus(latest, {
        image: hasUserMedia,
        text: this.textEnabled,
      }),
    };
  }

  private async inputHoldReleased(generationId: string): Promise<boolean> {
    const count = await this.prisma.contentSafetyEvent.count({
      where: {
        generationId,
        kind: ContentSafetyEventKind.INPUT_HELD,
        releasedAt: { not: null },
      },
    });
    return count > 0;
  }

  /**
   * Mídias de entrada da geração: as gravadas (generation_input_images) e as URLs do job (mesmos campos de
   * jobCarriesUserMedia), sem repetir a mesma chave. URL fora do nosso storage fica sem `location` (nunca é baixada).
   */
  private async collectInputMedia(
    generationId: string,
    data: Record<string, unknown>,
  ): Promise<CheckedMedia[]> {
    const rows = await this.prisma.generationInputImage.findMany({
      where: { generationId },
      orderBy: { order: 'asc' },
      select: { url: true, mimeType: true, referenceType: true },
    });
    const items: CheckedMedia[] = [];
    const seen = new Set<string>();
    const add = (url: string, hint: string | null, mimeType: string | null) => {
      const location = this.uploads.locateStoredMedia(url);
      const dedupe = location
        ? `${location.area}:${location.key}`
        : `url:${url.split(/[?#]/)[0]}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      items.push({
        kind: kindOf(hint, mimeType, location?.key ?? null),
        location,
        mimeType:
          mimeType ?? (location ? contentTypeOfKey(location.key) : null),
        url: null,
      });
    };
    for (const row of rows) {
      if (row.url) add(row.url, row.referenceType, row.mimeType);
    }
    for (const media of jobMediaUrls(data)) add(media.url, media.kind, null);
    return items;
  }

  /* ════════════════════════════════════════════════════════════ checagem síncrona (rotas sem fila) */

  /**
   * Checagem síncrona da mídia ANTES de uma chamada externa fora da fila (Clone de Prompt, construtor, marcas, avatar).
   * Devolve o veredito que age (o pior entre os que agem no modo) ou, sem nada agindo, o veredito real. Com tudo off,
   * devolve UNAVAILABLE sem ler nada (quem chama confere `imageEnabled` antes). Indisponível = 503 em quem chama.
   */
  async checkInput(
    media: ReadonlyArray<{
      kind: MediaKind;
      mimeType: string | null;
      area?: StorageArea;
      key?: string | null;
      buffer?: Buffer | null;
    }>,
    ctx: Omit<RequestContext, 'surface'>,
    options: { timeoutMs?: number } = {},
  ): Promise<RuledInputVerdict> {
    if (!this.imageEnabled) {
      return unavailableInputVerdict('checagem de imagem desligada');
    }
    const visual = media.filter((item) => item.kind !== 'audio');
    // camada 6: conta suspensa e limite de novas tentativas com foto recusam sem ler nada (para a cliente, o mesmo
    // "tente de novo em instantes" de quando a checagem cai; o motivo fica no log)
    const refusal = await this.syncRefusalOf(
      ctx.userId,
      ctx.generationId,
      visual.length > 0,
    );
    if (refusal) return unavailableInputVerdict(refusal);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? SAFETY_TIMING.syncCheckTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reads = await mapLimited(visual, SCAN_CONCURRENCY, (item) =>
        this.readMedia(
          {
            kind: item.kind,
            location:
              item.area && item.key ? { area: item.area, key: item.key } : null,
            mimeType: item.mimeType,
            url: null,
          },
          'INPUT',
          { signal: controller.signal, timeoutMs },
          item.buffer ?? null,
        ),
      );
      const fullCtx = this.contextWithHints(
        { ...ctx, hasUserMedia: visual.length > 0 },
        reads,
        null,
      );
      await this.judgeStylized(reads, fullCtx, {
        signal: controller.signal,
        timeoutMs,
      });
      const decisions = reads.map((read) =>
        this.decideInputMedia(read, fullCtx),
      );
      const acted = decisions.filter((decision) => decision.acted);
      const actedVerdict = acted.length
        ? combineInputVerdicts(acted.map((decision) => decision.acted!))
        : null;
      const tool = fullCtx.tool;
      let blockEventId: string | null = null;
      if (actedVerdict?.verdict === 'BLOCK') {
        const strongOrMedium =
          actedVerdict.strength === 'STRONG' ||
          actedVerdict.strength === 'MEDIUM';
        blockEventId = strongOrMedium
          ? await this.recordEvent(
              ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
              `input:${tool}`,
              matchOf(actedVerdict),
              { id: ctx.generationId, userId: ctx.userId },
            )
          : null;
        for (const decision of acted) {
          if (decision.acted?.verdict !== 'BLOCK') continue;
          decision.evidenceKey = (
            await this.applyEvidence(decision.read, decision.acted.evidence)
          ).key;
          await this.addToBlocklist(decision, blockEventId, 'input');
        }
      }
      await this.writeScans(
        decisions.flatMap((decision) =>
          this.inputRows(decision, fullCtx, {
            id: ctx.generationId,
            userId: ctx.userId,
          }),
        ),
        new Date(),
      );
      if (actedVerdict?.verdict === 'BLOCK') {
        await this.applyStrike(
          ctx.userId,
          actedVerdict.strength,
          blockEventId,
          {
            layer: 'input',
            match: matchOf(actedVerdict),
            generationId: ctx.generationId,
            photos: this.strikePhotos(acted),
          },
        );
      }
      return (
        actedVerdict ??
        combineInputVerdicts(decisions.map((decision) => decision.real))
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /* ════════════════════════════════════════════════════════════ saída (camada 5) */

  /**
   * Checa o resultado antes de publicar. NUNCA lança (roda dentro do try do provedor, onde qualquer erro vira desvio):
   *  - promote: copia da quarentena para o público e devolve as URLs públicas;
   *  - held: IN_REVIEW + OUTPUT_HELD (suspeito) ou aguardando checagem (indisponível); nada publicado;
   *  - blocked: resultado com menor; evidência guardada, OUTPUT_MINOR_BLOCKED; quem chama encerra com estorno.
   * Com IMAGE_SAFETY_MODE=off: promote com as mesmas URLs, sem ler nada.
   */
  async checkOutput(
    generationId: string,
    outputUrls: readonly string[],
    completion: OutputCompletion,
  ): Promise<OutputCheckOutcome> {
    if (!this.imageEnabled)
      return { action: 'promote', outputs: [...outputUrls] };
    const outputs: CheckedMedia[] = outputUrls.map((url) => {
      const location = this.uploads.locateStoredMedia(url);
      const mimeType = contentTypeOfKey(location?.key ?? url.split(/[?#]/)[0]);
      return {
        kind: kindOf(null, mimeType, location?.key ?? null),
        location,
        mimeType,
        url,
      };
    });
    try {
      return await this.screenOutputs(generationId, outputs, completion);
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] gen=${generationId}: checagem da saída falhou (${(error as Error).message?.slice(0, 200)}) — resultado segurado sem checagem`,
      );
      await this.holdOutput(generationId, outputs, completion).catch(
        (holdError: unknown) =>
          this.logger.error(
            `[IMAGE_SAFETY] gen=${generationId}: resultado não ficou segurado (${(holdError as Error).message?.slice(0, 200)}) — a sobra da quarentena sai no encerramento`,
          ),
      );
      return { action: 'held' };
    }
  }

  /**
   * `staged` (nova checagem do cron): o aprovado só é copiado para o público, sem apagar a quarentena; a conclusão vence
   * ou perde a troca IN_REVIEW → PROCESSING e então chama settleHeldPromotion. Assim uma confirmação do revisor no meio
   * ainda acha a mídia na quarentena para a evidência.
   */
  private async screenOutputs(
    generationId: string,
    outputs: CheckedMedia[],
    completion: OutputCompletion,
    options: { staged?: boolean } = {},
  ): Promise<OutputCheckOutcome> {
    const generation = (await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: GENERATION_SAFETY_SELECT,
    })) as GenerationForSafety | null;
    if (!generation) return { action: 'held' };

    const scans = await this.prisma.contentSafetyScan.findMany({
      where: { generationId },
      select: {
        stage: true,
        verdict: true,
        mediaKey: true,
        sha256: true,
        createdAt: true,
        scores: true,
      },
    });
    const inputCount = await this.prisma.generationInputImage.count({
      where: { generationId },
    });
    const hasMedia =
      inputCount > 0 || scans.some((row) => isInputStage(row.stage));
    const tool = safetyToolOf({
      jobData: generation.parameters,
      modelUsed: generation.modelUsed,
      type: generation.type,
    });
    const thresholds = this.config.thresholds;
    const base: Omit<RequestContext, 'surface'> = {
      userId: generation.userId,
      generationId,
      model: outputSafetyModelOf(
        generation.modelUsed,
        completion.modelUsed,
        generation.parameters,
      ),
      tool,
      type: generation.type,
      hasUserMedia: hasMedia,
      sexual: {
        classifier: textSexualFromScans(scans),
        inputNudity: inputNudityFromScans(scans, thresholds.nudityMin),
      },
      prompt: finalPromptOf(tool, generation.prompt, generation.parameters),
      negativePrompt: generation.negativePrompt,
    };
    const ctx: RequestContext = {
      ...base,
      surface: surfaceOf(base, thresholds),
    };
    const input = inputSummaryFromScans(scans, hasMedia);
    const batchAt = new Date();

    const visual = outputs.filter((item) => item.kind !== 'audio');
    const reads = await mapLimited(visual, SCAN_CONCURRENCY, (item) =>
      this.readMedia(item, 'OUTPUT'),
    );
    await this.judgeStylized(reads, ctx);
    const decisions = reads.map((read) =>
      this.decideOutputMedia(read, ctx, input),
    );
    const acted = decisions.filter((decision) => decision.acted);
    const worst = acted.length
      ? combineOutputVerdicts(acted.map((decision) => decision.acted!))
      : null;
    const model = completion.modelUsed || generation.modelUsed;
    const writeAll = () =>
      this.writeScans(
        decisions.flatMap((decision) =>
          this.outputRows(decision, ctx, generation),
        ),
        batchAt,
      );

    if (worst?.disposition === 'evidence') {
      const eventId = await this.recordEvent(
        ContentSafetyEventKind.OUTPUT_MINOR_BLOCKED,
        `output:${model}`,
        matchOf(worst),
        generation,
      );
      const blocked = new Set(
        acted
          .filter((decision) => decision.acted?.verdict === 'BLOCK')
          .map((decision) => decision.read),
      );
      let evidencePending = false;
      for (const decision of decisions) {
        if (blocked.has(decision.read)) {
          const evidence = await this.applyEvidence(decision.read, 'keep');
          decision.evidenceKey = evidence.key;
          evidencePending ||= evidence.failed;
          await this.addToBlocklist(decision, eventId, 'output');
        }
      }
      // o resto do resultado de uma geração barrada também não é publicado
      for (const item of outputs) {
        if (
          item.location &&
          ![...blocked].some((read) => read.media === item)
        ) {
          await this.deleteQuietly(item.location);
        }
      }
      // a foto enviada que levou a esse resultado também é evidência (o encerramento apagaria inputs/<id>/)
      await writeAll();
      evidencePending ||= await this.preserveInputsAsEvidence(generation, {
        ruleId: ruleOf(worst),
        strength: worst.strength,
      });
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId} model=${model}: resultado barrado (${matchOf(worst)})${evidencePending ? ' — evidência pendente, entradas mantidas' : ''}`,
      );
      await this.applyStrike(generation.userId, worst.strength, eventId, {
        layer: 'output',
        match: matchOf(worst),
        generationId,
      });
      return {
        action: 'blocked',
        error: new OutputImageSafetyBlockError(ruleOf(worst), worst.strength, {
          evidencePending,
        }),
      };
    }

    if (worst?.disposition === 'hold') {
      const eventId = await this.recordEvent(
        ContentSafetyEventKind.OUTPUT_HELD,
        `output:${model}`,
        matchOf(worst),
        generation,
      );
      await writeAll();
      await this.holdOutput(generationId, outputs, completion);
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId} model=${model}: resultado segurado para revisão (${matchOf(worst)})`,
      );
      await this.applyStrike(generation.userId, worst.strength, eventId, {
        layer: 'output',
        match: matchOf(worst),
        generationId,
      });
      return { action: 'held' };
    }

    if (worst?.disposition === 'retry') {
      await writeAll();
      // conta suspensa: o resultado espera o revisor (nunca sai sozinho quando a checagem volta)
      if (await this.accountSuspended(generation.userId)) {
        return this.holdForSuspendedAccount(
          generation,
          outputs,
          completion,
          model,
        );
      }
      await this.holdOutput(generationId, outputs, completion);
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId} model=${model}: resultado aguardando checagem (indisponível)`,
      );
      return { action: 'held' };
    }

    await writeAll();
    // conta suspensa enquanto o provedor gerava: o resultado limpo também não é publicado, espera o revisor
    if (await this.accountSuspended(generation.userId)) {
      return this.holdForSuspendedAccount(
        generation,
        outputs,
        completion,
        model,
      );
    }
    if (options.staged) {
      const copies = await this.copyAllToPublic(outputs, reads);
      if (!copies) {
        await this.holdOutput(generationId, outputs, completion);
        return { action: 'held' };
      }
      return { action: 'promote', outputs: copies.urls, staged: copies.staged };
    }
    const promoted = await this.promoteAll(outputs, reads);
    if (!promoted) {
      await this.holdOutput(generationId, outputs, completion);
      return { action: 'held' };
    }
    return { action: 'promote', outputs: promoted };
  }

  /**
   * Publica todo o resultado (quarentena → público) em duas fases: 1) copia TODAS as saídas para o público sem apagar
   * nada da quarentena (copyAllToPublic); 2) só então apaga as cópias da quarentena. Nada é publicado nem apagado pela
   * metade.
   */
  private async promoteAll(
    outputs: CheckedMedia[],
    reads: MediaRead[],
  ): Promise<string[] | null> {
    const copies = await this.copyAllToPublic(outputs, reads);
    if (!copies) return null;
    for (const done of copies.staged) {
      await this.uploads.deleteQuarantineObject(done.quarantineKey);
    }
    return copies.urls;
  }

  /**
   * 1ª fase da promoção: copia TODAS as saídas para o público sem apagar nada da quarentena. Se alguma cópia falhar,
   * apaga as cópias públicas já feitas e devolve null (a quarentena fica inteira para a nova tentativa).
   */
  private async copyAllToPublic(
    outputs: CheckedMedia[],
    reads: MediaRead[],
  ): Promise<{ urls: string[]; staged: StagedPromotion[] } | null> {
    const urls: string[] = [];
    const copied: StagedPromotion[] = [];
    for (const item of outputs) {
      if (item.location?.area !== 'quarantine') {
        urls.push(
          item.url ??
            (item.location ? this.uploads.getPublicUrl(item.location.key) : ''),
        );
        continue;
      }
      const read = reads.find((candidate) => candidate.media === item);
      try {
        const promoted = await this.uploads.copyQuarantineToPublic(
          item.location.key,
          {
            body: read?.body ?? undefined,
            contentType: read?.contentType ?? item.mimeType,
          },
        );
        copied.push({
          quarantineKey: item.location.key,
          publicKey: promoted.key,
        });
        urls.push(promoted.url);
      } catch (error) {
        this.logger.error(
          `[IMAGE_SAFETY] ${item.location.key}: promoção da quarentena falhou (${(error as Error).message?.slice(0, 200)}) — cópias públicas desfeitas`,
        );
        for (const done of copied) {
          await this.deleteQuietly({ area: 'public', key: done.publicKey });
        }
        return null;
      }
    }
    if (urls.filter(Boolean).length !== outputs.length) {
      for (const done of copied) {
        await this.deleteQuietly({ area: 'public', key: done.publicKey });
      }
      return null;
    }
    return { urls, staged: copied };
  }

  /**
   * 2ª fase da promoção do cron (cópias feitas com a quarentena inteira): quem venceu a conclusão apaga a quarentena;
   * quem perdeu (o revisor confirmou ou liberou antes, o prazo encerrou) apaga as próprias cópias públicas, que têm
   * chave nova (promotedKeyOf) e não são de mais ninguém. Nunca lança.
   */
  async settleHeldPromotion(
    generationId: string,
    staged: readonly StagedPromotion[],
    won: boolean,
  ): Promise<void> {
    for (const item of staged) {
      try {
        if (won) {
          await this.uploads.deleteQuarantineObject(item.quarantineKey);
        } else {
          await this.uploads.deleteStoredObject('public', item.publicKey);
        }
      } catch (error) {
        this.logger.error(
          `[IMAGE_SAFETY] gen=${generationId}: ${won ? `quarentena ${item.quarantineKey}` : `cópia pública ${item.publicKey}`} não apagada depois da conclusão (${(error as Error).message?.slice(0, 200)})${won ? '' : ' — apagar à mão'}`,
        );
      }
    }
  }

  /** Geração IN_REVIEW com a saída guardada (parameters.safetyHold), para o cron ou o revisor concluírem depois. */
  private async holdOutput(
    generationId: string,
    outputs: CheckedMedia[],
    completion: OutputCompletion,
  ): Promise<void> {
    const current = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { parameters: true },
    });
    // a nova checagem do cron não reinicia o prazo: vale a hora em que o resultado foi segurado pela 1ª vez
    const previous = current ? holdOf(current.parameters) : null;
    const hold: SafetyHoldRecord = {
      stage: 'output',
      outputs: outputs
        .filter((item) => item.location)
        .map((item) => ({
          area: item.location!.area,
          key: item.location!.key,
          mimeType: item.mimeType,
        })),
      modelUsed: completion.modelUsed,
      provider: completion.provider,
      processingTimeMs: completion.processingTimeMs,
      heldAt: previous?.heldAt ?? new Date().toISOString(),
      alertedAt: previous?.alertedAt ?? null,
    };
    await this.prisma.generation.updateMany({
      where: {
        id: generationId,
        status: {
          in: [GenerationStatus.PROCESSING, GenerationStatus.IN_REVIEW],
        },
      },
      data: {
        status: GenerationStatus.IN_REVIEW,
        parameters: {
          ...asRecord(current?.parameters),
          safetyHold: hold,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /* ════════════════════════════════════════════════════════════ refinador */

  /**
   * Saída do agente refinador (prompt reescrito no servidor) pelo leitor de sentido, depois da trava da Onda 0. Acusada
   * e agindo = REFINER_BLOCKED + bloqueio terminal (o prompt reescrito não é gravado). Indisponível segue: o refinador
   * só roda sem foto, em modelo com filtro, e a trava determinística já leu o texto. Com o texto off: null.
   */
  async checkRefinedPrompt(
    generationId: string,
    refinedPrompt: string,
    model: string,
  ): Promise<UnverifiedContentBlockError | null> {
    if (!this.textEnabled) return null;
    try {
      const generation = (await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: GENERATION_SAFETY_SELECT,
      })) as GenerationForSafety | null;
      const text = await this.classifyText(
        { prompt: null, negative: null, serverPrompt: refinedPrompt },
        false,
        'refiner',
      );
      const acts =
        text.verdict !== 'CLEAN' && this.textClassifier.shouldAct(text);
      await this.writeScans(
        [
          this.textRow(
            text,
            { id: generationId, userId: generation?.userId ?? null },
            acts,
            REFINER_TEXT_MEDIA_KEY,
          ),
        ],
        new Date(),
      );
      if (!acts || text.verdict !== 'BLOCK') return null;
      const refinerMatch = `${text.ruleId ?? 'sem-regra'}/${text.strength}`;
      const eventId = await this.recordEvent(
        ContentSafetyEventKind.REFINER_BLOCKED,
        `refiner:${model || generation?.modelUsed || 'desconhecido'}`,
        refinerMatch,
        { id: generationId, userId: generation?.userId ?? null },
      );
      await this.applyStrike(
        generation?.userId ?? null,
        text.strength,
        eventId,
        { layer: 'refiner', match: refinerMatch, generationId },
      );
      return new UnverifiedContentBlockError(
        'refined prompt flagged by the text classifier',
        model,
        'refiner_flagged',
      );
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId}: leitura do prompt reescrito falhou (${(error as Error).message?.slice(0, 200)}) — segue com a trava determinística`,
      );
      return null;
    }
  }

  /* ════════════════════════════════════════════════════════════ quarentena (cron) */

  /** Por que a geração está IN_REVIEW, desde quando e o que está guardado. null = não está IN_REVIEW. */
  async holdStateOf(generationId: string): Promise<HoldState | null> {
    const generation = (await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: GENERATION_SAFETY_SELECT,
    })) as GenerationForSafety | null;
    if (!generation || generation.status !== GenerationStatus.IN_REVIEW) {
      return null;
    }
    const scans = await this.prisma.contentSafetyScan.findMany({
      where: { generationId },
      select: {
        stage: true,
        verdict: true,
        mediaKey: true,
        sha256: true,
        createdAt: true,
        enforced: true,
      },
    });
    const hold = holdOf(generation.parameters);
    const heldAt = hold
      ? new Date(hold.heldAt)
      : (generation.safetyCheckedAt ?? generation.updatedAt);
    const alertedAt = hold?.alertedAt ? new Date(hold.alertedAt) : null;
    return {
      reason: holdReasonOf(scans, hold !== null),
      heldAt: Number.isFinite(heldAt.getTime()) ? heldAt : generation.updatedAt,
      hold,
      modelUsed: hold?.modelUsed || generation.modelUsed,
      alertedAt:
        alertedAt && Number.isFinite(alertedAt.getTime()) ? alertedAt : null,
    };
  }

  /** Grava que o aviso de revisão vencida foi dado (parameters.safetyHold.alertedAt). Nunca lança. */
  async markReviewAlerted(generationId: string): Promise<void> {
    try {
      const current = await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: { parameters: true },
      });
      const hold = current ? holdOf(current.parameters) : null;
      if (!hold) return;
      await this.prisma.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.IN_REVIEW },
        data: {
          parameters: {
            ...asRecord(current?.parameters),
            safetyHold: { ...hold, alertedAt: new Date().toISOString() },
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId}: aviso de revisão vencida não gravado (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  /**
   * Checa de novo o resultado guardado (aguardando checagem). null = sem saída guardada. Aprovado volta com `staged`:
   * a quarentena só sai em settleHeldPromotion, depois da conclusão.
   */
  async recheckHeldOutput(
    generationId: string,
  ): Promise<OutputCheckOutcome | null> {
    const state = await this.holdStateOf(generationId);
    if (!state?.hold) return null;
    // nada guardado para checar (resultado fora do storage): só o prazo encerra
    if (state.hold.outputs.length === 0) return { action: 'held' };
    const outputs = this.heldOutputs(state.hold);
    try {
      return await this.screenOutputs(generationId, outputs, state.hold, {
        staged: true,
      });
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId}: nova checagem da quarentena falhou (${(error as Error).message?.slice(0, 200)})`,
      );
      return { action: 'held' };
    }
  }

  /**
   * Libera sem checagem (só provedor com filtro de confiança, depois de 10 min sem checagem): copia para o público e
   * grava a checagem como UNAVAILABLE não agida, com o motivo. A quarentena só sai em settleHeldPromotion, depois da
   * conclusão. null = cópia falhou (segue segurada).
   */
  async releaseUncheckedOutput(
    generationId: string,
    reason: string,
  ): Promise<{ outputs: string[]; staged: StagedPromotion[] } | null> {
    const state = await this.holdStateOf(generationId);
    if (!state?.hold || state.hold.outputs.length === 0) return null;
    // conta suspensa: nada sai sem checagem (a nova checagem do cron passa o resultado para o revisor)
    if (await this.suspendedOwnerOf(generationId)) return null;
    const outputs = this.heldOutputs(state.hold);
    const copies = await this.copyAllToPublic(outputs, []);
    if (!copies) return null;
    const verdict = unavailableOutputVerdict(reason);
    await this.writeScans(
      outputs
        .filter((item) => item.kind !== 'audio')
        .map((item) =>
          this.row({
            generationId,
            userId: null,
            stage: 'OUTPUT',
            mediaKey: item.location?.key ?? null,
            sha256: null,
            phash: null,
            scores: { reason },
            verdict: verdict.verdict,
            ruleId: verdict.ruleId,
            strength: verdict.strength,
            enforced: false,
            scanner: 'release',
            region: null,
            latencyMs: null,
            evidenceKey: null,
            layer: 'image',
          }),
        ),
      new Date(),
    );
    this.logger.warn(
      `[IMAGE_SAFETY] gen=${generationId}: resultado liberado sem checagem (${reason})`,
    );
    return { outputs: copies.urls, staged: copies.staged };
  }

  /**
   * Resultado que venceu sem checagem: apaga onde estiver (quarentena e também o público, quando não havia bucket de
   * quarentena), menos o que já é evidência; nada indicou suspeita. Sem o registro da saída (parâmetros limpos, hold
   * que não chegou a ser gravado), apaga a pasta da geração na quarentena.
   */
  async discardHeldOutput(generationId: string): Promise<void> {
    const state = await this.holdStateOf(generationId);
    if (!state) return;
    if (!state.hold) {
      await this.discardQuarantineFolder(generationId);
      return;
    }
    for (const item of state.hold.outputs) {
      if (item.area !== 'evidence') {
        await this.deleteQuietly({ area: item.area, key: item.key });
      }
    }
  }

  /**
   * Geração encerrada sem publicar (falha comum, bloqueio): apaga a sobra do resultado na quarentena (upload parcial,
   * hold que não foi gravado). Só com a quarentena gravando (modo ligado); com o modo off não faz nada. Nunca lança.
   */
  async discardFailedOutputs(generationId: string): Promise<void> {
    if (!this.uploads.quarantineEnabled) return;
    await this.discardQuarantineFolder(generationId);
  }

  private async discardQuarantineFolder(generationId: string): Promise<void> {
    if (!this.uploads.quarantineConfigured) return;
    try {
      await this.uploads.deleteQuarantinePrefix(
        `${GENERATION_OUTPUT_ROOT}/${generationId}/`,
      );
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId}: sobra da quarentena não apagada (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  /**
   * Resultado segurado para revisão (S2b, S3, S4, S7) sem decisão do revisor no prazo: NUNCA é publicado. Vai inteiro
   * para a evidência (sem entrar na lista de bloqueio, que é só para a confirmação do revisor); com sinal médio ou
   * forte, as entradas também. Devolve o erro do encerramento (código público genérico) com `evidencePending` quando
   * alguma cópia falhou. `knownHold`: o registro lido antes da trava por quem já trocou IN_REVIEW → PROCESSING (a
   * confirmação do revisor); sem ele, relê pelo holdStateOf, que só enxerga a geração ainda IN_REVIEW.
   */
  async expireReviewedOutput(
    generationId: string,
    knownHold?: SafetyHoldRecord | null,
  ): Promise<OutputImageSafetyBlockError> {
    const heldOutputs =
      knownHold !== undefined
        ? (knownHold?.outputs ?? [])
        : ((await this.holdStateOf(generationId))?.hold?.outputs ?? []);
    const rows = await this.prisma.contentSafetyScan.findMany({
      where: { generationId, stage: { in: ['OUTPUT', 'OUTPUT_FRAME'] } },
      select: {
        stage: true,
        verdict: true,
        mediaKey: true,
        sha256: true,
        createdAt: true,
        enforced: true,
        ruleId: true,
        strength: true,
      },
    });
    const held = latestScanBatch(rows).filter(
      (row) =>
        (row.verdict === 'HOLD' || row.verdict === 'BLOCK') &&
        row.enforced !== false,
    );
    const worst = held.reduce<(typeof held)[number] | null>(
      (best, row) =>
        !best ||
        (STRENGTH_RANK[row.strength as Strength] ?? 0) >
          (STRENGTH_RANK[best.strength as Strength] ?? 0)
          ? row
          : best,
      null,
    );
    let evidencePending = false;
    for (const item of heldOutputs) {
      if (item.area === 'evidence') continue;
      try {
        const evidenceKey = await this.uploads.moveToEvidence(
          item.area,
          item.key,
          null,
          { contentType: item.mimeType },
        );
        await this.prisma.contentSafetyScan
          .updateMany({
            where: { generationId, mediaKey: item.key },
            data: { evidenceKey },
          })
          .catch(() => undefined);
      } catch (error) {
        evidencePending = true;
        this.logger.error(
          `[IMAGE_SAFETY] gen=${generationId}: resultado segurado ${item.key} não foi para a evidência (${(error as Error).message?.slice(0, 200)})`,
        );
      }
    }
    const strength = (worst?.strength as Strength | undefined) ?? 'NONE';
    if (strength === 'MEDIUM' || strength === 'STRONG') {
      const generation = (await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: GENERATION_SAFETY_SELECT,
      })) as GenerationForSafety | null;
      if (generation) {
        evidencePending ||= await this.preserveInputsAsEvidence(generation, {
          ruleId: worst?.ruleId ?? null,
          strength,
        });
      }
    }
    return new OutputImageSafetyBlockError(worst?.ruleId ?? null, strength, {
      evidencePending,
    });
  }

  /**
   * Entrada segurada sem decisão do revisor no prazo: a mídia segurada vai para a evidência (sinal médio não decidido)
   * e devolve o erro do encerramento (o mesmo código público de toda regra).
   */
  async expireHeldInput(
    generationId: string,
  ): Promise<PlatformSafetyBlockError> {
    const rows = await this.prisma.contentSafetyScan.findMany({
      where: { generationId, stage: { in: ['INPUT', 'INPUT_FRAME', 'TEXT'] } },
      select: {
        id: true,
        stage: true,
        verdict: true,
        mediaKey: true,
        sha256: true,
        createdAt: true,
        ruleId: true,
        strength: true,
        evidenceKey: true,
      },
    });
    const latest = latestScanBatch(
      rows.filter((row) => row.mediaKey !== REFINER_TEXT_MEDIA_KEY),
    );
    const heldMedia = latest.filter(
      (row) => isInputStage(row.stage) && row.verdict === 'HOLD',
    );
    const moved = new Map<string, string>();
    let evidencePending = false;
    for (const row of heldMedia) {
      if (!row.mediaKey || row.evidenceKey || moved.has(row.mediaKey)) continue;
      const area: StorageArea = row.mediaKey.startsWith('evidence/')
        ? 'evidence'
        : this.uploads.privateInputsEnabled
          ? 'input-private'
          : 'public';
      try {
        moved.set(
          row.mediaKey,
          await this.uploads.moveToEvidence(area, row.mediaKey, row.sha256),
        );
      } catch (error) {
        evidencePending = true;
        this.logger.error(
          `[IMAGE_SAFETY] gen=${generationId}: entrada segurada ${row.mediaKey} não foi para a evidência (${(error as Error).message?.slice(0, 200)})`,
        );
      }
    }
    for (const row of heldMedia) {
      const evidenceKey = row.mediaKey ? moved.get(row.mediaKey) : undefined;
      if (!evidenceKey) continue;
      await this.prisma.contentSafetyScan
        .update({ where: { id: row.id }, data: { evidenceKey } })
        .catch(() => undefined);
    }
    if (heldMedia.length > 0) {
      const worst = heldMedia[0];
      return new InputImageSafetyBlockError(
        worst.ruleId,
        worst.strength as Strength,
        { evidencePending },
      );
    }
    const textHold = latest.find(
      (row) => row.stage === 'TEXT' && row.verdict === 'HOLD',
    );
    return new TextSafetyBlockError(
      textHold?.ruleId ?? null,
      (textHold?.strength as Strength | undefined) ?? 'NONE',
      { evidencePending },
    );
  }

  private heldOutputs(hold: SafetyHoldRecord): CheckedMedia[] {
    return hold.outputs.map((item) => ({
      kind: kindOf(null, item.mimeType, item.key),
      location: { area: item.area, key: item.key },
      mimeType: item.mimeType,
      url: null,
    }));
  }

  /* ════════════════════════════════════════════════════════════ camada 6 (pontos e suspensão) */

  /**
   * Sinal de cancelamento da conta suspensa, para o processor conferir no começo de cada passo com UMA linha:
   * `await this.imageSafety?.haltIfAccountSuspended(jobData)`. Conta suspensa lança AccountSuspendedSafetyError
   * (terminal, código genérico, estorno, entradas mantidas). O preflight já confere o mesmo no começo de todo job.
   * Com IMAGE_SAFETY_MODE=off nunca lança.
   */
  async haltIfAccountSuspended(jobData: unknown): Promise<void> {
    const userId = stringOr(asRecord(jobData).userId);
    if (await this.accountSuspended(userId)) {
      throw new AccountSuspendedSafetyError();
    }
  }

  /**
   * O mesmo sinal, pela geração: os desvios do processor só têm o id (assertSafetyFallbackAllowed). Com
   * IMAGE_SAFETY_MODE=off não lê nada. Erro de banco lança: o job segue o caminho comum de falha e a nova tentativa
   * passa de novo pelo preflight, que confere a conta antes do provedor.
   */
  async haltIfGenerationOwnerSuspended(generationId: string): Promise<void> {
    if (!this.strikes?.enabled) return;
    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { userId: true },
    });
    if (await this.accountSuspended(generation?.userId ?? null)) {
      throw new AccountSuspendedSafetyError();
    }
  }

  /**
   * Conta suspensa: os resultados dela que esperam checagem na quarentena passam a esperar o revisor (nunca saem
   * sozinhos quando a checagem volta, nem pela liberação de provedor com filtro). Devolve quantos. Usado pela suspensão.
   */
  async holdUncheckedOutputsOfAccount(userId: string): Promise<number> {
    if (!this.strikes?.enabled) return 0;
    const generations = await this.prisma.generation.findMany({
      where: { userId, status: GenerationStatus.IN_REVIEW },
      select: { id: true },
      take: 500,
    });
    let held = 0;
    for (const { id } of generations) {
      try {
        const state = await this.holdStateOf(id);
        if (state?.reason !== 'output_unchecked' || !state.hold) continue;
        await this.recordEvent(
          ContentSafetyEventKind.OUTPUT_HELD,
          `output:${state.modelUsed || 'desconhecido'}`,
          `${ACCOUNT_SUSPENDED_RULE}/NONE`,
          { id, userId },
        );
        await this.writeScans(
          suspensionHoldRows({
            generationId: id,
            userId,
            mediaKeys: state.hold.outputs.map((item) => item.key),
            mode: this.config.imageMode === 'enforce' ? 'enforce' : 'shadow',
          }),
          new Date(),
        );
        held++;
      } catch (error) {
        this.logger.error(
          `[IMAGE_SAFETY] gen=${id}: resultado da conta suspensa não passou para o revisor (${(error as Error).message?.slice(0, 200)})`,
        );
      }
    }
    return held;
  }

  /** A conta está suspensa? Só com a camada 6 ligada. Erro de banco lança: quem chama fecha (espera ou segura). */
  private async accountSuspended(userId: string | null): Promise<boolean> {
    if (!this.strikes?.enabled || !userId) return false;
    return this.strikes.isSuspended(userId);
  }

  /** Dono da geração suspenso? Erro de leitura conta como suspenso (nada sai sem checagem). */
  private async suspendedOwnerOf(generationId: string): Promise<boolean> {
    if (!this.strikes?.enabled) return false;
    try {
      const generation = await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: { userId: true },
      });
      return await this.accountSuspended(generation?.userId ?? null);
    } catch {
      return true;
    }
  }

  private async photoRetryAllowed(
    userId: string | null,
    currentGenerationId: string | null,
  ): Promise<boolean> {
    if (!this.strikes?.enabled || !userId) return true;
    return this.strikes.photoRetryAllowed(userId, { currentGenerationId });
  }

  /** Rota sem fila: motivo interno da recusa da camada 6 (null = segue). Erro de leitura recusa (fecha). */
  private async syncRefusalOf(
    userId: string | null,
    generationId: string | null,
    hasMedia: boolean,
  ): Promise<string | null> {
    try {
      if (await this.accountSuspended(userId)) return 'conta suspensa';
      if (hasMedia && !(await this.photoRetryAllowed(userId, generationId))) {
        return 'limite de novas tentativas com foto depois de um bloqueio';
      }
      return null;
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] conta ${userId ?? 'sem conta'}: camada 6 sem leitura (${(error as Error).message?.slice(0, 200)}) — checagem recusada`,
      );
      return 'camada 6 indisponível';
    }
  }

  /** Ponto ou suspensão de um bloqueio ou retenção que agiu (depois do evento e das checagens gravados). Nunca lança. */
  private async applyStrike(
    userId: string | null,
    strength: Strength,
    eventId: string | null,
    ctx: StrikeSignalContext,
  ): Promise<void> {
    if (!this.strikes?.enabled || !userId) return;
    try {
      await this.strikes.applySignal(userId, strength, eventId, ctx);
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] conta ${userId}: ponto não aplicado (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  /**
   * Fotos e quadros barrados ou segurados com sinal forte ou médio, para a repetição por hash. O caso leve nunca entra
   * (LGPD art. 14: dele não se guarda nada derivado da foto).
   */
  private strikePhotos(
    decisions: ReadonlyArray<MediaDecision<RuledInputVerdict>>,
  ): StrikePhoto[] {
    const photos: StrikePhoto[] = [];
    for (const decision of decisions) {
      decision.read.images.forEach((item, index) => {
        const verdict = decision.perImage[index];
        if (
          !verdict ||
          (verdict.verdict !== 'BLOCK' && verdict.verdict !== 'HOLD') ||
          (verdict.strength !== 'STRONG' && verdict.strength !== 'MEDIUM')
        ) {
          return;
        }
        const match = item.signals.hashMatch;
        photos.push({
          phash: item.signals.phash,
          sha256: decision.read.sha256,
          blockId: match?.source === 'blocklist' ? match.blockId : null,
        });
      });
    }
    return photos;
  }

  /**
   * Resultado de conta suspensa: não é publicado. Fica na quarentena como "em revisão" (linhas HOLD com a regra interna
   * ACCOUNT_SUSPENDED, evento OUTPUT_HELD que segura a geração na guarda legal) até o revisor decidir; sem decisão no
   * prazo, vai para a evidência como todo resultado em revisão.
   */
  private async holdForSuspendedAccount(
    generation: GenerationForSafety,
    outputs: CheckedMedia[],
    completion: OutputCompletion,
    model: string,
  ): Promise<OutputCheckOutcome> {
    await this.recordEvent(
      ContentSafetyEventKind.OUTPUT_HELD,
      `output:${model}`,
      `${ACCOUNT_SUSPENDED_RULE}/NONE`,
      generation,
    );
    await this.writeScans(
      suspensionHoldRows({
        generationId: generation.id,
        userId: generation.userId,
        mediaKeys: outputs.map((item) => item.location?.key),
        mode: this.config.imageMode === 'enforce' ? 'enforce' : 'shadow',
      }),
      new Date(),
    );
    await this.holdOutput(generation.id, outputs, completion);
    this.logger.warn(
      `[IMAGE_SAFETY] gen=${generation.id} model=${model}: conta suspensa — resultado segurado para o revisor`,
    );
    return { action: 'held' };
  }

  /* ════════════════════════════════════════════════════════════ leitura */

  private async readMedia(
    media: CheckedMedia,
    family: 'INPUT' | 'OUTPUT',
    options: SafetyCallOptions = {},
    inMemory: Buffer | null = null,
  ): Promise<MediaRead> {
    const read: MediaRead = {
      media,
      sha256: null,
      body: null,
      contentType: media.mimeType,
      images: [],
      video: media.kind === 'video',
      failure: null,
    };
    if (!media.location && !inMemory) {
      read.failure = { provider: 'storage', failure: 'invalid_media' };
      return read;
    }
    try {
      if (inMemory) {
        read.body = inMemory;
      } else {
        const stored = await this.uploads.readStoredObject(
          media.location!.area,
          media.location!.key,
          media.kind === 'video' ? VIDEO_READ_MAX_BYTES : IMAGE_READ_MAX_BYTES,
          { signal: options.signal, timeoutMs: options.timeoutMs },
        );
        read.body = stored.body;
        read.contentType = stored.contentType ?? media.mimeType;
      }
      read.sha256 = sha256Hex(read.body);

      if (read.video) {
        const frames = await this.media.sampleVideoFrames(
          read.body,
          videoExtensionOf(media),
          this.config.video,
        );
        if (frames.length === 0) {
          throw new SafetyProviderUnavailableError('ffmpeg', 'invalid_media');
        }
        const images: NormalizedImage[] = [];
        for (const frame of frames) {
          const [normalized] = await this.media.normalizeImage(
            frame.jpeg,
            'image/jpeg',
          );
          if (!normalized) continue;
          images.push({
            ...normalized,
            sha256: read.sha256,
            frame: frame.position,
          });
        }
        const stage: ScanStage =
          family === 'INPUT' ? 'INPUT_FRAME' : 'OUTPUT_FRAME';
        read.images = await mapLimited(images, SCAN_CONCURRENCY, (image) =>
          this.scanImage(image, stage, options),
        );
        return read;
      }

      const cached = await this.cachedSignals(read.sha256, family);
      if (cached) {
        read.images = [{ stage: family, image: null, signals: cached }];
        return read;
      }
      const normalized = await this.media.normalizeImage(
        read.body,
        read.contentType,
      );
      const stage: ScanStage =
        normalized.length > 1
          ? family === 'INPUT'
            ? 'INPUT_FRAME'
            : 'OUTPUT_FRAME'
          : family;
      read.images = await mapLimited(normalized, SCAN_CONCURRENCY, (image) =>
        this.scanImage(image, stage, options),
      );
    } catch (error) {
      read.failure = failureOfError(error);
      read.images = [];
      if (read.failure.provider === 'image-safety') {
        this.logger.warn(
          `[IMAGE_SAFETY] leitura de ${media.location?.key ?? 'mídia em memória'} falhou: ${(error as Error).message?.slice(0, 200)}`,
        );
      }
    }
    return read;
  }

  /** pHash e lista própria primeiro (para no 1º acerto), depois hash conhecido, depois o Rekognition. */
  private async scanImage(
    image: NormalizedImage,
    stage: ScanStage,
    options: SafetyCallOptions,
  ): Promise<ImageRead> {
    const startedAt = Date.now();
    let phash: string;
    try {
      phash = await this.media.phash(image.jpeg);
    } catch {
      throw new SafetyProviderUnavailableError('phash', 'invalid_media');
    }
    let hashMatch = await this.blocklistMatch(phash, image.sha256);
    if (!hashMatch && this.knownHash.enabled) {
      hashMatch = await this.knownHash.match(image, options);
    }
    if (hashMatch) {
      return {
        stage,
        image,
        signals: {
          faces: [],
          labels: [],
          moderation: [],
          illustrated: false,
          cropPassRan: false,
          phash,
          sha256: image.sha256,
          hashMatch,
          stylized: { status: 'not_run' },
          frame: image.frame,
          scanner:
            hashMatch.source === 'known-csam' ? 'known-hash' : 'blocklist',
          region: null,
          latencyMs: Date.now() - startedAt,
        },
      };
    }
    if (!this.scanner) {
      throw new SafetyProviderUnavailableError('rekognition', 'not_configured');
    }
    const result = await this.scanner.detect(image, options);
    return {
      stage,
      image,
      signals: {
        ...result,
        phash,
        sha256: image.sha256,
        hashMatch: null,
        stylized: { status: 'not_run' },
        frame: image.frame,
      },
    };
  }

  private async blocklistMatch(
    phash: string | null,
    sha256: string | null,
  ): Promise<ScanSignals['hashMatch']> {
    try {
      return await this.blocklist.match(
        phash,
        sha256,
        this.config.thresholds.phashMaxDistance,
      );
    } catch (error) {
      if (error instanceof SafetyProviderUnavailableError) throw error;
      throw new SafetyProviderUnavailableError('blocklist', 'server_error');
    }
  }

  /** O cache de sinais por sha256 vale? (juiz e hash conhecido ligados precisam da imagem; limite de nudez ≥ 50) */
  private get signalCacheEnabled(): boolean {
    return (
      !this.judge.enabled &&
      !this.knownHash.enabled &&
      this.config.thresholds.nudityMin >= CACHED_MODERATION_MIN
    );
  }

  /**
   * Sinais de uma checagem recente do MESMO arquivo (sha256), com as regras atuais e pelo leitor de verdade (nunca de
   * outra leitura do cache, para o prazo de 30 dias não renovar sozinho). A lista de bloqueio é conferida de novo.
   */
  private async cachedSignals(
    sha256: string,
    family: 'INPUT' | 'OUTPUT',
  ): Promise<ScanSignals | null> {
    if (!this.signalCacheEnabled || !this.scanner) return null;
    try {
      const row = await this.prisma.contentSafetyScan.findFirst({
        where: {
          sha256,
          stage: family,
          rulesVersion: RULES_VERSION,
          scanner: this.scanner.name,
          verdict: { not: 'UNAVAILABLE' },
          phash: { not: null },
          createdAt: {
            gte: new Date(Date.now() - SAFETY_TIMING.verdictCacheTtlMs),
          },
        },
        orderBy: { createdAt: 'desc' },
        select: { scores: true, phash: true, sha256: true },
      });
      if (!row) return null;
      const signals = signalsFromScores(row);
      signals.hashMatch = await this.blocklistMatch(row.phash, row.sha256);
      return signals;
    } catch (error) {
      if (error instanceof SafetyProviderUnavailableError) throw error;
      return null;
    }
  }

  /** Juiz de estilizado só em imagem desenhada ou pessoa sem rosto, em pedido sexual, com o juiz ligado. */
  private async judgeStylized(
    reads: MediaRead[],
    ctx: RequestContext,
    options: SafetyCallOptions = {},
  ): Promise<void> {
    if (!this.judge.enabled) return;
    const thresholds = this.config.thresholds;
    for (const read of reads) {
      for (const item of read.images) {
        const signals = item.signals;
        if (
          !item.image ||
          signals.hashMatch ||
          signals.stylized.status === 'judged' ||
          !(signals.illustrated || hasPersonWithoutFace(signals)) ||
          !isSexualRequest(ctx, signals, thresholds)
        ) {
          continue;
        }
        try {
          signals.stylized = await this.judge.judge(item.image, options);
        } catch {
          signals.stylized = { status: 'unavailable', judge: this.judge.name };
        }
      }
    }
  }

  private async classifyText(
    input: TextClassifierInput,
    sexualRequest: boolean,
    source: 'request' | 'refiner',
  ): Promise<TextVerdict> {
    try {
      return await this.textClassifier.classify(input, {
        sexualRequest,
        source,
      });
    } catch {
      return {
        verdict: 'UNAVAILABLE',
        ruleId: 'UNAVAILABLE',
        strength: 'NONE',
        sexualIntent: null,
        sha256: this.textClassifier.textSha256(input),
        results: [],
        reason: 'classificador de texto falhou',
      };
    }
  }

  /** Pistas de pedido sexual (classificador e nudez da entrada) e a superfície, depois de ler tudo. */
  private contextWithHints(
    base: Omit<RequestContext, 'surface'>,
    reads: MediaRead[],
    text: TextVerdict | null,
  ): RequestContext {
    const thresholds = this.config.thresholds;
    const checked = reads.filter((read) => !read.failure);
    const inputNudity =
      checked.length === 0
        ? base.sexual.inputNudity
        : checked.some((read) =>
            read.images.some(
              (item) =>
                nudityScore(item.signals.moderation) >= thresholds.nudityMin ||
                nonExplicitNudityScore(item.signals.moderation) >=
                  thresholds.nudityMin,
            ),
          );
    const withHints: Omit<RequestContext, 'surface'> = {
      ...base,
      sexual: {
        classifier: text ? text.sexualIntent : base.sexual.classifier,
        inputNudity,
      },
    };
    return { ...withHints, surface: surfaceOf(withHints, thresholds) };
  }

  /* ════════════════════════════════════════════════════════════ decisão */

  private actsImage(verdict: InputVerdict | OutputVerdict): boolean {
    return this.actsOn(verdict as InputVerdict);
  }

  private decideInputMedia(
    read: MediaRead,
    ctx: RequestContext,
  ): MediaDecision<RuledInputVerdict> {
    const opts = { childBlockAllSurfaces: this.config.childBlockAllSurfaces };
    const thresholds = this.config.thresholds;
    if (read.failure || read.images.length === 0) {
      const failure = read.failure ?? {
        provider: 'image-safety',
        failure: 'invalid_media' as ProviderFailureKind,
      };
      read.failure = failure;
      const verdict = unavailableInputVerdict(
        `${failure.provider}: ${failure.failure}`,
      );
      return {
        read,
        perImage: [],
        real: verdict,
        acted: this.actsImage(verdict) ? verdict : null,
        evidenceKey: null,
      };
    }
    if (read.video) {
      const video = decideVideoVerdict(
        read.images.map((item) => item.signals),
        ctx,
        thresholds,
        'input',
        null,
        opts,
      );
      const perImage = video.frames.map((frame) => frame.verdict);
      const actedFrames = perImage.filter((verdict) => this.actsImage(verdict));
      let acted: RuledInputVerdict | null = null;
      if (actedFrames.length) {
        const worst = combineInputVerdicts(actedFrames);
        acted =
          worst.ruleId && worst.ruleId !== 'UNAVAILABLE'
            ? { ...worst, ruleId: 'E7', cause: worst.cause ?? worst.ruleId }
            : worst;
      }
      return { read, perImage, real: video.worst, acted, evidenceKey: null };
    }
    const perImage = read.images.map((item) =>
      decideInputVerdict(item.signals, ctx, thresholds, opts),
    );
    const actedImages = perImage.filter((verdict) => this.actsImage(verdict));
    return {
      read,
      perImage,
      real:
        perImage.length === 1 ? perImage[0] : combineInputVerdicts(perImage),
      acted: actedImages.length ? combineInputVerdicts(actedImages) : null,
      evidenceKey: null,
    };
  }

  private decideOutputMedia(
    read: MediaRead,
    ctx: RequestContext,
    input: ReturnType<typeof inputSummaryFromScans>,
  ): MediaDecision<RuledOutputVerdict> {
    const opts = { childBlockAllSurfaces: this.config.childBlockAllSurfaces };
    const thresholds = this.config.thresholds;
    if (read.failure || read.images.length === 0) {
      const failure = read.failure ?? {
        provider: 'image-safety',
        failure: 'invalid_media' as ProviderFailureKind,
      };
      read.failure = failure;
      const verdict = unavailableOutputVerdict(
        `${failure.provider}: ${failure.failure}`,
      );
      return {
        read,
        perImage: [],
        real: verdict,
        acted: this.actsImage(verdict) ? verdict : null,
        evidenceKey: null,
      };
    }
    let perImage: RuledOutputVerdict[];
    let real: RuledOutputVerdict;
    if (read.video) {
      const video = decideVideoVerdict(
        read.images.map((item) => item.signals),
        ctx,
        thresholds,
        'output',
        input,
        opts,
      );
      perImage = video.frames.map((frame) => frame.verdict);
      real = video.worst;
      if (video.priorityReview) {
        this.logger.warn(
          `[IMAGE_SAFETY] gen=${ctx.generationId}: vídeo com 2+ quadros na zona de revisão em modelo sem censura (prioridade)`,
        );
      }
    } else {
      perImage = read.images.map((item) =>
        decideOutputVerdict(item.signals, ctx, thresholds, input, opts),
      );
      real =
        perImage.length === 1 ? perImage[0] : combineOutputVerdicts(perImage);
    }
    const actedImages = perImage.filter((verdict) => this.actsImage(verdict));
    return {
      read,
      perImage,
      real,
      acted: actedImages.length ? combineOutputVerdicts(actedImages) : null,
      evidenceKey: null,
    };
  }

  /* ════════════════════════════════════════════════════════════ ação e registro */

  private async hasConsent(generationId: string): Promise<boolean> {
    try {
      return await this.contentSafety.hasConsentForGeneration(generationId);
    } catch {
      return false;
    }
  }

  private async markChecked(generationId: string): Promise<void> {
    try {
      await this.prisma.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.PROCESSING },
        data: { safetyCheckedAt: new Date() },
      });
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] gen=${generationId}: safetyCheckedAt não gravado (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  /** Evento na trilha (nunca lança; o registro não pode travar a decisão). Excerto nunca: só regra e força. */
  private async recordEvent(
    kind: ContentSafetyEventKind,
    route: string,
    match: string,
    generation: { id: string | null; userId: string | null },
  ): Promise<string | null> {
    return this.contentSafety.record({
      userId: generation.userId,
      kind,
      route,
      match,
      excerpt: null,
      generationId: generation.id,
    });
  }

  /**
   * Evidência (forte/médio): bucket privado; caso leve: apaga. Falha vira log (a decisão já foi tomada) e `failed`
   * quando a mídia devia ser GUARDADA: quem encerra mantém as entradas para a prova não sumir na limpeza.
   */
  private async applyEvidence(
    read: MediaRead,
    action: EvidenceAction,
  ): Promise<EvidenceOutcome> {
    try {
      if (action === 'keep') {
        if (read.media.location) {
          return {
            key: await this.uploads.moveToEvidence(
              read.media.location.area,
              read.media.location.key,
              read.sha256,
              { body: read.body ?? undefined, contentType: read.contentType },
            ),
            failed: false,
          };
        }
        if (read.body) {
          return {
            key: await this.uploads.storeEvidence(
              read.body,
              read.contentType ?? 'application/octet-stream',
              read.sha256,
              'media',
            ),
            failed: false,
          };
        }
        return { key: null, failed: false };
      }
      if (action === 'delete' && read.media.location) {
        await this.uploads.deleteStoredObject(
          read.media.location.area,
          read.media.location.key,
        );
      }
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] evidência de ${read.media.location?.key ?? 'mídia em memória'} não ${action === 'keep' ? 'guardada' : 'apagada'} (${(error as Error).message?.slice(0, 200)})`,
      );
      return { key: null, failed: action === 'keep' };
    }
    return { key: null, failed: false };
  }

  /**
   * Entradas gravadas da geração vão para a evidência (resultado com menor, ou segurado que venceu com sinal médio).
   * Cada uma fica LIGADA à geração: a linha de checagem da entrada ganha o evidenceKey (o sha256 vai na chave e nos
   * metadados do objeto); entrada sem checagem ganha uma linha própria. Devolve true quando alguma não foi (evidência
   * pendente: o encerramento mantém as entradas).
   */
  private async preserveInputsAsEvidence(
    generation: { id: string; userId: string },
    cause: { ruleId: string | null; strength: Strength },
  ): Promise<boolean> {
    const generationId = generation.id;
    let rows: Array<{ url: string | null }> = [];
    try {
      rows = await this.prisma.generationInputImage.findMany({
        where: { generationId },
        select: { url: true },
      });
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] gen=${generationId}: entradas não lidas para a evidência (${(error as Error).message?.slice(0, 200)})`,
      );
      return true;
    }
    let pending = false;
    const unlinked: Prisma.ContentSafetyScanCreateManyInput[] = [];
    for (const row of rows) {
      const location = this.uploads.locateStoredMedia(row.url);
      if (!location || location.area === 'evidence') continue;
      let evidenceKey: string;
      try {
        evidenceKey = await this.uploads.moveToEvidence(
          location.area,
          location.key,
          null,
        );
      } catch (error) {
        pending = true;
        this.logger.error(
          `[IMAGE_SAFETY] gen=${generationId}: entrada ${location.key} não foi para a evidência (${(error as Error).message?.slice(0, 200)})`,
        );
        continue;
      }
      const sha256 =
        /^evidence\/([0-9a-f]{64})\//.exec(evidenceKey)?.[1] ?? null;
      const linked = await this.prisma.contentSafetyScan
        .updateMany({
          where: {
            generationId,
            mediaKey: location.key,
            stage: { in: ['INPUT', 'INPUT_FRAME'] },
          },
          data: { evidenceKey },
        })
        .catch(() => ({ count: 0 }));
      if (linked.count === 0) {
        unlinked.push(
          this.row({
            generationId,
            userId: generation.userId,
            stage: 'INPUT',
            mediaKey: location.key,
            sha256,
            phash: null,
            scores: {
              reason: `entrada de um resultado barrado (${cause.ruleId ?? 'sem regra'})`,
            },
            verdict: 'BLOCK',
            ruleId: null,
            strength: cause.strength,
            enforced: true,
            scanner: 'output-linked',
            region: null,
            latencyMs: null,
            evidenceKey,
            layer: 'image',
          }),
        );
      }
    }
    await this.writeScans(unlinked, new Date());
    return pending;
  }

  private async deleteQuietly(location: StoredMediaLocation): Promise<void> {
    try {
      await this.uploads.deleteStoredObject(location.area, location.key);
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] ${location.key} não apagado (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  /** Lista de bloqueio: cada imagem/quadro barrado com sinal forte ou médio (o caso leve nunca entra). */
  private async addToBlocklist(
    decision: MediaDecision<InputVerdict | OutputVerdict>,
    eventId: string | null,
    origin: 'input' | 'output',
  ): Promise<void> {
    for (const [index, item] of decision.read.images.entries()) {
      const verdict = decision.perImage[index];
      if (
        !verdict ||
        verdict.verdict !== 'BLOCK' ||
        !verdict.addToBlocklist ||
        !item.signals.phash ||
        (verdict.strength !== 'STRONG' && verdict.strength !== 'MEDIUM')
      ) {
        continue;
      }
      try {
        await this.blocklist.add({
          phash: item.signals.phash,
          // o sha256 exato só vale para o arquivo inteiro (quadro e página de GIF ficam só com o pHash)
          sha256:
            decision.read.images.length === 1 && !decision.read.video
              ? decision.read.sha256
              : null,
          strength: verdict.strength,
          origin,
          eventId,
        });
      } catch (error) {
        this.logger.warn(
          `[IMAGE_SAFETY] lista de bloqueio não gravada (${(error as Error).message?.slice(0, 200)})`,
        );
      }
    }
  }

  private inputRows(
    decision: MediaDecision<RuledInputVerdict>,
    ctx: RequestContext,
    generation: { id: string | null; userId: string | null },
  ): Prisma.ContentSafetyScanCreateManyInput[] {
    return this.mediaRows(decision, ctx, generation, 'image');
  }

  private outputRows(
    decision: MediaDecision<RuledOutputVerdict>,
    ctx: RequestContext,
    generation: { id: string | null; userId: string | null },
  ): Prisma.ContentSafetyScanCreateManyInput[] {
    return this.mediaRows(decision, ctx, generation, 'image');
  }

  private mediaRows(
    decision: MediaDecision<InputVerdict | OutputVerdict>,
    ctx: RequestContext,
    generation: { id: string | null; userId: string | null },
    layer: 'image',
  ): Prisma.ContentSafetyScanCreateManyInput[] {
    const { read } = decision;
    const mediaKey = read.media.location?.key ?? null;
    const sexual = isSexualRequest(ctx, undefined, this.config.thresholds);
    // caso leve (criança em pedido não sexual, foto apagada): só o veredito, a regra e a data (LGPD art. 14). Sem
    // hash, sem pHash, sem chave e sem idades; o marcador separa as mídias na leitura da rodada
    if (
      decision.real.strength === 'LIGHT' &&
      decision.real.evidence === 'delete'
    ) {
      const marker = lightMediaMarker(mediaKey);
      const rows = read.images.length
        ? read.images.map((item, index) => ({
            stage: item.stage,
            verdict: decision.perImage[index] ?? decision.real,
            scanner: item.signals.scanner,
          }))
        : [
            {
              stage: (isInputFamily(decision)
                ? 'INPUT'
                : 'OUTPUT') as ScanStage,
              verdict: decision.real,
              scanner: read.failure?.provider ?? 'image-safety',
            },
          ];
      return rows.map(({ stage, verdict, scanner }) =>
        this.row({
          generationId: generation.id,
          userId: generation.userId,
          stage,
          mediaKey: marker,
          sha256: null,
          phash: null,
          scores: { reason: verdict.reason, surface: ctx.surface, sexual },
          verdict: verdict.verdict,
          ruleId: verdict.ruleId,
          strength: verdict.strength,
          enforced: this.actsImage(verdict),
          scanner,
          region: null,
          latencyMs: null,
          evidenceKey: null,
          layer,
        }),
      );
    }
    if (read.failure || read.images.length === 0) {
      return [
        this.row({
          generationId: generation.id,
          userId: generation.userId,
          stage: isInputFamily(decision) ? 'INPUT' : 'OUTPUT',
          mediaKey,
          sha256: read.sha256,
          phash: null,
          scores: {
            reason: decision.real.reason,
            surface: ctx.surface,
            sexual,
          },
          verdict: decision.real.verdict,
          ruleId: decision.real.ruleId,
          strength: decision.real.strength,
          enforced: decision.acted !== null,
          scanner: read.failure?.provider ?? 'image-safety',
          region: null,
          latencyMs: null,
          evidenceKey: decision.evidenceKey,
          layer,
        }),
      ];
    }
    return read.images.map((item, index) => {
      const verdict = decision.perImage[index] ?? decision.real;
      return this.row({
        generationId: generation.id,
        userId: generation.userId,
        stage: item.stage,
        mediaKey,
        sha256: read.sha256,
        phash: item.signals.phash,
        scores: toScanScores(item.signals, {
          surface: ctx.surface,
          sexual: isSexualRequest(ctx, item.signals, this.config.thresholds),
          reason: verdict.reason,
        }),
        verdict: verdict.verdict,
        ruleId: verdict.ruleId,
        strength: verdict.strength,
        enforced: this.actsImage(verdict),
        scanner: item.signals.scanner,
        region: item.signals.region,
        latencyMs: Math.round(item.signals.latencyMs),
        evidenceKey: decision.evidenceKey,
        layer,
      });
    });
  }

  private textRow(
    text: TextVerdict,
    generation: { id: string | null; userId: string | null },
    enforced: boolean,
    mediaKey: string | null,
  ): Prisma.ContentSafetyScanCreateManyInput {
    const first = text.results[0];
    return this.row({
      generationId: generation.id,
      userId: generation.userId,
      stage: 'TEXT',
      mediaKey,
      sha256: text.sha256,
      phash: null,
      scores: {
        text: text.results.map((result) => ({
          classifier: result.classifier,
          violation: result.violation,
          band: result.band,
          policyRuleId: result.policyRuleId,
          score: result.score,
          sexual: result.sexual,
        })),
        ...(text.sexualIntent === null ? {} : { sexual: text.sexualIntent }),
        reason: text.reason,
      },
      verdict: text.verdict,
      ruleId: text.ruleId,
      strength: text.strength,
      enforced,
      scanner: first?.classifier ?? 'text-classifier',
      region: first?.region ?? null,
      latencyMs: text.results.length
        ? Math.round(
            Math.max(...text.results.map((result) => result.latencyMs)),
          )
        : null,
      evidenceKey: null,
      layer: 'text',
    });
  }

  private row(
    input: Omit<ScanRecordInput, 'rulesVersion' | 'mode'> & {
      layer: 'image' | 'text';
    },
  ): Prisma.ContentSafetyScanCreateManyInput {
    const mode =
      input.layer === 'image' ? this.config.imageMode : this.config.textMode;
    return {
      generationId: input.generationId,
      userId: input.userId,
      stage: input.stage,
      mediaKey: input.mediaKey,
      sha256: input.sha256,
      phash: input.phash,
      scores: input.scores as unknown as Prisma.InputJsonValue,
      verdict: input.verdict,
      ruleId: input.ruleId,
      strength: input.strength,
      rulesVersion: RULES_VERSION,
      mode: mode === 'off' ? 'shadow' : mode,
      enforced: input.verdict !== 'CLEAN' && input.enforced,
      scanner: input.scanner,
      region: input.region,
      latencyMs: input.latencyMs,
      evidenceKey: input.evidenceKey,
    };
  }

  /** Grava as checagens de uma rodada com o mesmo createdAt (a última rodada de cada mídia é o grupo mais novo). */
  private async writeScans(
    rows: Prisma.ContentSafetyScanCreateManyInput[],
    batchAt: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.prisma.contentSafetyScan.createMany({
        data: rows.map((row) => ({ ...row, createdAt: batchAt })),
      });
    } catch (error) {
      this.logger.error(
        `[IMAGE_SAFETY] ${rows.length} checagem(ns) não gravada(s) (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }
}

function isInputFamily(
  decision: MediaDecision<InputVerdict | OutputVerdict>,
): boolean {
  return !('disposition' in decision.real);
}
