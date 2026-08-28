/**
 * Classificação do motivo real de uma geração ter falhado.
 *
 * O `errorMessage` que o provedor devolve é texto livre (e muda sem aviso), então
 * ele não serve pro front decidir o que mostrar. Aqui a mensagem crua vira um
 * CÓDIGO estável, gravado em `generations.error_code` e emitido no evento SSE —
 * o front traduz esse código para uma mensagem localizada e acionável
 * ("troque para um modelo sem censura", "o vídeo precisa ter entre 3s e 30s"…).
 *
 * Sem isso, ~86% das falhas caíam no genérico "não foi possível concluir a
 * geração, tente novamente" — inclusive as que o usuário conseguiria resolver
 * sozinho (levantamento de 14 dias em 2026-08-28).
 *
 * Ao adicionar um código novo aqui, adicione também a string correspondente em
 * `web/messages/{en,es,pt-BR}/home.json` → `home.errors.<código em camelCase>`.
 */
export const GenerationFailureCode = {
  /** Provedor recusou por política de conteúdo / filtro de segurança. */
  CONTENT_SAFETY_BLOCKED: 'CONTENT_SAFETY_BLOCKED',
  /** A imagem enviada foi recusada pelo provedor (não o prompt). */
  INPUT_IMAGE_REJECTED: 'INPUT_IMAGE_REJECTED',
  /** Não achou pessoa/rosto no vídeo ou na imagem de entrada. */
  NO_SUBJECT_DETECTED: 'NO_SUBJECT_DETECTED',
  /** Duração de saída pedida não existe pra esse modelo/modo. */
  VIDEO_DURATION_UNSUPPORTED: 'VIDEO_DURATION_UNSUPPORTED',
  /** Vídeo enviado está fora da faixa de duração aceita. */
  VIDEO_INPUT_DURATION_INVALID: 'VIDEO_INPUT_DURATION_INVALID',
  /** Vídeo enviado tem resolução abaixo do mínimo. */
  VIDEO_INPUT_RESOLUTION_LOW: 'VIDEO_INPUT_RESOLUTION_LOW',
  /** Combinação de imagens de referência não suportada pelo modelo. */
  REFERENCE_MIX_UNSUPPORTED: 'REFERENCE_MIX_UNSUPPORTED',
  /** Prompt cita @elemento mas o elemento não foi enviado. */
  REFERENCE_ELEMENT_MISSING: 'REFERENCE_ELEMENT_MISSING',
  /** Arquivo de entrada maior que o limite. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** Prompt maior que o limite do provedor. */
  PROMPT_TOO_LONG: 'PROMPT_TOO_LONG',
  /** Vídeo saiu, mas o modelo não conseguiu gerar o áudio pedido. */
  AUDIO_UNAVAILABLE: 'AUDIO_UNAVAILABLE',
  /** Provedor respondeu OK mas sem mídia. */
  NO_OUTPUT_RETURNED: 'NO_OUTPUT_RETURNED',
  /** Fila/capacidade do provedor estourada — dá certo tentando de novo. */
  PROVIDER_OVERLOADED: 'PROVIDER_OVERLOADED',
  /** Nossa cota/saldo no provedor acabou — problema nosso, não do usuário. */
  PROVIDER_QUOTA_EXCEEDED: 'PROVIDER_QUOTA_EXCEEDED',
  /** Erro interno do provedor (500 / "Internal Error"). */
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  /** Estourou o tempo máximo (também usado pelo cron de gerações presas). */
  GENERATION_TIMEOUT: 'GENERATION_TIMEOUT',
  /** Não classificado — investigar em /admin e criar um código novo. */
  GENERATION_FAILED: 'GENERATION_FAILED',
} as const;

export type GenerationFailureCodeValue =
  (typeof GenerationFailureCode)[keyof typeof GenerationFailureCode];

/**
 * Erro de provedor que já vem com uma mensagem amigável, mas guarda o motivo
 * técnico original em `providerDetail`.
 *
 * Vários providers trocam o texto do provedor por um genérico ("Não foi possível
 * gerar a imagem") pra não vazar nome/detalhe técnico pro usuário — e com isso o
 * motivo real se perdia antes de chegar aqui. Com esta classe o texto amigável
 * continua sendo o `message`, e o `providerDetail` alimenta a classificação.
 */
export class ProviderFailureError extends Error {
  readonly providerDetail: string;

  constructor(userMessage: string, providerDetail: string) {
    super(userMessage);
    this.name = 'ProviderFailureError';
    this.providerDetail = providerDetail;
  }
}

/** Texto que a classificação deve olhar: mensagem + detalhe técnico, quando houver. */
export function rawFailureText(error: Error): string {
  const detail = (error as ProviderFailureError).providerDetail;
  return detail ? `${error.message} ${detail}` : error.message;
}

/**
 * Padrões observados nas mensagens reais dos provedores (Veo/Vertex, Kling,
 * GPT Image 2, Nano Banana/KIE, WaveSpeed, Gemini Omni, Seedance).
 * A ordem importa: o primeiro que casar vence, do mais específico pro mais geral.
 */
const PATTERNS: Array<[RegExp, GenerationFailureCodeValue]> = [
  // ── entrada inválida (o usuário consegue corrigir) ──────────────────────────
  [
    /unsupported output video duration|supported durations are/i,
    GenerationFailureCode.VIDEO_DURATION_UNSUPPORTED,
  ],
  [
    /video duration must be between/i,
    GenerationFailureCode.VIDEO_INPUT_DURATION_INVALID,
  ],
  [
    /video resolution must be at least/i,
    GenerationFailureCode.VIDEO_INPUT_RESOLUTION_LOW,
  ],
  [
    /mix of references|does not support this mix/i,
    GenerationFailureCode.REFERENCE_MIX_UNSUPPORTED,
  ],
  [
    /kling_elements is required|role references like @/i,
    GenerationFailureCode.REFERENCE_ELEMENT_MISSING,
  ],
  [
    /exceeded the maximum allowed size|file too large|payload too large|\b413\b/i,
    GenerationFailureCode.FILE_TOO_LARGE,
  ],
  [
    /prompt exceeds maximum length|prompt is too long/i,
    GenerationFailureCode.PROMPT_TOO_LONG,
  ],
  [
    /no valid characters detected|no face detected|face not detected|no person detected/i,
    GenerationFailureCode.NO_SUBJECT_DETECTED,
  ],
  [
    /image is not compliant|input was rejected|change your input files/i,
    GenerationFailureCode.INPUT_IMAGE_REJECTED,
  ],
  // ── bloqueio de conteúdo ───────────────────────────────────────────────────
  // Fica DEPOIS da entrada inválida (mais específica) e ANTES dos erros de
  // provedor. Cobre também os textos que o ContentSafetyError não reconhece —
  // Gemini Omni (PUBLIC_ERROR_*), GPT Image 2 ("guardrails", "appear to be
  // unsafe") e Kling ("sensitive information").
  [
    /public_error_|guardrails|may violate|appear to be unsafe|flagged (as|by|for)|sensitive information|content policy|prohibited use|violat.*(polic|guideline)|viola.*diretrizes|could not be processed|safety system|moderation|\bnsfw\b/i,
    GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
  ],
  // ── nosso lado / provedor ──────────────────────────────────────────────────
  [/unable to generate audio/i, GenerationFailureCode.AUDIO_UNAVAILABLE],
  [
    /no video data returned|no image(s)? returned|no image in response|empty (output|response)/i,
    GenerationFailureCode.NO_OUTPUT_RETURNED,
  ],
  [
    /quota exceeded|credits insufficient|balance isn.t enough|no gcp accounts configured/i,
    GenerationFailureCode.PROVIDER_QUOTA_EXCEEDED,
  ],
  [
    /experiencing high load|currently unavailable|service unavailable|\b503\b|"code":\s*(8|14)\b/i,
    GenerationFailureCode.PROVIDER_OVERLOADED,
  ],
  [
    /tim(e|ed)?[ -]?out|deadline exceeded|expirou por timeout|demorou mais que o esperado/i,
    GenerationFailureCode.GENERATION_TIMEOUT,
  ],
  [
    /internal error|internal server error|\b500\b|fetch failed|was aborted|finished with state: failed/i,
    GenerationFailureCode.PROVIDER_ERROR,
  ],
];

/**
 * Traduz a mensagem CRUA do provedor num código estável.
 *
 * @param rawMessage mensagem original do erro — nunca a versão já amigável,
 *                   senão a classificação se perde.
 * @param isSafetyError true quando o erro já foi identificado como bloqueio de
 *                      conteúdo (ContentSafetyError). Só vale como fallback:
 *                      um erro de entrada inválida detectado acima ganha dele,
 *                      porque diz ao usuário exatamente o que corrigir.
 */
export function classifyGenerationFailure(
  rawMessage: string | null | undefined,
  isSafetyError = false,
): GenerationFailureCodeValue {
  const msg = rawMessage ?? '';

  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(msg)) return code;
  }

  if (isSafetyError) return GenerationFailureCode.CONTENT_SAFETY_BLOCKED;

  return GenerationFailureCode.GENERATION_FAILED;
}
