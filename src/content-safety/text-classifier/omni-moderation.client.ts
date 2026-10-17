import OpenAI from 'openai';
import {
  OMNI_HIGH_SCORE,
  OMNI_MEDIUM_SCORE,
  SAFETY_TIMING,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import {
  SafetyProviderUnavailableError,
  type ConfidenceBand,
  type ProviderFailureKind,
  type SafetyCallOptions,
  type TextClassifierInput,
  type TextClassifierPort,
  type TextClassifierResult,
} from '../image-safety/types';
import { CallDeadlineError, withDeadline } from './deadline';

/**
 * Segunda opinião do texto: OpenAI omni-moderation, lendo SÓ o score `sexual/minors`. Fica SEMPRE em sombra nesta
 * onda (o resultado entra no registro e nunca decide) até a OpenAI confirmar por escrito o uso em conteúdo que vai a
 * outros provedores. Só existe com OPENAI_MODERATION_API_KEY.
 *
 * O negativo não vai para o omni: "o que evitar" com termo de menor é boa prática e o omni não sabe a diferença.
 */

export const OMNI_MODEL = 'omni-moderation-latest';
const MINORS_CATEGORY = 'sexual/minors';

type ModerationsApi = Pick<OpenAI, 'moderations'>;
export type OmniClientFactory = () => ModerationsApi;

/** ≥ 0,5 alta; de 0,15 a 0,5 média; abaixo, nada. */
export function omniBandOf(score: number): ConfidenceBand {
  if (score >= OMNI_HIGH_SCORE) return 'high';
  if (score >= OMNI_MEDIUM_SCORE) return 'medium';
  return 'none';
}

/** Erro do SDK da OpenAI → motivo do registro (nunca a mensagem). */
export function omniFailureOf(error: unknown): ProviderFailureKind {
  if (error instanceof SafetyProviderUnavailableError) return error.failure;
  if (error instanceof CallDeadlineError) return 'timeout';
  if (error instanceof OpenAI.APIConnectionTimeoutError) return 'timeout';
  if (error instanceof OpenAI.APIUserAbortError) return 'timeout';
  if (error instanceof OpenAI.APIError) {
    const status: unknown = (error as { status?: unknown }).status;
    if (status === 429) return 'throttled';
    if (status === 401 || status === 403) return 'auth';
    if (status === 400 || status === 404) return 'not_configured';
  }
  return 'server_error';
}

export class OmniModerationClient implements TextClassifierPort {
  readonly name = 'omni-moderation';
  private client: ModerationsApi | null = null;
  private readonly clientFactory: OmniClientFactory;

  constructor(apiKey: string, clientFactory?: OmniClientFactory) {
    this.clientFactory =
      clientFactory ??
      (() =>
        new OpenAI({
          apiKey,
          maxRetries: 0,
          timeout: SAFETY_TIMING.textClassifierTimeoutMs,
        }));
  }

  async classify(
    input: TextClassifierInput,
    options: SafetyCallOptions = {},
  ): Promise<TextClassifierResult> {
    const texts = [input.prompt, input.serverPrompt].filter(
      (text): text is string => typeof text === 'string' && !!text.trim(),
    );
    const started = Date.now();
    if (!texts.length) return this.result(0, started);

    const timeoutMs =
      options.timeoutMs ?? SAFETY_TIMING.textClassifierTimeoutMs;
    let response: OpenAI.ModerationCreateResponse;
    try {
      response = await withDeadline(
        (signal) =>
          this.api().moderations.create(
            { model: OMNI_MODEL, input: texts },
            { signal, timeout: timeoutMs, maxRetries: 0 },
          ),
        timeoutMs,
        options.signal,
      );
    } catch (error) {
      throw new SafetyProviderUnavailableError(this.name, omniFailureOf(error));
    }

    const results = Array.isArray(response?.results) ? response.results : [];
    if (results.length !== texts.length) {
      throw new SafetyProviderUnavailableError(this.name, 'invalid_response');
    }
    let score = 0;
    for (const result of results) {
      const value: unknown = result?.category_scores?.[MINORS_CATEGORY];
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      ) {
        throw new SafetyProviderUnavailableError(this.name, 'invalid_response');
      }
      score = Math.max(score, value);
    }
    return this.result(score, started);
  }

  private result(score: number, started: number): TextClassifierResult {
    const band = omniBandOf(score);
    return {
      classifier: this.name,
      violation: band !== 'none',
      band,
      policyRuleId: null,
      score,
      sexual: null,
      explicitMinor: false,
      policyVersion: null,
      region: null,
      latencyMs: Date.now() - started,
    };
  }

  private api(): ModerationsApi {
    this.client ??= this.clientFactory();
    return this.client;
  }
}

/** Omni só com chave; sem ela, nenhum cliente da OpenAI é criado. */
export function createOmniModerationClient(
  config: Pick<ImageSafetyConfig, 'omniModerationApiKey'>,
  clientFactory?: OmniClientFactory,
): OmniModerationClient | null {
  if (!config.omniModerationApiKey) return null;
  return new OmniModerationClient(config.omniModerationApiKey, clientFactory);
}
