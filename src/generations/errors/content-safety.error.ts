import { ErrorCodes } from '../../common/constants/error-codes';

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
 *  - `same_provider`: nova tentativa com o prompt reescrito no MESMO provedor com filtro, que já recebeu as fotos
 *    (refazer ali não leva a foto a lugar novo nem tira filtro nenhum).
 */
export type SafetyFallbackTarget = 'uncensored' | 'same_provider';

export interface SafetyFallbackInput {
  /** desvio que vem depois do bloqueio */
  target: SafetyFallbackTarget;
  /** o provedor recusou por menor de idade (isMinorSafetyBlock) */
  isMinor: boolean;
  /** o pedido leva foto, frame, referência ou vídeo enviado pelo usuário (pode ser pessoa real) */
  hasUserImages: boolean;
  /** o pedido que criou a geração trouxe atestado de consentimento gravado */
  hasConsent: boolean;
}

/**
 * O que fazer depois que um provedor com censura bloqueou o conteúdo, ANTES de qualquer desvio:
 *  - menor → `fail_minor` (qualquer alvo): encerra, sem desvio e sem reescrever o prompt;
 *  - `same_provider` → `allow_fallback`: a nova tentativa com o prompt reescrito vai ao provedor que já tem a foto;
 *  - `uncensored` com foto do usuário sem atestado → `fail_blocked`: encerra pedindo o atestado, sem levar a foto
 *    ao modelo sem censura;
 *  - `uncensored` só com texto, ou com foto atestada → `allow_fallback`.
 */
export function decideSafetyFallback({
  target,
  isMinor,
  hasUserImages,
  hasConsent,
}: SafetyFallbackInput): SafetyFallbackDecision {
  if (isMinor) return 'fail_minor';
  if (target === 'same_provider') return 'allow_fallback';
  if (hasUserImages && !hasConsent) return 'fail_blocked';
  return 'allow_fallback';
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

/** Bloqueio que encerra a geração sem nova tentativa (menor de idade ou foto sem atestado). */
export type TerminalSafetyBlockError =
  | MinorSafetyBlockError
  | ConsentRequiredSafetyError;

export function isTerminalSafetyBlock(
  error: unknown,
): error is TerminalSafetyBlockError {
  return (
    error instanceof MinorSafetyBlockError ||
    error instanceof ConsentRequiredSafetyError
  );
}
