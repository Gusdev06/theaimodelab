import type {
  ContentSafetyScanStage,
  ContentSafetyScanVerdict,
  ContentSafetyStrength,
  GenerationType,
} from '@prisma/client';

/**
 * Contrato da segurança de imagem e texto (camadas 2, 3 e 5): os tipos que as regras puras, os scanners, o
 * classificador de texto e a orquestração compartilham. Nada aqui chama rede ou banco.
 *
 * Princípios que valem para todo código que usa estes tipos:
 *  - guardar só o RESULTADO (faixa de idade, rótulos, scores), hashes e o veredito; nunca vetor facial nem a imagem
 *    fora do bucket de evidência;
 *  - a cliente recebe sempre a mesma mensagem genérica; o motivo exato (regra, score) só vai para o registro interno;
 *  - fornecedor fora do ar nunca libera mídia do usuário para provedor (UNAVAILABLE nunca conta como limpo).
 */

/* ------------------------------------------------------------------ modos */

/** off = não roda (comportamento da Onda 0); shadow = registra e só age no que é forte; enforce = age em tudo. */
export type SafetyMode = 'off' | 'shadow' | 'enforce';

/* ------------------------------------------------------------------ vocabulário do registro */

/** Etapa checada (espelha o enum ContentSafetyScanStage do Prisma). */
export type ScanStage =
  | 'INPUT'
  | 'INPUT_FRAME'
  | 'OUTPUT'
  | 'OUTPUT_FRAME'
  | 'TEXT';

/**
 * Veredito de uma checagem (espelha ContentSafetyScanVerdict):
 *  - CLEAN: nenhuma regra disparou;
 *  - GRAY: zona de dúvida (E4, E3b registrada): gera, mas sem desvio para sem censura nem reescrita de prompt;
 *  - HOLD: segura para revisão humana (IN_REVIEW) sem gerar (entrada) ou sem publicar (saída);
 *  - BLOCK: barra; com sinal forte ou médio a mídia vai para a evidência;
 *  - UNAVAILABLE: não deu para checar (fornecedor fora, arquivo ilegível, sem região): nunca conta como limpo.
 */
export type ScanVerdict = 'CLEAN' | 'GRAY' | 'HOLD' | 'BLOCK' | 'UNAVAILABLE';

/** Força do sinal (espelha ContentSafetyStrength): forte suspende, médio conta 1 ponto, leve não conta. */
export type Strength = 'STRONG' | 'MEDIUM' | 'LIGHT' | 'NONE';

/** Gravidade para juntar vereditos (várias fotos, vários quadros, texto + foto): vale o maior. */
export const VERDICT_SEVERITY: Readonly<Record<ScanVerdict, number>> = {
  CLEAN: 0,
  GRAY: 1,
  UNAVAILABLE: 2,
  HOLD: 3,
  BLOCK: 4,
};

/** Desempate entre vereditos de mesma gravidade: vale a força maior. */
export const STRENGTH_RANK: Readonly<Record<Strength, number>> = {
  NONE: 0,
  LIGHT: 1,
  MEDIUM: 2,
  STRONG: 3,
};

type SameUnion<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

/**
 * Falha de compilação aqui = o schema.prisma e este contrato divergiram (enum novo ou removido de um lado só).
 * Exportado só para o tsc conferir; não usar.
 */
export type ContractMatchesPrismaSchema = [
  SameUnion<ScanStage, ContentSafetyScanStage>,
  SameUnion<ScanVerdict, ContentSafetyScanVerdict>,
  SameUnion<Strength, ContentSafetyStrength>,
] extends [true, true, true]
  ? true
  : never;
export const CONTRACT_MATCHES_PRISMA_SCHEMA: ContractMatchesPrismaSchema = true;

/* ------------------------------------------------------------------ regras */

/** Regras da foto/vídeo de entrada (o significado de cada uma está em image-safety.rules.ts). */
export type InputRuleId =
  | 'E1'
  | 'E2'
  | 'E3a'
  | 'E3b'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7';

/** Regras do resultado (imagem e cada quadro de vídeo). */
export type OutputRuleId =
  | 'S1'
  | 'S2'
  | 'S2b'
  | 'S3'
  | 'S4'
  | 'S5'
  | 'S6'
  | 'S7';

/**
 * Regras do texto (camada 2 e saída do refinador; a trava determinística da camada 1 continua no interceptor):
 *  - T_NEGATIVE: marcador de maturidade no prompt negativo em pedido sexual → HOLD, médio;
 *  - T_REFINER: saída do agente refinador ou prompt montado no servidor acusado → BLOCK, médio;
 *  - T_CLASSIFIER: safeguard com violação de confiança alta, ou omni ≥ limiar alto → BLOCK, médio (forte com idade
 *    explícita ou "remover criança");
 *  - T_AMBIGUOUS: só um dos classificadores acusa, na faixa média → HOLD ("texto ambíguo"), estorno.
 */
export type TextRuleId =
  | 'T_NEGATIVE'
  | 'T_REFINER'
  | 'T_CLASSIFIER'
  | 'T_AMBIGUOUS';

/** Regra sintética para "não deu para checar" (veredito UNAVAILABLE). */
export type UnavailableRuleId = 'UNAVAILABLE';

export type RuleId =
  | InputRuleId
  | OutputRuleId
  | TextRuleId
  | UnavailableRuleId;

/* ------------------------------------------------------------------ mídia */

/** Onde a mídia está guardada (cada área tem seu bucket; ver image-safety.config.ts e uploads.service.ts). */
export type StorageArea =
  | 'public'
  | 'input-private'
  | 'quarantine'
  | 'evidence';

export type MediaKind = 'image' | 'video' | 'audio';

/**
 * Uma mídia a checar. Pelo menos um de `buffer`, `key` ou `url` vem preenchido. `key` + `area` é o que vai para o
 * registro (content_safety_scans.media_key); `url` pode ser assinada e NUNCA vai para log nem banco.
 */
export interface MediaRef {
  kind: MediaKind;
  mimeType: string | null;
  area: StorageArea;
  /** chave do objeto no bucket da `area` */
  key: string | null;
  /** URL para baixar quando não há bytes em memória (assinada ou pública) */
  url?: string | null;
  /** bytes já em memória (rotas fora da fila, que recebem base64) */
  buffer?: Buffer | null;
  /** papel na geração (GenerationImageRole, ou 'source'/'target'/'first_frame'…), só para o registro */
  role?: string | null;
  order?: number;
}

/**
 * Imagem pronta para o Rekognition (normalize.ts): JPEG de até 1920 px no lado maior e menos de 5 MB, lado mínimo
 * de 80 px. GIF vira até 3 imagens (1º quadro e 2 do meio); quadro de vídeo vira uma imagem com `frame`.
 */
export interface NormalizedImage {
  jpeg: Buffer;
  width: number;
  height: number;
  /** sha256 (hex) do arquivo ORIGINAL, antes da normalização: cache do veredito e lista de bloqueio exata */
  sha256: string;
  sourceMimeType: string | null;
  /** quadro de vídeo ou de GIF: posição na mídia original */
  frame?: FramePosition;
}

export interface FramePosition {
  index: number;
  timeMs: number | null;
}

/* ------------------------------------------------------------------ sinais da checagem */

/** Caixa relativa ao tamanho da imagem (0 a 1), como o Rekognition devolve. */
export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Um rosto lido pelo DetectFaces (atributo AGE_RANGE). O AgeRange não tem confiança: as regras usam o ponto médio
 * (recomendação da AWS) e, só nos cortes extremos, Low e High.
 */
export interface FaceSignal {
  ageLow: number;
  ageHigh: number;
  /** (ageLow + ageHigh) / 2 */
  ageMid: number;
  box: BoundingBox | null;
  /** confiança da DETECÇÃO do rosto (0 a 100), não da idade */
  confidence: number;
  /** achado na segunda passada recortada (bloco ampliado) */
  fromCrop: boolean;
}

/** Um rótulo do DetectLabels (Person, Child, Baby…). "Girl" e "Boy" nunca contam como criança. */
export interface LabelSignal {
  name: string;
  /** 0 a 100 */
  confidence: number;
  /** quantas instâncias com caixa (Person com 3 instâncias = 3 pessoas) */
  instanceCount: number;
}

/** Um rótulo do DetectModerationLabels (taxonomia v7). `parent` null no nível 1. */
export interface ModerationSignal {
  name: string;
  parent: string | null;
  /** 0 a 100 */
  confidence: number;
  /** 1, 2 ou 3 */
  taxonomyLevel: number;
}

/** De onde veio o acerto de hash (regras E1 e S6). */
export interface HashMatch {
  /** blocklist = lista própria (content_hash_blocks); known-csam = Arachnid/PhotoDNA/IWF */
  source: 'blocklist' | 'known-csam';
  matcher: string;
  /** distância de Hamming do pHash (lista própria); null quando o fornecedor não informa */
  distance: number | null;
  /** id da linha de content_hash_blocks (lista própria) */
  blockId: string | null;
  /** força registrada na lista própria; acerto de abuso conhecido é sempre STRONG */
  strength: Strength;
}

/** Resultado do juiz de imagem estilizada (anime, 3D, sem rosto real): regras E5 e S5. */
export type StylizedSignal =
  | { status: 'not_run' }
  | { status: 'unavailable'; judge: string }
  | { status: 'judged'; judge: string; childlike: boolean; confidence: number };

/**
 * Tudo o que se leu de UMA imagem (foto, quadro, resultado). É o que as regras puras recebem.
 * `faces` inclui os rostos da passada recortada (fromCrop). Nada aqui é vetor facial.
 */
export interface ScanSignals {
  faces: FaceSignal[];
  labels: LabelSignal[];
  moderation: ModerationSignal[];
  /** o DetectModerationLabels marcou o conteúdo como Animated/Illustrated */
  illustrated: boolean;
  /** a segunda passada recortada rodou (havia pessoa sem rosto ou menos rostos que pessoas) */
  cropPassRan: boolean;
  /** hash perceptual de 64 bits em 16 caracteres hexadecimais */
  phash: string | null;
  sha256: string | null;
  hashMatch: HashMatch | null;
  stylized: StylizedSignal;
  frame?: FramePosition;
  /** quem leu (rekognition, cache…), região e tempo: vão para o registro */
  scanner: string;
  region: string | null;
  latencyMs: number;
}

/* ------------------------------------------------------------------ contexto do pedido */

/**
 * Ferramenta que originou o pedido, deduzida NO SERVIDOR (rota, tipo da geração, modelo, modo do job), nunca de um
 * campo que o site manda.
 */
export type SafetyTool =
  | 'generate'
  | 'undress'
  | 'face_swap'
  | 'face_swap_unlocked'
  | 'virtual_try_on'
  | 'motion_control'
  | 'upscale'
  | 'avatar'
  | 'prompt_clone'
  | 'influencer_builder'
  | 'brand_analyzer'
  | 'agent_chat'
  | 'video_editor';

/**
 * Lado do produto, deduzido no servidor por surfaceOf, nunca por campo que o site manda: `adult` quando o modelo
 * é sem censura, a ferramenta é sexual por natureza ou o pedido é sexual; `common` no resto.
 */
export type SafetySurface = 'adult' | 'common';

/** Pistas de pedido sexual que não estão no modelo, na ferramenta nem no texto do prompt. */
export interface SexualHints {
  /** o classificador de texto marcou intenção sexual; null = não rodou */
  classifier: boolean | null;
  /** nudez ≥ SAFETY_NUDITY_MIN em alguma mídia de entrada; null = entrada ainda não checada */
  inputNudity: boolean | null;
}

/**
 * Contexto de um pedido para as regras. Montado pela orquestração a partir da geração e do job, nunca do corpo cru.
 * `surface` é preenchido com surfaceOf(contexto sem surface).
 */
export interface RequestContext {
  userId: string | null;
  /** null nas rotas fora da fila, checadas antes de existir geração */
  generationId: string | null;
  /** slug do modelo que vai receber a mídia (modelUsed), já resolvido no servidor */
  model: string | null;
  tool: SafetyTool;
  type: GenerationType | null;
  hasUserMedia: boolean;
  sexual: SexualHints;
  surface: SafetySurface;
  /** prompt FINAL montado no servidor (inclui os prompts fixos de despir e troca de rosto Unlocked) */
  prompt: string | null;
  negativePrompt: string | null;
}

/* ------------------------------------------------------------------ vereditos */

/** Restrições da zona de dúvida (E4) e de toda entrada não limpa. */
export interface VerdictRestrictions {
  /** sem atestado de imagem, não gera */
  requireConsent: boolean;
  /** nenhum desvio para modelo sem censura, por segurança ou falha técnica */
  noUncensoredFallback: boolean;
  /** nenhuma reescrita de prompt pelo agente refinador */
  noPromptRewrite: boolean;
  /** a saída passa pela régua inteira, sem atalho (nem herança da S7) */
  fullOutputCheck: boolean;
}

/** O que fazer com o arquivo checado. */
export type EvidenceAction =
  /**
   * preservar (sinal forte ou médio): BLOCK vai já para o bucket de evidência; HOLD fica onde está (privado) até o
   * revisor decidir, e "confirmar" leva para a evidência
   */
  | 'keep'
  /** apagar e guardar só o veredito (caso leve: criança em pedido não sexual; LGPD art. 14) */
  | 'delete'
  /** nada a fazer (limpo, dúvida, indisponível) */
  | 'none';

interface VerdictBase<R extends RuleId> {
  verdict: ScanVerdict;
  /** regra que decidiu; null quando CLEAN */
  ruleId: R | UnavailableRuleId | null;
  strength: Strength;
  evidence: EvidenceAction;
  /** entra na lista de bloqueio própria (só forte ou médio; o caso leve nunca entra) */
  addToBlocklist: boolean;
  /** motivo interno, curto e sem o texto do pedido (vai para o registro e a aba Suspeitas, nunca para a cliente) */
  reason: string;
}

/** Veredito de UMA mídia de entrada (ou do conjunto, depois de juntar). */
export interface InputVerdict extends VerdictBase<InputRuleId> {
  restrictions: VerdictRestrictions;
  /** rosto mais jovem pelo ponto médio (o rosto que decide) */
  youngestFace: FaceSignal | null;
  /** E7: regra que disparou no pior quadro */
  cause?: InputRuleId;
}

/**
 * Resumo da entrada que a checagem do resultado usa (herança da S7: nudez sem rosto no resultado passa quando a
 * entrada teve rosto adulto acima da zona de dúvida e passou limpa).
 */
export interface InputSummary {
  /** veredito juntado das mídias de entrada e do texto; null = pedido sem mídia */
  verdict: ScanVerdict | null;
  /** alguma mídia de entrada teve rosto */
  hadFace: boolean;
  /** menor ponto médio entre os rostos da entrada; null sem rosto */
  youngestAgeMid: number | null;
}

/** Destino do resultado depois da checagem. */
export type OutputDisposition =
  /** copiar para o público (cache curto) e concluir */
  | 'promote'
  /** ficar na quarentena, geração IN_REVIEW */
  | 'hold'
  /** ir para a evidência, geração falha com estorno */
  | 'evidence'
  /** ninguém checou: segue a regra de falha (fila, quarentena até 2 h, lista curta de provedores com filtro) */
  | 'retry';

/** Veredito de UMA imagem de resultado ou de UM quadro. */
export interface OutputVerdict extends VerdictBase<OutputRuleId> {
  disposition: OutputDisposition;
  youngestFace: FaceSignal | null;
}

/** Veredito de um vídeo (entrada ou saída): vale o pior quadro. */
export interface VideoVerdict<V extends InputVerdict | OutputVerdict> {
  stage: 'input' | 'output';
  /** veredito do pior quadro (na entrada, ruleId E7 com `cause` = regra do quadro) */
  worst: V;
  worstFrame: FramePosition | null;
  frames: Array<{ frame: FramePosition; verdict: V }>;
  /** 2 ou mais quadros em S3 num pedido sem censura: revisão com prioridade */
  priorityReview: boolean;
}

/* ------------------------------------------------------------------ texto */

/** Texto que vai ao classificador: cada campo separado (o negativo é "o que a cliente pediu para evitar"). */
export interface TextClassifierInput {
  prompt: string | null;
  negative: string | null;
  /** prompt montado no servidor (saída do refinador, do turbinar, prompts fixos de ferramenta) */
  serverPrompt: string | null;
}

/** Faixa de confiança normalizada de um classificador. */
export type ConfidenceBand = 'none' | 'medium' | 'high';

/** Resposta de UM classificador (safeguard ou omni-moderation), sem o raciocínio do modelo (pode repetir o pedido). */
export interface TextClassifierResult {
  classifier: string;
  violation: boolean;
  band: ConfidenceBand;
  /** id da regra da política que disparou (safeguard); null no omni */
  policyRuleId: string | null;
  /** score bruto (omni: sexual/minors de 0 a 1); null no safeguard */
  score: number | null;
  /** o texto pede conteúdo sexual; null = o classificador não informa */
  sexual: boolean | null;
  /** idade explícita abaixo de 18 ou "remover a criança": o sinal sobe para forte */
  explicitMinor: boolean;
  policyVersion: string | null;
  region: string | null;
  latencyMs: number;
}

/** Veredito do texto (camada 2): junta os classificadores pelas regras T_*. */
export interface TextVerdict {
  verdict: ScanVerdict;
  ruleId: TextRuleId | UnavailableRuleId | null;
  strength: Strength;
  /** intenção sexual lida pelos classificadores (alimenta SexualHints.classifier) */
  sexualIntent: boolean | null;
  /** sha256 do texto normalizado (minor-guard canonical): chave do cache */
  sha256: string;
  results: TextClassifierResult[];
  reason: string;
}

/* ------------------------------------------------------------------ portas (adaptadores trocáveis nos testes) */

/** Opções de cada chamada externa. */
export interface SafetyCallOptions {
  /** prazo total da chamada (inclui a nova tentativa na região reserva) */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Parte remota da leitura de uma imagem (Rekognition ou simulado). */
export interface ScannerResult {
  faces: FaceSignal[];
  labels: LabelSignal[];
  moderation: ModerationSignal[];
  illustrated: boolean;
  cropPassRan: boolean;
  scanner: string;
  region: string;
  latencyMs: number;
}

/**
 * Leitor de imagem (rekognition.scanner.ts). Roda DetectFaces (AGE_RANGE), DetectLabels e DetectModerationLabels em
 * paralelo e, quando há pessoa sem rosto, a passada recortada. Timeout, 5xx e limite → região reserva → lança
 * SafetyProviderUnavailableError. Nunca devolve resultado parcial como se fosse completo.
 */
export interface ScannerPort {
  readonly name: string;
  detect(
    image: NormalizedImage,
    options?: SafetyCallOptions,
  ): Promise<ScannerResult>;
}

/** Hash de abuso conhecido (Arachnid, PhotoDNA, IWF), atrás de flag. Desligado: enabled false e match devolve null. */
export interface KnownHashPort {
  readonly name: string;
  readonly enabled: boolean;
  match(
    image: NormalizedImage,
    options?: SafetyCallOptions,
  ): Promise<HashMatch | null>;
}

/** Linha da lista de bloqueio própria para gravar. */
export interface BlocklistEntryInput {
  phash: string;
  sha256: string | null;
  strength: Extract<Strength, 'STRONG' | 'MEDIUM'>;
  origin: 'input' | 'output' | 'report' | 'manual';
  eventId: string | null;
}

/** Lista de bloqueio própria (blocklist.service.ts, tabela content_hash_blocks). */
export interface BlocklistPort {
  /** acerto exato por sha256 ou perto por pHash (distância ≤ maxDistance); ignora as linhas revogadas */
  match(
    phash: string | null,
    sha256: string | null,
    maxDistance: number,
  ): Promise<HashMatch | null>;
  add(entry: BlocklistEntryInput): Promise<string>;
  /** bloqueios de foto (HOLD/BLOCK) da conta nas últimas `hours` horas com hash a distância ≤ maxDistance */
  countRecent(
    userId: string,
    phash: string,
    hours: number,
    maxDistance: number,
  ): Promise<number>;
}

/** Juiz de imagem estilizada (Hive VLM), atrás de flag. Desligado: enabled false. */
export interface StylizedJudgePort {
  readonly name: string;
  readonly enabled: boolean;
  judge(
    image: NormalizedImage,
    options?: SafetyCallOptions,
  ): Promise<Extract<StylizedSignal, { status: 'judged' }>>;
}

/** Um classificador de texto (safeguard na Bedrock, omni-moderation). */
export interface TextClassifierPort {
  readonly name: string;
  classify(
    input: TextClassifierInput,
    options?: SafetyCallOptions,
  ): Promise<TextClassifierResult>;
}

/** Por que o fornecedor não respondeu (vai para o registro e para o alerta "porteiro cego"). */
export type ProviderFailureKind =
  | 'timeout'
  | 'throttled'
  | 'server_error'
  | 'auth'
  | 'not_configured'
  | 'invalid_media'
  | 'invalid_response';

/**
 * Fornecedor fora (timeout, 5xx, limite, credencial, região) depois da nova tentativa na região reserva, ou mídia que
 * não deu para ler. Quem chama transforma em veredito UNAVAILABLE; nunca em CLEAN.
 */
export class SafetyProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly failure: ProviderFailureKind,
    readonly region: string | null = null,
  ) {
    super(`${provider} indisponível (${failure})`);
    this.name = 'SafetyProviderUnavailableError';
  }
}

/* ------------------------------------------------------------------ registro */

/** O que vai para content_safety_scans.scores: sinais resumidos, sem vetor facial e sem texto do pedido. */
export interface ScanScores {
  faces?: Array<
    Pick<
      FaceSignal,
      'ageLow' | 'ageHigh' | 'ageMid' | 'confidence' | 'fromCrop'
    >
  >;
  /** só os rótulos que as regras usam (pessoa, criança) */
  labels?: LabelSignal[];
  /** só os rótulos de moderação acima de 50 */
  moderation?: ModerationSignal[];
  nudity?: number;
  suggestive?: number;
  illustrated?: boolean;
  cropPassRan?: boolean;
  stylized?: StylizedSignal;
  hashMatch?: Pick<HashMatch, 'source' | 'matcher' | 'distance'>;
  frame?: FramePosition;
  surface?: SafetySurface;
  sexual?: boolean;
  /** etapa TEXT: resultados sem o raciocínio do modelo */
  text?: Array<
    Pick<
      TextClassifierResult,
      'classifier' | 'violation' | 'band' | 'policyRuleId' | 'score' | 'sexual'
    >
  >;
  /** motivo interno da regra */
  reason?: string;
}

/** Linha de content_safety_scans pronta para gravar. */
export interface ScanRecordInput {
  generationId: string | null;
  userId: string | null;
  stage: ScanStage;
  mediaKey: string | null;
  sha256: string | null;
  phash: string | null;
  scores: ScanScores;
  verdict: ScanVerdict;
  ruleId: RuleId | null;
  strength: Strength;
  rulesVersion: string;
  mode: Exclude<SafetyMode, 'off'>;
  enforced: boolean;
  scanner: string;
  region: string | null;
  latencyMs: number | null;
  evidenceKey: string | null;
}
