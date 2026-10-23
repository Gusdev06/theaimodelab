import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAbsolute, relative, resolve, sep } from 'path';
import { isUncensoredModel } from '../content-safety.interceptor';
import type {
  InputRuleId,
  OutputRuleId,
  RuleId,
  SafetyMode,
  SafetyTool,
  Strength,
} from './types';

/**
 * Configuração da segurança de imagem e texto: modos, limites das regras, regiões, buckets e as constantes que as
 * regras usam. Tudo DESLIGADO por padrão (IMAGE_SAFETY_MODE e TEXT_CLASSIFIER_MODE = off): sem env, nada roda e o
 * desvio depois de uma recusa do provedor segue a regra de antes (enforcesMediaPreflight). Valor inválido nunca derruba
 * o boot: vira o padrão seguro e um aviso.
 *
 * Os números são valores iniciais, calibrados na sombra. Mudou regra, limite
 * fixo ou conjunto de rótulos = sobe RULES_VERSION (vai em cada checagem gravada).
 */
export const RULES_VERSION = '2026-10-17.2';

/* ------------------------------------------------------------------ constantes das regras (versionadas) */

/** Idade legal de toda geração. Não é configurável. */
export const ADULT_AGE = 18;
/** E2/S1/S4: rosto com High do AgeRange até aqui é criança evidente. */
export const CHILD_FACE_AGE_HIGH_MAX = 13;
/** E3b: Low do AgeRange até aqui com ponto médio adulto é registrado (sombra). */
export const TEEN_FACE_AGE_LOW_MAX = 15;

/** Rótulos do DetectLabels que contam como criança (com SAFETY_CHILD_LABEL_MIN ou mais). */
export const CHILD_LABELS: ReadonlySet<string> = new Set([
  'Baby',
  'Toddler',
  'Child',
  'Kid',
]);
/** Rótulos que nunca contam como criança: o Rekognition usa "Girl" e "Boy" também para adultos. */
export const NEVER_CHILD_LABELS: ReadonlySet<string> = new Set(['Girl', 'Boy']);
/** Rótulos que indicam pessoa: com menos rostos que pessoas, roda a passada recortada. */
export const PERSON_LABELS: ReadonlySet<string> = new Set([
  'Person',
  'Child',
  'Kid',
  'Baby',
  'Toddler',
]);
/** Confiança mínima de um rótulo de PERSON_LABELS para disparar a passada recortada. */
export const PERSON_LABEL_MIN_CONFIDENCE = 70;
/** Blocos da passada recortada: quadrantes com esta sobreposição (fração do lado), ampliados até 1920 px. */
export const CROP_PASS_OVERLAP = 0.15;
/** Rosto da passada recortada com IoU acima disto contra um rosto já achado é o mesmo rosto (não duplica). */
export const CROP_FACE_DEDUP_IOU = 0.5;

/**
 * Nudez (S1, S2, S3, S7 e definição de pedido sexual): nível 1 "Explicit" e seus filhos na taxonomia v7. Os rótulos
 * de nudez parcial ou implícita ficam em SUGGESTIVE_LABELS (S2b, quarentena), não aqui; "Bare Back" e "Exposed Male
 * Nipple" (homem sem camisa) não contam em lugar nenhum.
 */
export const NUDITY_LABELS: ReadonlySet<string> = new Set([
  'Explicit',
  'Explicit Nudity',
  'Explicit Sexual Activity',
  'Sex Toys',
]);
/** Nudez não explícita: conta para "pedido sexual" (ao lado de NUDITY_LABELS) e para a S2b. */
export const NON_EXPLICIT_NUDITY_LABELS: ReadonlySet<string> = new Set([
  'Partially Exposed Buttocks',
  'Partially Exposed Female Breast',
  'Implied Nudity',
]);
/** S2b: lingerie, nudez parcial ou implícita, partes íntimas cobertas, beijo (com SAFETY_NUDITY_MIN ou mais). */
export const SUGGESTIVE_LABELS: ReadonlySet<string> = new Set([
  'Swimwear or Underwear',
  'Female Swimwear or Underwear',
  'Male Swimwear or Underwear',
  'Partially Exposed Buttocks',
  'Partially Exposed Female Breast',
  'Implied Nudity',
  'Obstructed Intimate Parts',
  'Kissing on the Lips',
]);
/** Tipos de conteúdo do DetectModerationLabels que marcam imagem desenhada (E5, S5, S7). */
export const ILLUSTRATED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'Animated',
  'Illustrated',
]);
/** Confiança mínima para tratar o conteúdo como desenhado. */
export const ILLUSTRATED_MIN_CONFIDENCE = 50;

/** Ferramentas sexuais por natureza, mesmo sem texto da cliente (despir, troca de rosto Unlocked). */
export const SEXUAL_TOOLS: ReadonlySet<SafetyTool> = new Set<SafetyTool>([
  'undress',
  'face_swap_unlocked',
]);

/** Classificador de texto: faixas do omni-moderation (sexual/minors, de 0 a 1). */
export const OMNI_HIGH_SCORE = 0.5;
export const OMNI_MEDIUM_SCORE = 0.15;

/**
 * Prazos (seções 2 e 3). Não são env de propósito: mudam junto com RULES_VERSION.
 *  - preflightRetry*: porteiro fora do ar → o job volta à fila com espera crescente até a janela; depois falha com
 *    estorno ("tente de novo em instantes");
 *  - scannerCallTimeoutMs: cada chamada ao Rekognition, já com a região reserva; syncCheckTimeoutMs: checkInput nas
 *    rotas sem fila (estourou = 503, nunca segue sem checar);
 *  - textClassifierTimeoutMs: safeguard, com 1 nova tentativa na região reserva;
 *  - quarantineMaxUncheckedMs: resultado sem checagem há 2 h falha com estorno;
 *  - trustedFilterReleaseMs: só SAFETY_TRUSTED_FILTER_MODELS liberam sem checagem depois disso;
 *  - inputHoldDecisionMs: entrada segurada (E3a) sem decisão do revisor falha com estorno;
 *  - outputReviewTargetMs: meta da revisão da quarentena (vencida = alerta, nunca libera sozinho);
 *  - outputReviewDecisionMs: resultado segurado para revisão sem decisão: vai para a evidência e falha com estorno
 *    (nunca é publicado sozinho; mesmo prazo da entrada segurada);
 *  - verdictCacheTtlMs: reuso dos sinais por sha256 do arquivo (os sinais, nunca o veredito: o contexto muda); depois
 *    dele, a checagem que não é evidência perde hash, chave e sinais (fica só o veredito, para as métricas);
 *  - storageReadTimeoutMs: cada leitura do storage pela checagem (socket preso não trava o job nem o cron);
 *  - quarantineSweepBudgetMs: tempo máximo de uma rodada do cron da quarentena (o resto fica para a próxima);
 *  - reviewMediaUrlTtlSeconds: URL assinada que o revisor recebe;
 *  - accessLogRetentionDays: registro de acesso (Marco Civil, art. 15).
 */
export const SAFETY_TIMING = Object.freeze({
  preflightRetryWindowMs: 10 * 60_000,
  preflightRetryBaseDelayMs: 30_000,
  preflightRetryMaxDelayMs: 2 * 60_000,
  scannerCallTimeoutMs: 4_000,
  syncCheckTimeoutMs: 5_000,
  textClassifierTimeoutMs: 3_000,
  quarantineMaxUncheckedMs: 2 * 60 * 60_000,
  trustedFilterReleaseMs: 10 * 60_000,
  inputHoldDecisionMs: 24 * 60 * 60_000,
  outputReviewTargetMs: 4 * 60 * 60_000,
  outputReviewDecisionMs: 24 * 60 * 60_000,
  verdictCacheTtlMs: 30 * 24 * 60 * 60_000,
  storageReadTimeoutMs: 30_000,
  quarantineSweepBudgetMs: 4 * 60_000,
  reviewMediaUrlTtlSeconds: 120,
  accessLogRetentionDays: 180,
});

/**
 * Pontos e repetição (camada 6): 3 médios em 90 dias suspendem; 3 bloqueios de foto com hash próximo em 24 h na
 * conta suspendem para revisão; 2 contas com o mesmo hash bloqueado vão as duas para revisão; depois de um bloqueio
 * de foto, no máximo 1 nova tentativa com foto a cada 10 min e 5 em 24 h até a revisão.
 */
export const SAFETY_STRIKES = Object.freeze({
  mediumStrikesToSuspend: 3,
  mediumStrikeWindowDays: 90,
  repeatBlocksToSuspend: 3,
  repeatWindowHours: 24,
  crossAccountMatchesToReview: 2,
  photoRetryPer10Min: 1,
  photoRetryPer24h: 5,
});

/* ------------------------------------------------------------------ o que age em cada modo */

/**
 * Regras que agem desde o 1º dia: sinais fortes ou de provável menor, e o "não deu para checar" (falha do
 * fornecedor nunca libera a mídia). S4 (criança no resultado, sem nudez) entra aqui porque o resultado com criança
 * não pode ser publicado "para medir". A E5 julgada (o juiz de estilizado apontou traço infantil, força média) também
 * age: o documento a liga "quando o juiz chegar", não depois de uma sombra (isDayOneImageRule). O resto (E3b, E4, a E5
 * sem juiz e S3) fica só registrado na sombra.
 */
export const DAY_ONE_IMAGE_RULES: ReadonlySet<
  InputRuleId | OutputRuleId | 'UNAVAILABLE'
> = new Set<InputRuleId | OutputRuleId | 'UNAVAILABLE'>([
  'E1',
  'E2',
  'E3a',
  'E6',
  'E7',
  'S1',
  'S2',
  'S2b',
  'S4',
  'S5',
  'S6',
  'S7',
  'UNAVAILABLE',
]);

/** A regra de imagem age desde o 1º dia? E5 só quando houve julgamento (força diferente de NONE). */
export function isDayOneImageRule(
  ruleId: RuleId | null,
  strength: Strength,
): boolean {
  if (!ruleId) return false;
  if (ruleId === 'E5') return strength !== 'NONE';
  return DAY_ONE_IMAGE_RULES.has(ruleId as InputRuleId | OutputRuleId);
}

export interface EnforcementQuery {
  layer: 'image' | 'text';
  ruleId: RuleId | null;
  strength: Strength;
  /** E7: regra do pior quadro (a força de E7 é a da causa) */
  cause?: RuleId;
}

/**
 * O veredito vira ação (bloqueio, retenção, fila) ou só registro? Regra única para todas as frentes:
 *  - modo off: nada roda, nada age;
 *  - enforce: tudo age;
 *  - shadow + IMAGE_SAFETY_ENFORCE_STRONG: na imagem, só as regras do 1º dia (inclusive UNAVAILABLE); no texto, só a
 *    saída do refinador (T_REFINER) e o sinal forte do classificador. Indisponibilidade do classificador só age em
 *    enforce (na sombra o texto não segura a fila).
 * CLEAN nunca age. O veredito real (GRAY, HOLD…) é gravado em qualquer modo, e o desvio para sem censura continua
 * exigindo preflight 'clean' em qualquer modo diferente de off.
 */
export function isRuleEnforced(
  query: EnforcementQuery,
  config: Pick<ImageSafetyConfig, 'imageMode' | 'textMode' | 'enforceStrong'>,
): boolean {
  if (!query.ruleId) return false;
  const mode = query.layer === 'image' ? config.imageMode : config.textMode;
  if (mode === 'off') return false;
  if (mode === 'enforce') return true;
  if (!config.enforceStrong) return false;
  const ruleId =
    query.ruleId === 'E7' && query.cause ? query.cause : query.ruleId;
  if (query.layer === 'image') {
    // na E7 a força é a da causa (o pior quadro)
    return isDayOneImageRule(ruleId, query.strength);
  }
  if (ruleId === 'UNAVAILABLE') return false;
  return ruleId === 'T_REFINER' || query.strength === 'STRONG';
}

/**
 * O desvio depois de uma recusa do provedor (Unlocked sem censura, prompt reescrito no mesmo provedor) depende da
 * checagem da mídia do usuário? Só com o porteiro de imagem ligado (shadow ou enforce): sem a checagem rodando, o
 * veredito seria sempre 'unavailable' e toda recusa com foto viraria terminal. Com off, vale a regra de antes da
 * checagem (safetyFallbackVerdict: menor encerra; o sem censura com foto só pede o atestado).
 */
export function enforcesMediaPreflight(
  config: Pick<ImageSafetyConfig, 'imageMode'>,
): boolean {
  return config.imageMode !== 'off';
}

/* ------------------------------------------------------------------ configuração lida do env */

export interface SafetyThresholds {
  /** E4/S7: ponto médio de 18 até menos disto é zona de dúvida (SAFETY_AGE_GRAY_MAX, 23) */
  ageGrayMax: number;
  /** S3: ponto médio de 18 até menos disto, com nudez, vai para a quarentena (SAFETY_OUTPUT_REVIEW_AGE_MAX, 21) */
  outputReviewAgeMax: number;
  /** nudez e rótulos de S2b contam a partir disto (SAFETY_NUDITY_MIN, 60) */
  nudityMin: number;
  /** rótulo de criança conta a partir disto (SAFETY_CHILD_LABEL_MIN, 85) */
  childLabelMin: number;
  /** distância de Hamming máxima do pHash para "mesma foto" (SAFETY_PHASH_MAX_DISTANCE, 8) */
  phashMaxDistance: number;
  adultAge: number;
  childFaceAgeHighMax: number;
  teenFaceAgeLowMax: number;
}

export interface VideoSamplingConfig {
  /** teto de quadros por vídeo, com o 1º e o último sempre incluídos (SAFETY_VIDEO_MAX_FRAMES, 12) */
  maxFrames: number;
  /** 1 quadro a cada N segundos (SAFETY_VIDEO_EVERY_SECONDS, 2) */
  everySeconds: number;
  /** corte de cena do ffmpeg, select='gt(scene,X)' (SAFETY_VIDEO_SCENE_THRESHOLD, 0.3) */
  sceneThreshold: number;
}

export interface AwsSafetyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ImageSafetyConfig {
  imageMode: SafetyMode;
  textMode: SafetyMode;
  /** regras do 1º dia agem mesmo em shadow (IMAGE_SAFETY_ENFORCE_STRONG, padrão true; só vale fora do off) */
  enforceStrong: boolean;
  rulesVersion: string;
  thresholds: SafetyThresholds;
  video: VideoSamplingConfig;
  /** Rekognition: São Paulo como principal; reserva null = sem reserva */
  rekognitionRegion: string;
  rekognitionFallbackRegion: string | null;
  /** credenciais próprias da conta AWS de segurança; null = cadeia padrão do SDK (env AWS_*, perfil, papel) */
  awsCredentials: AwsSafetyCredentials | null;
  bedrockRegion: string;
  bedrockFallbackRegion: string | null;
  bedrockSafeguardModelId: string | null;
  /** caminho absoluto, FORA do repositório, da política do classificador; null = classificador desligado */
  policySource: string | null;
  /** omni-moderation em sombra (só registra) quando há chave */
  omniModerationApiKey: string | null;
  quarantineBucket: string | null;
  evidenceBucket: string | null;
  /** provedores com filtro comprovado que podem ser liberados sem checagem depois de 10 min (padrão: nenhum) */
  trustedFilterModels: ReadonlySet<string>;
  /** quem revisa casos de segurança (ids de usuário); separado do papel ADMIN */
  reviewerIds: ReadonlySet<string>;
  /**
   * Foto com criança evidente: true = barra em qualquer pedido (produto só adulto); false = só barra no lado adulto
   * (sem censura, despir, pedido sexual). Padrão true até a decisão de produto.
   */
  childBlockAllSurfaces: boolean;
  hiveApiKey: string | null;
  arachnidApiKey: string | null;
}

/** Lê uma variável de ambiente (ConfigService.get ou process.env). */
export type EnvSource = (key: string) => string | undefined;

export interface LoadedImageSafetyConfig {
  config: ImageSafetyConfig;
  /** um aviso por valor recusado ou combinação incoerente; nunca contém segredo */
  warnings: string[];
}

export const DEFAULT_REKOGNITION_REGION = 'sa-east-1';
export const DEFAULT_REKOGNITION_FALLBACK_REGION = 'us-east-1';
/** Valor que desliga a região reserva (evita a transferência internacional). */
const NO_FALLBACK_REGION = 'none';
const AWS_REGION_FORMAT = /^[a-z]{2}(?:-gov)?-[a-z]+-\d{1,2}$/;
const USER_ID_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;
const MODEL_SLUG_FORMAT = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const BEDROCK_MODEL_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/;
const BUCKET_NAME_FORMAT = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** Nunca provedor de confiança: o caso Grok mostrou que filtro de provedor não basta. */
const NEVER_TRUSTED_FILTER = /grok|spicy|kling|seedance/;

const MODES: ReadonlySet<string> = new Set(['off', 'shadow', 'enforce']);

function text(env: EnvSource, key: string): string {
  const value = env(key);
  return typeof value === 'string' ? value.trim() : '';
}

function readMode(env: EnvSource, key: string, warnings: string[]): SafetyMode {
  const raw = text(env, key).toLowerCase();
  if (!raw) return 'off';
  if (MODES.has(raw)) return raw as SafetyMode;
  warnings.push(`${key} inválido (off, shadow ou enforce); usando off`);
  return 'off';
}

function readBoolean(
  env: EnvSource,
  key: string,
  fallback: boolean,
  warnings: string[],
): boolean {
  const raw = text(env, key).toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  warnings.push(`${key} inválido (true ou false); usando ${String(fallback)}`);
  return fallback;
}

/** Número do env dentro da faixa; ausente = padrão; inválido ou fora da faixa = padrão + aviso. */
function readNumber(
  env: EnvSource,
  key: string,
  fallback: number,
  min: number,
  max: number,
  warnings: string[],
  integer = true,
): number {
  const raw = text(env, key);
  if (!raw) return fallback;
  const pattern = integer ? /^\d+$/ : /^\d+(?:\.\d+)?$/;
  const value = Number(raw);
  if (
    !pattern.test(raw) ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    warnings.push(
      `${key} inválido (${integer ? 'inteiro' : 'número'} de ${min} a ${max}); usando ${fallback}`,
    );
    return fallback;
  }
  return value;
}

function readRegion(
  env: EnvSource,
  key: string,
  fallback: string,
  warnings: string[],
): string {
  const raw = text(env, key).toLowerCase();
  if (!raw) return fallback;
  if (AWS_REGION_FORMAT.test(raw)) return raw;
  warnings.push(
    `${key} inválido (região AWS, ex.: sa-east-1); usando ${fallback}`,
  );
  return fallback;
}

function readFallbackRegion(
  env: EnvSource,
  key: string,
  fallback: string | null,
  primary: string,
  warnings: string[],
): string | null {
  const raw = text(env, key).toLowerCase();
  if (raw === NO_FALLBACK_REGION) return null;
  let region = fallback;
  if (raw && AWS_REGION_FORMAT.test(raw)) {
    region = raw;
  } else if (raw) {
    warnings.push(
      `${key} inválido (região AWS ou "none"); usando ${fallback ?? 'sem reserva'}`,
    );
  }
  if (region && region === primary) {
    warnings.push(`${key} é a própria região principal: sem região reserva`);
    return null;
  }
  return region;
}

function readList(env: EnvSource, key: string): string[] {
  return text(env, key)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function readSecret(env: EnvSource, key: string): string | null {
  return text(env, key) || null;
}

function readBucket(
  env: EnvSource,
  key: string,
  publicBucket: string,
  warnings: string[],
): string | null {
  const raw = text(env, key);
  if (!raw) return null;
  if (!BUCKET_NAME_FORMAT.test(raw)) {
    warnings.push(`${key} inválido (nome de bucket S3); ignorado`);
    return null;
  }
  if (raw === publicBucket) {
    warnings.push(
      `${key} é o próprio bucket público (S3_BUCKET_NAME); ignorado`,
    );
    return null;
  }
  return raw;
}

/**
 * Caminho da política do classificador: absoluto e fora da pasta da aplicação (o repositório da API é público; a
 * política ao lado do código vira manual de como burlar). Não lê o arquivo: quem lê é o text-classifier.service.
 */
function readPolicySource(
  env: EnvSource,
  appRoot: string,
  warnings: string[],
): string | null {
  const raw = text(env, 'SAFETY_POLICY_SOURCE');
  if (!raw) return null;
  if (!isAbsolute(raw)) {
    warnings.push(
      'SAFETY_POLICY_SOURCE precisa ser um caminho absoluto; classificador desligado',
    );
    return null;
  }
  const fromRoot = relative(resolve(appRoot), resolve(raw));
  const insideApp =
    fromRoot === '' ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== '..' &&
      !isAbsolute(fromRoot));
  if (insideApp) {
    warnings.push(
      'SAFETY_POLICY_SOURCE aponta para dentro da pasta da aplicação; a política fica fora do repositório. Classificador desligado',
    );
    return null;
  }
  return resolve(raw);
}

/**
 * Lê a configuração. Função pura sobre `env` (testável sem Nest). `appRoot` é a pasta da aplicação, para recusar a
 * política dentro dela (padrão: process.cwd()).
 */
export function loadImageSafetyConfig(
  env: EnvSource,
  appRoot: string = process.cwd(),
): LoadedImageSafetyConfig {
  const warnings: string[] = [];

  const imageMode = readMode(env, 'IMAGE_SAFETY_MODE', warnings);
  let textMode = readMode(env, 'TEXT_CLASSIFIER_MODE', warnings);
  const enforceStrong = readBoolean(
    env,
    'IMAGE_SAFETY_ENFORCE_STRONG',
    true,
    warnings,
  );

  const nudityMin = readNumber(env, 'SAFETY_NUDITY_MIN', 60, 20, 90, warnings);
  const childLabelMin = readNumber(
    env,
    'SAFETY_CHILD_LABEL_MIN',
    85,
    50,
    95,
    warnings,
  );
  const ageGrayMax = readNumber(
    env,
    'SAFETY_AGE_GRAY_MAX',
    23,
    19,
    30,
    warnings,
  );
  const outputReviewAgeMax = readNumber(
    env,
    'SAFETY_OUTPUT_REVIEW_AGE_MAX',
    Math.min(21, ageGrayMax),
    19,
    ageGrayMax,
    warnings,
  );
  const phashMaxDistance = readNumber(
    env,
    'SAFETY_PHASH_MAX_DISTANCE',
    8,
    0,
    16,
    warnings,
  );

  const maxFrames = readNumber(
    env,
    'SAFETY_VIDEO_MAX_FRAMES',
    12,
    3,
    30,
    warnings,
  );
  const everySeconds = readNumber(
    env,
    'SAFETY_VIDEO_EVERY_SECONDS',
    2,
    0.5,
    10,
    warnings,
    false,
  );
  const sceneThreshold = readNumber(
    env,
    'SAFETY_VIDEO_SCENE_THRESHOLD',
    0.3,
    0.1,
    0.9,
    warnings,
    false,
  );

  const rekognitionRegion = readRegion(
    env,
    'AWS_REGION_SAFETY',
    DEFAULT_REKOGNITION_REGION,
    warnings,
  );
  const rekognitionFallbackRegion = readFallbackRegion(
    env,
    'AWS_REGION_SAFETY_FALLBACK',
    DEFAULT_REKOGNITION_FALLBACK_REGION,
    rekognitionRegion,
    warnings,
  );
  const bedrockRegion = readRegion(
    env,
    'BEDROCK_REGION',
    rekognitionRegion,
    warnings,
  );
  const bedrockFallbackRegion = readFallbackRegion(
    env,
    'BEDROCK_REGION_FALLBACK',
    rekognitionFallbackRegion,
    bedrockRegion,
    warnings,
  );

  const accessKeyId = readSecret(env, 'AWS_SAFETY_ACCESS_KEY_ID');
  const secretAccessKey = readSecret(env, 'AWS_SAFETY_SECRET_ACCESS_KEY');
  let awsCredentials: AwsSafetyCredentials | null = null;
  if (accessKeyId && secretAccessKey) {
    awsCredentials = { accessKeyId, secretAccessKey };
  } else if (accessKeyId || secretAccessKey) {
    warnings.push(
      'AWS_SAFETY_ACCESS_KEY_ID e AWS_SAFETY_SECRET_ACCESS_KEY vão juntas; só uma veio. Usando a cadeia padrão do SDK',
    );
  }

  let bedrockSafeguardModelId = readSecret(env, 'BEDROCK_SAFEGUARD_MODEL_ID');
  if (
    bedrockSafeguardModelId &&
    !BEDROCK_MODEL_ID_FORMAT.test(bedrockSafeguardModelId)
  ) {
    warnings.push('BEDROCK_SAFEGUARD_MODEL_ID inválido; ignorado');
    bedrockSafeguardModelId = null;
  }
  const policySource = readPolicySource(env, appRoot, warnings);
  if (textMode !== 'off' && (!policySource || !bedrockSafeguardModelId)) {
    warnings.push(
      `TEXT_CLASSIFIER_MODE=${textMode} sem ${!policySource ? 'SAFETY_POLICY_SOURCE' : 'BEDROCK_SAFEGUARD_MODEL_ID'} válido: classificador de texto desligado (off)`,
    );
    textMode = 'off';
  }

  const publicBucket = text(env, 'S3_BUCKET_NAME') || 'ai-generations';
  // mesma regra do UploadsService: vazio ou igual ao público = sem bucket privado de entradas
  const privateInputBucket = text(env, 'S3_INPUT_PRIVATE_BUCKET');
  const hasPrivateInputBucket =
    privateInputBucket !== '' && privateInputBucket !== publicBucket;
  const quarantineBucket = readBucket(
    env,
    'S3_QUARANTINE_BUCKET',
    publicBucket,
    warnings,
  );
  const evidenceBucket = readBucket(
    env,
    'S3_EVIDENCE_BUCKET',
    publicBucket,
    warnings,
  );
  if (
    quarantineBucket &&
    evidenceBucket &&
    quarantineBucket === evidenceBucket
  ) {
    warnings.push(
      'S3_QUARANTINE_BUCKET e S3_EVIDENCE_BUCKET são o mesmo bucket: a evidência deve ficar separada (trava contra apagar)',
    );
  }
  // a prova de um caso forte precisa de lugar privado: sem bucket de evidência nem bucket privado de entradas, o modo
  // de imagem não liga (a foto barrada ficaria no público e o encerramento a apagaria)
  let imageModeOut: SafetyMode = imageMode;
  if (imageMode !== 'off' && !evidenceBucket && !hasPrivateInputBucket) {
    warnings.push(
      `IMAGE_SAFETY_MODE=${imageMode} sem S3_EVIDENCE_BUCKET nem S3_INPUT_PRIVATE_BUCKET: a evidência não teria onde ficar. Checagem de imagem desligada (off)`,
    );
    imageModeOut = 'off';
  } else if (imageMode !== 'off' && !evidenceBucket) {
    warnings.push(
      `IMAGE_SAFETY_MODE=${imageMode} sem S3_EVIDENCE_BUCKET: a evidência fica na pasta evidence/ do bucket privado de entradas (S3_INPUT_PRIVATE_BUCKET), nunca no público; esse bucket não pode ter regra de expiração`,
    );
  }
  if (imageModeOut !== 'off' && !quarantineBucket) {
    warnings.push(
      `IMAGE_SAFETY_MODE=${imageModeOut} sem S3_QUARANTINE_BUCKET: o resultado é checado antes de concluir, mas nasce no bucket público (chave imprevisível, sem link para a cliente) e fica lá até ser promovido, descartado ou ir para a evidência`,
    );
  }

  const trustedFilterModels = new Set<string>();
  for (const item of readList(env, 'SAFETY_TRUSTED_FILTER_MODELS')) {
    const slug = item.toLowerCase();
    if (!MODEL_SLUG_FORMAT.test(slug)) {
      warnings.push(
        `SAFETY_TRUSTED_FILTER_MODELS: "${slug.slice(0, 40)}" não é um slug de modelo; ignorado`,
      );
    } else if (isUncensoredModel(slug) || NEVER_TRUSTED_FILTER.test(slug)) {
      warnings.push(
        `SAFETY_TRUSTED_FILTER_MODELS: "${slug}" nunca é provedor de confiança (sem censura, Grok, Spicy, Kling ou Seedance); ignorado`,
      );
    } else {
      trustedFilterModels.add(slug);
    }
  }

  const reviewerIds = new Set<string>();
  const reviewerEntries = readList(env, 'SAFETY_REVIEWER_IDS');
  for (const id of reviewerEntries) {
    if (USER_ID_FORMAT.test(id)) reviewerIds.add(id);
  }
  if (reviewerIds.size !== reviewerEntries.length) {
    warnings.push(
      `SAFETY_REVIEWER_IDS: ${reviewerEntries.length - reviewerIds.size} id(s) inválido(s) ignorado(s)`,
    );
  }
  if (imageModeOut !== 'off' && reviewerIds.size === 0) {
    warnings.push(
      `IMAGE_SAFETY_MODE=${imageModeOut} sem SAFETY_REVIEWER_IDS: casos em revisão esperam até o prazo e então falham com estorno`,
    );
  }

  const childBlockAllSurfaces = readBoolean(
    env,
    'SAFETY_CHILD_BLOCK_ALL_SURFACES',
    true,
    warnings,
  );

  const config: ImageSafetyConfig = {
    imageMode: imageModeOut,
    textMode,
    enforceStrong,
    rulesVersion: RULES_VERSION,
    thresholds: Object.freeze({
      ageGrayMax,
      outputReviewAgeMax,
      nudityMin,
      childLabelMin,
      phashMaxDistance,
      adultAge: ADULT_AGE,
      childFaceAgeHighMax: CHILD_FACE_AGE_HIGH_MAX,
      teenFaceAgeLowMax: TEEN_FACE_AGE_LOW_MAX,
    }),
    video: Object.freeze({ maxFrames, everySeconds, sceneThreshold }),
    rekognitionRegion,
    rekognitionFallbackRegion,
    awsCredentials,
    bedrockRegion,
    bedrockFallbackRegion,
    bedrockSafeguardModelId,
    policySource,
    omniModerationApiKey: readSecret(env, 'OPENAI_MODERATION_API_KEY'),
    quarantineBucket,
    evidenceBucket,
    trustedFilterModels,
    reviewerIds,
    childBlockAllSurfaces,
    hiveApiKey: readSecret(env, 'HIVE_API_KEY'),
    arachnidApiKey: readSecret(env, 'ARACHNID_API_KEY'),
  };
  return { config: Object.freeze(config), warnings };
}

/** Resumo para o log do boot: sem chave, sem credencial, sem caminho da política. */
export function describeImageSafetyConfig(config: ImageSafetyConfig): string {
  const on = (value: unknown) => (value ? 'sim' : 'não');
  return [
    `imagem=${config.imageMode}`,
    `texto=${config.textMode}`,
    `fortes=${config.enforceStrong ? 'agem' : 'só registram'}`,
    `regras=${config.rulesVersion}`,
    `rekognition=${config.rekognitionRegion}${config.rekognitionFallbackRegion ? `>${config.rekognitionFallbackRegion}` : ''}`,
    `bedrock=${config.bedrockRegion}${config.bedrockFallbackRegion ? `>${config.bedrockFallbackRegion}` : ''}`,
    `credencial-própria=${on(config.awsCredentials)}`,
    `política=${on(config.policySource)}`,
    `omni=${on(config.omniModerationApiKey)}`,
    `quarentena=${on(config.quarantineBucket)}`,
    `evidência=${on(config.evidenceBucket)}`,
    `confiança=${config.trustedFilterModels.size}`,
    `revisores=${config.reviewerIds.size}`,
    `criança-todo-pedido=${on(config.childBlockAllSurfaces)}`,
    `juiz=${on(config.hiveApiKey)}`,
    `hash-conhecido=${on(config.arachnidApiKey)}`,
  ].join(' ');
}

/** Token de injeção da configuração (o módulo de segurança de imagem registra o provider abaixo). */
export const IMAGE_SAFETY_CONFIG = Symbol('IMAGE_SAFETY_CONFIG');

/** Provider Nest: lê pelo ConfigService, avisa cada valor recusado e loga o resumo uma vez no boot. */
export const imageSafetyConfigProvider: Provider = {
  provide: IMAGE_SAFETY_CONFIG,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): ImageSafetyConfig => {
    const logger = new Logger('ImageSafetyConfig');
    const { config, warnings } = loadImageSafetyConfig((key) => {
      const value = configService.get<unknown>(key);
      return typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
        ? String(value)
        : undefined;
    });
    for (const warning of warnings) logger.warn(warning);
    logger.log(describeImageSafetyConfig(config));
    return config;
  },
};
