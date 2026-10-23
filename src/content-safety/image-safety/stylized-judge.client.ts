import type { ImageSafetyConfig } from './image-safety.config';
import {
  NormalizedImage,
  ProviderFailureKind,
  SafetyCallOptions,
  SafetyProviderUnavailableError,
  StylizedJudgePort,
  StylizedSignal,
} from './types';

/**
 * Juiz de imagem estilizada (regras E5 e S5): anime, 3D ou figura sem rosto real, onde a estimativa de idade do
 * Rekognition não vale. Pergunta neutra a um modelo de visão: "a figura aparenta ser menor de idade? traço
 * infantil?". DESLIGADO sem HIVE_API_KEY (o self-serve da Hive trava em 100 chamadas/dia; depende de contrato).
 *
 * Formato da Hive VLM conferido na documentação oficial (docs.thehive.ai, "Hive Vision Language Model (VLM)",
 * 17/10/2026): POST /api/v3/chat/completions, Bearer com a chave secreta, modelo `hive/vision-language-model`,
 * imagem em `image_url` com data URI base64 (até 20 MB), `response_format` json_schema, resposta em
 * choices[0].message.content (texto com o JSON). 429 = limite, 405 = organização pausada (sem crédito).
 */

type JudgedSignal = Extract<StylizedSignal, { status: 'judged' }>;
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const HIVE_VLM_URL = 'https://api.thehive.ai/api/v3/chat/completions';
export const HIVE_VLM_MODEL = 'hive/vision-language-model';
/** Prazo padrão de uma pergunta ao juiz (modelo de visão; a orquestração pode passar um menor). */
export const STYLIZED_JUDGE_TIMEOUT_MS = 8_000;

const JUDGE_QUESTION =
  'Look at the main figure or figures in this image. Does any figure appear to be under 18 years old, ' +
  'or is any figure drawn with childlike body proportions or childlike facial features? ' +
  'Answer only with the requested JSON. confidence is how sure you are, from 0 to 100.';

const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'figure_age_assessment',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        appears_minor: { type: 'boolean' },
        confidence: { type: 'number' },
      },
      required: ['appears_minor', 'confidence'],
      additionalProperties: false,
    },
  },
} as const;

/** Desligado: a orquestração não deve chamar (enabled false); se chamar, é "não configurado", nunca "adulto". */
export class NoopStylizedJudge implements StylizedJudgePort {
  readonly name = 'none';
  readonly enabled = false;

  judge(): Promise<JudgedSignal> {
    return Promise.reject(
      new SafetyProviderUnavailableError('stylized-judge', 'not_configured'),
    );
  }
}

function failureForStatus(status: number): ProviderFailureKind {
  if (status === 429) return 'throttled';
  if (status === 401 || status === 403 || status === 405) return 'auth';
  if (status >= 500) return 'server_error';
  return 'invalid_response';
}

/** Lê o JSON do juiz (texto em choices[0].message.content). Fora do formato = invalid_response. */
export function parseHiveJudgeResponse(body: string): {
  childlike: boolean;
  confidence: number;
} {
  const invalid = () =>
    new SafetyProviderUnavailableError('hive-vlm', 'invalid_response');
  let content: unknown;
  try {
    const parsed = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    content = parsed.choices?.[0]?.message?.content;
  } catch {
    throw invalid();
  }
  if (typeof content !== 'string') throw invalid();
  let answer: { appears_minor?: unknown; confidence?: unknown };
  try {
    answer = JSON.parse(content.trim()) as typeof answer;
  } catch {
    throw invalid();
  }
  if (
    !answer ||
    typeof answer.appears_minor !== 'boolean' ||
    typeof answer.confidence !== 'number' ||
    !Number.isFinite(answer.confidence)
  ) {
    throw invalid();
  }
  return {
    childlike: answer.appears_minor,
    confidence: Math.min(100, Math.max(0, answer.confidence)),
  };
}

/** fetch nativo chamado solto (sem depender do `this` de quem guarda a referência) */
const nativeFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, init) as unknown as ReturnType<FetchLike>;

export class HiveStylizedJudge implements StylizedJudgePort {
  readonly name = 'hive-vlm';
  readonly enabled = true;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = nativeFetch,
  ) {}

  async judge(
    image: NormalizedImage,
    options: SafetyCallOptions = {},
  ): Promise<JudgedSignal> {
    if (!image?.jpeg?.length) {
      throw new SafetyProviderUnavailableError(this.name, 'invalid_media');
    }
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0
        ? options.timeoutMs
        : STYLIZED_JUDGE_TIMEOUT_MS;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(HIVE_VLM_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: HIVE_VLM_MODEL,
          temperature: 0,
          max_tokens: 64,
          response_format: RESPONSE_SCHEMA,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: JUDGE_QUESTION },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${image.jpeg.toString('base64')}`,
                  },
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SafetyProviderUnavailableError(
          this.name,
          failureForStatus(response.status),
        );
      }
      const verdict = parseHiveJudgeResponse(await response.text());
      return {
        status: 'judged',
        judge: this.name,
        childlike: verdict.childlike,
        confidence: verdict.confidence,
      };
    } catch (error) {
      if (error instanceof SafetyProviderUnavailableError) throw error;
      throw new SafetyProviderUnavailableError(
        this.name,
        controller.signal.aborted ? 'timeout' : 'server_error',
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** Fábrica do provider: com HIVE_API_KEY, o juiz da Hive; sem ela, desligado. */
export function createStylizedJudge(
  config: Pick<ImageSafetyConfig, 'hiveApiKey'>,
  fetchImpl?: FetchLike,
): StylizedJudgePort {
  return config.hiveApiKey
    ? new HiveStylizedJudge(config.hiveApiKey, fetchImpl)
    : new NoopStylizedJudge();
}
