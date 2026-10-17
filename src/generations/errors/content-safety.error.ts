import { ErrorCodes } from '../../common/constants/error-codes';
import type { PreflightStatus } from '../../content-safety/preflight-status';

/**
 * Thrown when Veo / Vertex AI blocks a generation due to content safety filters.
 *
 * Support codes mapping:
 * 58061214 / 17301594 — Child
 * 29310472 / 15236754 — Celebrity
 * 64151117 / 42237218 — Video safety violation
 * 62263041            — Dangerous content
 * 57734940 / 22137204 — Hate speech
 * 74803281 / 29578790 / 42876398 — Other safety
 * 89371032 / 49114662 / 63429089 / 72817394 / 60599140 — Prohibited content
 * 35561574 / 35561575 — Third-party content
 * 90789179 / 43188360 — Sexual content
 * 78610348            — Toxic
 * 61493863 / 56562880 — Violence
 * 32635315            — Vulgar
 */
export class ContentSafetyError extends Error {
  readonly supportCode?: string;

  constructor(message: string, supportCode?: string) {
    super(message);
    this.name = 'ContentSafetyError';
    this.supportCode = supportCode;
  }

  /** Known Vertex AI safety support codes */
  static readonly SAFETY_CODES = new Set([
    '58061214', '17301594', // Child
    '29310472', '15236754', // Celebrity
    '64151117', '42237218', // Video safety violation
    '62263041',             // Dangerous content
    '57734940', '22137204', // Hate speech
    '74803281', '29578790', '42876398', // Other
    '89371032', '49114662', '63429089', '72817394', '60599140', // Prohibited
    '35561574', '35561575', // Third-party
    '90789179', '43188360', // Sexual
    '78610348',             // Toxic
    '61493863', '56562880', // Violence
    '32635315',             // Vulgar
  ]);

  /** Patterns in error messages that indicate a safety filter was triggered */
  static readonly SAFETY_PATTERNS = [
    /violat.*polic/i,
    /couldn.*t be submitted/i,
    /diretrizes de uso/i,
    /safety.*filter/i,
    /safety.*checker/i,
    /content.*policy/i,
    /content[\s_-]*moderation/i,
    /responsible\s*ai/i,
    /blocked.*safety/i,
    /support.*code/i,
    /não pôde gerar/i,
    /flagged as sensitive/i,
    /flagged for/i,
    /sensitive.*content/i,
    /inappropriate.*content/i,
    /nsfw/i,
    /\bE005\b/,
    // GPT Image 2/2.5 (KIE) e Gemini Omni — antes só o classificador de falha
    // reconhecia, então o bloqueio não acionava o fallback pro Unlocked.
    /guardrails/i,
    /appear to be unsafe/i,
    /may violate/i,
    /prohibited use/i,
    /viola.*diretrizes/i,
    /safety system/i,
    /public_error_/i,
  ];

  /**
   * Check if an error message indicates a content safety violation.
   * Returns a ContentSafetyError if it matches, or null otherwise.
   */
  static fromErrorMessage(message: string): ContentSafetyError | null {
    // Check for known support codes
    for (const code of ContentSafetyError.SAFETY_CODES) {
      if (message.includes(code)) {
        return new ContentSafetyError(message, code);
      }
    }

    // Check for known error patterns
    for (const pattern of ContentSafetyError.SAFETY_PATTERNS) {
      if (pattern.test(message)) {
        return new ContentSafetyError(message);
      }
    }

    return null;
  }
}

/* ─── Bloqueio do provedor por MENOR de idade ───────────────────────────────
 *
 * Quando um provedor com censura (Vertex/Veo, Gemini, GPT Image via kie…) recusa por criança, o pedido NUNCA
 * pode seguir para o Unlocked (sem censura) nem para a nova tentativa com o prompt reescrito: os dois levam o
 * mesmo prompt e as mesmas fotos adiante. Nem volta para a fila: a nova tentativa do BullMQ reenviaria tudo ao
 * provedor 30 s depois. Funções puras: sem rede, sem banco.
 */

/** Códigos de suporte do Vertex AI / Veo para CRIANÇA (tabela no topo do arquivo). */
export const MINOR_SUPPORT_CODES: ReadonlySet<string> = new Set([
  '58061214',
  '17301594',
]);

/** Texto que o usuário vê quando a geração é encerrada por menor (o mesmo da trava da API, antes do provedor). */
export const MINOR_BLOCK_USER_MESSAGE = ErrorCodes.CONTENT_POLICY_MINOR.message;

/** Código de criança no meio do texto, sem pegar pedaço de número maior. */
const MINOR_CODE_IN_TEXT = /(?<!\d)(58061214|17301594)(?!\d)/;

/**
 * Como os provedores dizem "menor" na mensagem de ERRO. Só para texto de erro de provedor, nunca para prompt
 * (prompt passa pela guarda content-safety/minor-guard.ts antes de chegar aqui).
 * Fronteira de palavra = letra/dígito, então `_`, `/` e `-` separam: pega `sexual_minors`, `sexual/minors` e
 * `PUBLIC_ERROR_MINOR`. "minor" no singular também é adjetivo ("minor scratches", "minor edits", "a minor
 * error"), então só conta onde é substantivo.
 */
const MINOR_TEXT_PATTERNS: readonly RegExp[] = [
  // termos que sozinhos já dizem menor (en / pt / es); "niño/niña" só com ñ (sem ele colide com o nome Nina)
  /(?<![\p{L}\p{N}])(?:child(?:ren|like)?|kids?|infants?|toddlers?|newborns?|(?:pre[\s-]?)?teen(?:s|age|aged|ager|agers)?|adolescent(?:e|es|s)?|under[\s-]?aged?|minors|csam|csae|csea|p(?:a)?edophil\p{L}*|ped[oó]fil\p{L}*|crian[çc]as?|infantil|infantis|niñ[oa]s?|menor(?:es)?\s+de\s+(?:idade|edad))(?![\p{L}\p{N}])/iu,
  // "minor" substantivo: possessivo ("a minor's body") ou antes de pessoa ("minor girl", "minor users")
  /(?<![\p{L}\p{N}])minor(?:['’]s|\s+(?:girls?|boys?|child(?:ren)?|kids?|persons?|people|individuals?|users?|females?|males?|daughters?|sons?))(?![\p{L}\p{N}])/iu,
  // "a minor", "of a minor", "involving a minor"… seguido de fim, pontuação ou palavra de ligação
  /(?<![\p{L}\p{N}])(?:a|any|the|of|involv(?:e|es|ed|ing)|depict(?:s|ed|ing)?|sexuali[sz](?:e|es|ed|ing)|resembl(?:e|es|ing))\s+minor(?=\s*$|\s*[^\p{L}\p{N}\s]|\s+(?:in|on|at|or|and|who|that|which|is|was|are|were|be|being|under|as|with|without|wearing|posing|appearing|appears|depicted|shown|present|detected|engaged|involved|nude|naked|sexual|sexually|explicit)(?![\p{L}\p{N}]))/iu,
  // categoria de moderação: sexual/minors, sexual_minors, sexualized minor
  /(?<![\p{L}\p{N}])sexual\p{L}*[\s/_-]+minors?(?![\p{L}\p{N}])/iu,
  // código de erro em identificador: PUBLIC_ERROR_MINOR, MINOR_UPLOAD, is_minor
  /(?:(?<=_)minors?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}_])minors?(?=_))/iu,
  // erro público da kie com espaços ("public error minor detected"), além do identificador com sublinhado
  /(?<![\p{L}\p{N}])public[\s_-]+error[\s_-]+minors?(?![\p{L}\p{N}])/iu,
  // nome de política: "Minor Safety", "minor protection"
  /(?<![\p{L}\p{N}])minor[\s_-]*(?:safety|protection)(?![\p{L}\p{N}])/iu,
  // pt/es: "sexualizem menores", "com menores", "abuso sexual de menores" ("de menores" sozinho é "de tamanho menor")
  /(?<![\p{L}\p{N}])(?:a|con|com|envolvendo|involucrando|sexualiz\p{L}*|sexual(?:es)?\s+(?:de|con|com|envolvendo))\s+menores(?![\p{L}\p{N}])/iu,
];

/** Texto do erro do provedor: mensagem + detalhe técnico (ProviderFailureError), sem depender de importar a classe. */
function providerTexts(source: unknown): string[] {
  if (typeof source === 'string') return [source];
  if (typeof source === 'number') return [String(source)];
  if (!source || typeof source !== 'object') return [];
  const { message, providerDetail } = source as {
    message?: unknown;
    providerDetail?: unknown;
  };
  return [message, providerDetail].filter(
    (text): text is string => typeof text === 'string' && text.length > 0,
  );
}

/**
 * Código de suporte de CRIANÇA do erro (campo `supportCode` ou dentro do texto), ou null. Vai como `match` na
 * trilha de auditoria.
 */
export function minorSupportCodeOf(source: unknown): string | null {
  if (source && typeof source === 'object') {
    const { supportCode } = source as { supportCode?: unknown };
    if (typeof supportCode === 'string' && MINOR_SUPPORT_CODES.has(supportCode)) {
      return supportCode;
    }
  }
  for (const text of providerTexts(source)) {
    const found = MINOR_CODE_IN_TEXT.exec(text);
    if (found) return found[1];
  }
  return null;
}

/**
 * O provedor recusou por MENOR de idade? Aceita o erro (ContentSafetyError, ProviderFailureError, Error), a
 * mensagem crua ou o código de suporte. True para os códigos de criança do Vertex e para mensagem de provedor que
 * fala de child/children/minor/underage/csam/teen (en/pt/es).
 */
export function isMinorSafetyBlock(source: unknown): boolean {
  if (minorSupportCodeOf(source)) return true;
  return providerTexts(source).some((text) =>
    MINOR_TEXT_PATTERNS.some((pattern) => pattern.test(text)),
  );
}

export type SafetyFallbackDecision =
  | 'fail_minor'
  | 'fail_blocked'
  | 'allow_fallback';

/**
 * Para onde o pedido iria depois do bloqueio:
 *  - `uncensored`: o Unlocked sem censura (fallbackToSeedream), que recebe o prompt E as fotos do usuário;
 *  - `same_provider`: nova tentativa com o prompt reescrito por um LLM ("passar no filtro") no MESMO provedor, com
 *    as mesmas fotos.
 */
export type SafetyFallbackTarget = 'uncensored' | 'same_provider';

export interface SafetyFallbackInput {
  /** desvio que vem depois do bloqueio */
  target: SafetyFallbackTarget;
  /** o provedor recusou por menor de idade (isMinorSafetyBlock) */
  isMinor: boolean;
  /**
   * o pedido leva mídia do usuário: foto, frame, referência, vídeo ou avatar (pode ser pessoa real), ou trouxe o
   * atestado de imagem (que só existe em pedido com foto)
   */
  hasUserImages: boolean;
  /** o pedido que criou a geração trouxe atestado de consentimento gravado */
  hasConsent: boolean;
  /**
   * veredito do porteiro de imagem sobre a mídia de entrada (só conta quando há mídia do usuário e o alvo é
   * `uncensored`; para esse alvo o leitor reavalia a entrada como pedido sexual: zona de dúvida e estilizado sem juiz
   * não são 'clean')
   */
  preflight: PreflightStatus;
}

/**
 * Por que o desvio parou (null = segue):
 *  - `minor`: o provedor recusou por menor de idade;
 *  - `unverified_media`: há mídia do usuário e o porteiro de imagem não a deu como limpa;
 *  - `needs_consent`: foto limpa, mas sem atestado, e o desvio seria o modelo sem censura.
 */
export type SafetyFallbackBlockReason =
  | 'minor'
  | 'unverified_media'
  | 'needs_consent';

export interface SafetyFallbackVerdict {
  decision: SafetyFallbackDecision;
  reason: SafetyFallbackBlockReason | null;
}

/**
 * O que fazer depois que um provedor bloqueou o conteúdo, ANTES de qualquer desvio:
 *  - menor → `fail_minor` (qualquer alvo): encerra, sem desvio e sem reescrever o prompt;
 *  - `same_provider` com mídia do usuário → `fail_blocked`, com QUALQUER veredito do porteiro: reescrever o prompt
 *    para passar no filtro e reenviar a mesma foto é contorno de filtro (seção 2, camada 4, regra 3: "com foto, não
 *    existe");
 *  - mídia do usuário sem `preflight === 'clean'` → `fail_blocked`: a recusa pode ser justamente a foto que a
 *    plataforma quer barrar, então o modelo sem censura não recebe a foto;
 *  - `same_provider` só com texto → `allow_fallback` (o texto reescrito ainda passa pelas camadas 1 e 2);
 *  - `uncensored` com foto limpa sem atestado → `fail_blocked`: encerra pedindo o atestado;
 *  - `uncensored` só com texto, ou com foto limpa e atestada → `allow_fallback`.
 */
export function safetyFallbackVerdict({
  target,
  isMinor,
  hasUserImages,
  hasConsent,
  preflight,
}: SafetyFallbackInput): SafetyFallbackVerdict {
  if (isMinor) return { decision: 'fail_minor', reason: 'minor' };
  if (target === 'same_provider') {
    return hasUserImages
      ? { decision: 'fail_blocked', reason: 'unverified_media' }
      : { decision: 'allow_fallback', reason: null };
  }
  if (hasUserImages && preflight !== 'clean') {
    return { decision: 'fail_blocked', reason: 'unverified_media' };
  }
  if (hasUserImages && !hasConsent) {
    return { decision: 'fail_blocked', reason: 'needs_consent' };
  }
  return { decision: 'allow_fallback', reason: null };
}

/** Só a decisão de safetyFallbackVerdict. */
export function decideSafetyFallback(
  input: SafetyFallbackInput,
): SafetyFallbackDecision {
  return safetyFallbackVerdict(input).decision;
}

/**
 * Geração encerrada porque o provedor recusou por MENOR de idade. `message` é o texto para o usuário; o texto
 * cru do provedor (com o código de suporte, quando houver) fica em `providerDetail`, que é o que a classificação
 * lê via rawFailureText — assim a falha sai como CONTENT_POLICY_MINOR mesmo sem o `failureCode`.
 *
 * É bloqueio TERMINAL: o processor encerra a geração e conclui o job sem a nova tentativa do BullMQ, que mandaria
 * o mesmo prompt e as mesmas fotos ao provedor de novo.
 */
export class MinorSafetyBlockError extends ContentSafetyError {
  /** código da falha decidido aqui (GenerationFailureCode.CONTENT_POLICY_MINOR), não pelo texto do provedor */
  readonly failureCode = 'CONTENT_POLICY_MINOR' as const;
  readonly providerDetail: string;
  /** modelo que recusou: vai para a trilha de auditoria como `provider:<modelo>`; vazio = o da geração */
  readonly model: string;

  constructor(original: unknown, model: string) {
    const supportCode = minorSupportCodeOf(original) ?? undefined;
    super(MINOR_BLOCK_USER_MESSAGE, supportCode);
    this.name = 'MinorSafetyBlockError';
    this.model = model;
    const raw = providerTexts(original).join(' ') || 'provider minor block';
    this.providerDetail =
      supportCode && !raw.includes(supportCode)
        ? `${raw} (support code ${supportCode})`
        : raw;
  }
}

/**
 * O filtro bloqueou um pedido com foto/frame/vídeo do usuário que NÃO trouxe o atestado de imagem, e o desvio seria
 * o Unlocked sem censura (decideSafetyFallback → `fail_blocked`). A geração termina aqui, sem levar a foto ao modelo
 * sem censura e sem a nova tentativa do BullMQ (que reenviaria a mesma foto ao provedor que já recusou). Sai como
 * CONTENT_BLOCKED_NEEDS_CONSENT: o site pede para marcar a autorização de imagem e gerar de novo.
 */
export class ConsentRequiredSafetyError extends ContentSafetyError {
  /** código da falha decidido aqui (GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT), não pelo texto */
  readonly failureCode = 'CONTENT_BLOCKED_NEEDS_CONSENT' as const;
  /** texto cru do bloqueio do provedor, para o log e o admin */
  readonly providerDetail: string;
  /** modelo que bloqueou */
  readonly model: string;

  constructor(original: unknown, model: string) {
    const supportCode =
      original instanceof ContentSafetyError ? original.supportCode : undefined;
    super(
      'Bloqueio do filtro em pedido com foto do usuário sem atestado de imagem: sem desvio para o modelo sem censura',
      supportCode,
    );
    this.name = 'ConsentRequiredSafetyError';
    this.model = model;
    this.providerDetail =
      providerTexts(original).join(' ') || 'provider content block';
  }
}

/**
 * A trava de texto da API acusou menor de idade no prompt reescrito pelo agente refinador E no pedido original da
 * cliente (que escapou da trava de entrada). Encerra como a recusa por menor (CONTENT_POLICY_MINOR, sem nova
 * tentativa) e sem mandar a reescrita ao provedor. Na trilha de auditoria sai como `refiner:<modelo>` com o termo do
 * pedido original (nunca o texto). Quando só a reescrita é acusada, o bloqueio é UnverifiedContentBlockError
 * `refiner_flagged` (safety-fallback-guard.refinedPromptBlockOf).
 */
export class RefinedPromptMinorBlockError extends MinorSafetyBlockError {
  /** termo ou idade que a trava acusou (vai como `match` na trilha) */
  readonly guardMatch: string;

  constructor(guardMatch: string | undefined, model = '') {
    super('safety refiner output flagged by the minor guard', model);
    this.name = 'RefinedPromptMinorBlockError';
    this.guardMatch = guardMatch?.trim() || 'refiner';
  }
}

/** De onde veio um bloqueio terminal sem sinal de menor (UnverifiedContentBlockError). */
export type UnverifiedContentSource =
  | 'unverified_media'
  | 'refiner_unchecked'
  | 'refiner_flagged';

const UNVERIFIED_CONTENT_MESSAGES: Record<UnverifiedContentSource, string> = {
  unverified_media:
    'Bloqueio do filtro em pedido com mídia do usuário sem checagem limpa da mídia: geração encerrada sem desvio',
  refiner_unchecked:
    'Prompt reescrito pelo agente refinador não pôde ser conferido pela trava de texto: geração encerrada sem nova tentativa',
  refiner_flagged:
    'Prompt reescrito pelo agente refinador acusado pela trava de texto (o pedido original passou): geração encerrada sem nova tentativa',
};

/**
 * Bloqueio terminal sem sinal de menor, com o texto genérico de bloqueio (CONTENT_SAFETY_BLOCKED):
 *  - `unverified_media`: o provedor recusou um pedido com mídia do usuário (foto, frame, vídeo, áudio) que o porteiro
 *    de imagem não deu como limpa; nem o modelo sem censura nem o prompt reescrito recebem a mídia, e o atestado não
 *    resolve (pedir o atestado aqui só faria a cliente marcar e cair no mesmo bloqueio);
 *  - `refiner_unchecked`: a trava de texto não conseguiu conferir o prompt reescrito (alfabeto que ela não lê, texto
 *    grande demais), então ele não vai ao provedor;
 *  - `refiner_flagged`: a trava acusou só a reescrita, não o pedido original. O termo foi escrito pelo refinador, então
 *    não vira MINOR_BLOCKED nem conta para a guarda legal; até o evento REFINER_BLOCKED existir, fica só no log.
 */
export class UnverifiedContentBlockError extends ContentSafetyError {
  /** código da falha decidido aqui (GenerationFailureCode.CONTENT_SAFETY_BLOCKED), não pelo texto */
  readonly failureCode = 'CONTENT_SAFETY_BLOCKED' as const;
  /** texto cru do bloqueio do provedor, para o log e o admin */
  readonly providerDetail: string;
  /** modelo que bloqueou */
  readonly model: string;
  readonly source: UnverifiedContentSource;
  /** `refiner_flagged`: termo ou idade que a trava acusou na reescrita (só para o log, nunca o texto) */
  readonly guardMatch?: string;

  constructor(
    original: unknown,
    model: string,
    source: UnverifiedContentSource,
    guardMatch?: string,
  ) {
    const supportCode =
      original instanceof ContentSafetyError ? original.supportCode : undefined;
    super(UNVERIFIED_CONTENT_MESSAGES[source], supportCode);
    this.name = 'UnverifiedContentBlockError';
    this.model = model;
    this.source = source;
    this.guardMatch = guardMatch?.trim() || undefined;
    this.providerDetail =
      providerTexts(original).join(' ') || 'provider content block';
  }
}

/* ─── Checagem de segurança da própria plataforma (porteiro de imagem e leitor de texto) ─────────────────────────
 *
 * Erros do ImageSafetyService (src/content-safety/image-safety). NÃO estendem ContentSafetyError de propósito: o catch
 * de cada provedor desvia todo ContentSafetyError (Unlocked, prompt reescrito) e o desvio genérico regera em qualquer
 * outro erro, então cada catch relança isTerminalSafetyBlock antes de qualquer desvio. A mensagem não casa com os
 * padrões de bloqueio de provedor. O evento de segurança (IMAGE_MINOR_BLOCKED, TEXT_CLASSIFIER_FLAGGED…) é gravado
 * pelo serviço; o encerramento (handleFailure) não grava MINOR_BLOCKED por eles. A cliente vê sempre o mesmo código e
 * o mesmo texto genérico; a regra e a força ficam só no registro interno.
 */

/** Onde a checagem barrou: mídia de entrada, texto do pedido ou resultado do provedor. */
export type PlatformSafetyStage = 'input' | 'text' | 'output';

export interface PlatformSafetyBlockOptions {
  /**
   * alguma mídia que devia ir para a evidência não foi (storage fora, bucket faltando): o encerramento NÃO apaga as
   * entradas (inputs/<id>/ e generation_input_images), senão a prova some junto com a limpeza
   */
  evidencePending?: boolean;
}

/** Barrado pela checagem da plataforma (código público único IMAGE_SAFETY_BLOCKED). */
export class PlatformSafetyBlockError extends Error {
  readonly failureCode = 'IMAGE_SAFETY_BLOCKED' as const;
  /** ver PlatformSafetyBlockOptions.evidencePending */
  readonly evidencePending: boolean;

  constructor(
    readonly stage: PlatformSafetyStage,
    /** regra que decidiu (E1…E7, S1…S7, T_*): só para o registro e o log, nunca para a cliente */
    readonly ruleId: string | null,
    readonly strength: string,
    options: PlatformSafetyBlockOptions = {},
  ) {
    super(
      `checagem de segurança da plataforma: ${stage} barrado (${ruleId ?? 'sem regra'}, ${strength})`,
    );
    this.name = 'PlatformSafetyBlockError';
    this.evidencePending = options.evidencePending === true;
  }
}

/** Foto, quadro ou vídeo de entrada barrado antes do provedor (E1, E2, E5, E6, E7, E3b). */
export class InputImageSafetyBlockError extends PlatformSafetyBlockError {
  constructor(
    ruleId: string | null,
    strength: string,
    options: PlatformSafetyBlockOptions = {},
  ) {
    super('input', ruleId, strength, options);
    this.name = 'InputImageSafetyBlockError';
  }
}

/** Texto do pedido barrado pelo leitor de sentido (T_CLASSIFIER, T_AMBIGUOUS) ou entrada segurada que venceu. */
export class TextSafetyBlockError extends PlatformSafetyBlockError {
  constructor(
    ruleId: string | null,
    strength: string,
    options: PlatformSafetyBlockOptions = {},
  ) {
    super('text', ruleId, strength, options);
    this.name = 'TextSafetyBlockError';
  }
}

/**
 * Resultado do provedor barrado na quarentena (S1, S2, S5, S6), ou segurado para revisão que venceu sem decisão:
 * evidência guardada, falha com estorno.
 */
export class OutputImageSafetyBlockError extends PlatformSafetyBlockError {
  constructor(
    ruleId: string | null,
    strength: string,
    options: PlatformSafetyBlockOptions = {},
  ) {
    super('output', ruleId, strength, options);
    this.name = 'OutputImageSafetyBlockError';
  }
}

/** O encerramento deste bloqueio deve manter as entradas (evidência de menor ou evidência que não foi guardada)? */
export function keepsInputsOnFailure(error: unknown): boolean {
  return error instanceof PlatformSafetyBlockError && error.evidencePending;
}

/**
 * A checagem não respondeu e a janela acabou (ou não há fila para esperar, ou o arquivo não dá para ler): a mídia
 * nunca vai ao provedor sem checagem. Terminal, com estorno ("tente de novo em instantes").
 */
export class SafetyCheckUnavailableError extends Error {
  readonly failureCode = 'SAFETY_CHECK_UNAVAILABLE' as const;

  constructor(
    /** quem falhou (rekognition, safeguard, storage, ffmpeg…) e por quê: só para o log */
    readonly provider: string,
    readonly failure: string,
  ) {
    super(
      `checagem de segurança da plataforma indisponível: ${provider} (${failure})`,
    );
    this.name = 'SafetyCheckUnavailableError';
  }
}

/**
 * A checagem não respondeu, mas ainda dá para esperar: o job volta à fila com espera crescente (moveToDelayed) até a
 * janela de 10 min contada da 1ª tentativa. NÃO é terminal e nunca desvia para outro provedor. Se o adiamento falhar,
 * o retry normal do BullMQ assume e, no fim, a geração falha como SAFETY_CHECK_UNAVAILABLE (com estorno).
 */
export class SafetyCheckPendingError extends Error {
  readonly failureCode = 'SAFETY_CHECK_UNAVAILABLE' as const;

  constructor(
    readonly provider: string,
    readonly failure: string,
    /** espera até a próxima tentativa */
    readonly delayMs: number,
    /** 1ª tentativa da checagem (epoch ms): a janela conta daqui */
    readonly firstAttemptAt: number,
    /** quantas vezes o job já foi adiado por isto */
    readonly deferrals: number,
  ) {
    super(
      `checagem de segurança da plataforma pendente: ${provider} (${failure}); nova tentativa em ${Math.round(delayMs / 1000)} s`,
    );
    this.name = 'SafetyCheckPendingError';
  }
}

/** Bloqueio que encerra a geração sem nova tentativa (menor, foto sem atestado, foto sem checagem limpa). */
export type TerminalSafetyBlockError =
  | MinorSafetyBlockError
  | ConsentRequiredSafetyError
  | UnverifiedContentBlockError
  | PlatformSafetyBlockError
  | SafetyCheckUnavailableError;

export function isTerminalSafetyBlock(
  error: unknown,
): error is TerminalSafetyBlockError {
  return (
    error instanceof MinorSafetyBlockError ||
    error instanceof ConsentRequiredSafetyError ||
    error instanceof UnverifiedContentBlockError ||
    error instanceof PlatformSafetyBlockError ||
    error instanceof SafetyCheckUnavailableError
  );
}

/**
 * A checagem da plataforma parou o pedido (bloqueio terminal ou espera na fila): nenhum desvio, nenhum fallback de
 * modelo. Na PR API #3, o catch do dispatchWithFallback relança isto ANTES de calcular o kind do tryFallback.
 */
export function isSafetyCheckHalt(error: unknown): boolean {
  return isTerminalSafetyBlock(error) || error instanceof SafetyCheckPendingError;
}


/**
 * Rota e `match` do evento MINOR_BLOCKED de um bloqueio por menor: `refiner` com o termo da trava quando foi a
 * reescrita automática que acusou; senão `provider` com o código de criança do provedor (ou 'provider').
 */
export function minorBlockAuditOf(error: unknown): {
  source: 'provider' | 'refiner';
  match: string;
} {
  if (error instanceof RefinedPromptMinorBlockError) {
    return { source: 'refiner', match: error.guardMatch };
  }
  return { source: 'provider', match: minorSupportCodeOf(error) ?? 'provider' };
}
