import { ContentSafetyError } from './content-safety.error';
import {
  classifyGenerationFailure,
  GenerationFailureCode,
} from './failure-reason';

/**
 * Recusa do provedor por MENOR de idade. Recusa assim encerra a geração: não
 * desvia para modelo alternativo (nem com filtro) e não volta para a fila.
 * Função pura: sem rede, sem banco.
 *
 * Conta como menor:
 *  - código de criança do Vertex (campo `supportCode` ou texto);
 *  - identificador de moderação que só existe para menor (CSAM, sexual/minors,
 *    PUBLIC_ERROR_MINOR…);
 *  - texto que fala de criança/menor DENTRO de um erro de segurança/política.
 *    Fora disso não conta: "child process exited" é falha técnica.
 *
 * Merge com a PR #4: trocar pelos isMinorSafetyBlock / isTerminalSafetyBlock
 * de content-safety.error.ts e apagar este arquivo.
 */

/** Códigos de suporte do Vertex AI para criança (tabela em content-safety.error.ts). */
const MINOR_SUPPORT_CODES: ReadonlySet<string> = new Set([
  '58061214',
  '17301594',
]);

/** Código de criança no texto, sem pegar pedaço de número maior. */
const MINOR_CODE_IN_TEXT = /(?<!\d)(?:58061214|17301594)(?!\d)/;

/** Identificadores de moderação que só existem para menor: valem sozinhos. */
const EXPLICIT_MINOR_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])(?:csam|csae|csea)(?![\p{L}\p{N}])/iu,
  // categoria de moderação: sexual/minors, sexual_minors, sexualized minor
  /(?<![\p{L}\p{N}])sexual\p{L}*[\s/_-]+minors?(?![\p{L}\p{N}])/iu,
  // PUBLIC_ERROR_MINOR… do Veo/Gemini; a kie devolve em minúsculas e com espaços
  /public[\s_-]*error[\s_-]*minors?(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])(?:pa?edophil|ped[oó]fil)/iu,
];

/**
 * Como os provedores dizem "menor" (en/pt/es). Mesmos padrões da PR #4: "minor"
 * no singular também é adjetivo ("minor issue"), então só conta como substantivo.
 */
const MINOR_TEXT_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])(?:child(?:ren|like)?|kids?|infants?|toddlers?|newborns?|(?:pre[\s-]?)?teen(?:s|age|aged|ager|agers)?|adolescent(?:e|es|s)?|under[\s-]?aged?|minors|crian[çc]as?|infantil|infantis|niñ[oa]s?|menor(?:es)?\s+de\s+(?:idade|edad))(?![\p{L}\p{N}])/iu,
  // "a minor's body", "minor girl", "minor users"
  /(?<![\p{L}\p{N}])minor(?:['’]s|\s+(?:girls?|boys?|child(?:ren)?|kids?|persons?|people|individuals?|users?|females?|males?|daughters?|sons?))(?![\p{L}\p{N}])/iu,
  // "a minor", "of a minor", "involving a minor"… seguido de fim, pontuação ou palavra de ligação
  /(?<![\p{L}\p{N}])(?:a|any|the|of|involv(?:e|es|ed|ing)|depict(?:s|ed|ing)?|sexuali[sz](?:e|es|ed|ing)|resembl(?:e|es|ing))\s+minor(?=\s*$|\s*[^\p{L}\p{N}\s]|\s+(?:in|on|at|or|and|who|that|which|is|was|are|were|be|being|under|as|with|without|wearing|posing|appearing|appears|depicted|shown|present|detected|engaged|involved|nude|naked|sexual|sexually|explicit)(?![\p{L}\p{N}]))/iu,
  // código em identificador: PUBLIC_ERROR_MINOR, MINOR_UPLOAD, is_minor
  /(?:(?<=_)minors?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}_])minors?(?=_))/iu,
  // nome de política: "Minor Safety", "minor protection"
  /(?<![\p{L}\p{N}])minor[\s_-]*(?:safety|protection)(?![\p{L}\p{N}])/iu,
  // pt/es: "com menores", "sexualizem menores", "abuso sexual de menores"
  /(?<![\p{L}\p{N}])(?:a|con|com|envolvendo|involucrando|sexualiz\p{L}*|sexual(?:es)?\s+(?:de|con|com|envolvendo))\s+menores(?![\p{L}\p{N}])/iu,
];

/** Vocabulário de bloqueio de conteúdo (en/pt/es) que os padrões de segurança não cobrem. */
const SAFETY_WORDING =
  /(?<![\p{L}\p{N}])(?:refus|reject|block|prohib|disallow|viola|unsafe|safety|modera|flagged|inappropriate|guideline|abus|exploit|harm|illegal|sexual|not\s+(?:allowed|permitted)|bloque|recus|rejeit|rechaz|proib|inapropriad|seguran[çc]a|seguridad|diretriz|directri[zc]|n[ãa]o\s+permitid|no\s+permitid)/iu;

/** Texto do erro: mensagem + detalhe técnico (ProviderFailureError) ou a string crua. */
function refusalTexts(error: unknown): string[] {
  if (typeof error === 'string') return error ? [error] : [];
  if (!error || typeof error !== 'object') return [];
  const { message, providerDetail } = error as {
    message?: unknown;
    providerDetail?: unknown;
  };
  return [message, providerDetail].filter(
    (text): text is string => typeof text === 'string' && text.length > 0,
  );
}

function hasMinorSupportCode(error: unknown, texts: string[]): boolean {
  if (error && typeof error === 'object') {
    const { supportCode } = error as { supportCode?: unknown };
    if (
      typeof supportCode === 'string' &&
      MINOR_SUPPORT_CODES.has(supportCode.trim())
    ) {
      return true;
    }
  }
  return texts.some((text) => MINOR_CODE_IN_TEXT.test(text));
}

/** O erro é bloqueio de segurança/política (mesma régua do isSafetyRelatedError + vocabulário de recusa)? */
function isSafetyContext(error: unknown, text: string): boolean {
  if (error instanceof ContentSafetyError) return true;
  if (ContentSafetyError.fromErrorMessage(text)) return true;
  const code = classifyGenerationFailure(text, false);
  return (
    code === GenerationFailureCode.CONTENT_SAFETY_BLOCKED ||
    code === GenerationFailureCode.INPUT_IMAGE_REJECTED ||
    SAFETY_WORDING.test(text)
  );
}

/**
 * O provedor recusou por MENOR de idade? Aceita o erro (ContentSafetyError,
 * ProviderFailureError, Error) ou a mensagem crua.
 */
export function isMinorRefusal(error: unknown): boolean {
  const texts = refusalTexts(error);
  if (hasMinorSupportCode(error, texts)) return true;
  const matches = (patterns: readonly RegExp[]) =>
    texts.some((text) => patterns.some((pattern) => pattern.test(text)));
  if (matches(EXPLICIT_MINOR_PATTERNS)) return true;
  if (!matches(MINOR_TEXT_PATTERNS)) return false;
  return isSafetyContext(error, texts.join(' '));
}
