import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import {
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
import type { SafetyPolicy } from './policy-loader';

/**
 * Leitor de sentido do texto (camada 2): gpt-oss-safeguard-20b na Bedrock, pela API Converse, seguindo a política
 * PRIVADA (system prompt). Região principal (São Paulo) e uma nova tentativa na reserva; 3 s por tentativa. Falhou nas
 * duas → SafetyProviderUnavailableError (quem chama aplica a regra de falha da camada 2, nunca "limpo").
 *
 * Lê só os blocos de TEXTO da resposta: o raciocínio do modelo (reasoningContent) pode repetir o pedido e nunca é
 * guardado nem logado. O `rationale` da saída também é descartado.
 */

type ConverseSender = Pick<BedrockRuntimeClient, 'send'>;
export type BedrockClientFactory = (region: string) => ConverseSender;

export interface SafeguardOutput {
  violation: boolean;
  ruleId: string | null;
  confidence: 'low' | 'medium' | 'high';
  sexual: boolean | null;
  explicitMinor: boolean;
}

const CONFIDENCES = new Set(['low', 'medium', 'high']);
const RULE_ID_FORMAT = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Resposta maior que isto não é o JSON da política (o raciocínio vem em bloco separado). */
const OUTPUT_MAX_CHARS = 8_000;
const CONNECTION_TIMEOUT_MS = 1_000;

function invalidResponse(): SafetyProviderUnavailableError {
  return new SafetyProviderUnavailableError('safeguard', 'invalid_response');
}

/** 0/1 ou booleano; ausente = `missing`; outro valor = resposta inválida. */
function flag<T>(value: unknown, missing: T): boolean | T {
  if (value === undefined || value === null) return missing;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw invalidResponse();
}

/**
 * Confere a saída do safeguard: `{ violation: 0|1, rule_id, confidence: low|medium|high, sexual?: 0|1,
 * explicit_minor?: 0|1, rationale? }`, sozinha ou dentro de um bloco ```json. Qualquer outra coisa →
 * SafetyProviderUnavailableError('safeguard', 'invalid_response').
 */
export function parseSafeguardOutput(text: string): SafeguardOutput {
  if (typeof text !== 'string' || text.length > OUTPUT_MAX_CHARS) {
    throw invalidResponse();
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  const body = (fenced ? fenced[1] : text).trim();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw invalidResponse();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidResponse();
  }
  const record = data as Record<string, unknown>;

  const violation = flag(record.violation, undefined);
  if (violation === undefined) throw invalidResponse();

  const rawConfidence =
    typeof record.confidence === 'string'
      ? record.confidence.trim().toLowerCase()
      : record.confidence;
  let confidence: SafeguardOutput['confidence'];
  if (typeof rawConfidence === 'string' && CONFIDENCES.has(rawConfidence)) {
    confidence = rawConfidence as SafeguardOutput['confidence'];
  } else if (rawConfidence === undefined && !violation) {
    // sem violação a confiança não decide nada
    confidence = 'low';
  } else {
    throw invalidResponse();
  }

  const rawRule = record.rule_id;
  let ruleId: string | null = null;
  if (typeof rawRule === 'string' && rawRule.trim()) {
    if (!RULE_ID_FORMAT.test(rawRule.trim())) throw invalidResponse();
    ruleId = rawRule.trim();
  } else if (rawRule !== undefined && rawRule !== null && rawRule !== '') {
    throw invalidResponse();
  }

  return {
    violation,
    ruleId,
    confidence,
    sexual: flag(record.sexual, null),
    explicitMinor: flag(record.explicit_minor, false) === true,
  };
}

/** Violação com confiança alta = faixa alta; média ou baixa = faixa média (baixa é ambígua, não limpa). */
export function safeguardBandOf(output: SafeguardOutput): ConfidenceBand {
  if (!output.violation) return 'none';
  return output.confidence === 'high' ? 'high' : 'medium';
}

const THROTTLED = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceQuotaExceededException',
]);
const AUTH = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'InvalidSignatureException',
  'CredentialsProviderError',
]);
const NOT_CONFIGURED = new Set([
  'ValidationException',
  'ResourceNotFoundException',
]);
const TIMEOUT = new Set([
  'AbortError',
  'TimeoutError',
  'ModelTimeoutException',
]);

/** Erro da Bedrock → motivo do registro (nunca a mensagem, que pode citar o pedido). */
export function bedrockFailureOf(error: unknown): ProviderFailureKind {
  if (error instanceof SafetyProviderUnavailableError) return error.failure;
  if (error instanceof CallDeadlineError) return 'timeout';
  const name =
    error && typeof error === 'object' && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  if (TIMEOUT.has(name)) return 'timeout';
  if (THROTTLED.has(name)) return 'throttled';
  if (AUTH.has(name)) return 'auth';
  if (NOT_CONFIGURED.has(name)) return 'not_configured';
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  if (status === 429) return 'throttled';
  if (status === 401 || status === 403) return 'auth';
  return 'server_error';
}

/** Junta só os blocos de texto da resposta (ignora reasoningContent e qualquer outro tipo). */
export function converseOutputText(output: ConverseCommandOutput): string {
  const content = output.output?.message?.content ?? [];
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block.text === 'string') parts.push(block.text);
  }
  if (!parts.length) throw invalidResponse();
  return parts.join('').trim();
}

function defaultClientFactory(config: ImageSafetyConfig): BedrockClientFactory {
  return (region) =>
    new BedrockRuntimeClient({
      region,
      // a nova tentativa é a região reserva, feita aqui
      maxAttempts: 1,
      credentials: config.awsCredentials ?? undefined,
      requestHandler: {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        requestTimeout: SAFETY_TIMING.textClassifierTimeoutMs,
      },
    });
}

export class SafeguardClient implements TextClassifierPort {
  readonly name = 'safeguard';
  private readonly clients = new Map<string, ConverseSender>();
  private readonly clientFactory: BedrockClientFactory;

  constructor(
    private readonly config: ImageSafetyConfig,
    private readonly policy: () => Promise<SafetyPolicy>,
    clientFactory?: BedrockClientFactory,
  ) {
    this.clientFactory = clientFactory ?? defaultClientFactory(config);
  }

  async classify(
    input: TextClassifierInput,
    options: SafetyCallOptions = {},
  ): Promise<TextClassifierResult> {
    const modelId = this.config.bedrockSafeguardModelId;
    const primary = this.config.bedrockRegion;
    if (!modelId) {
      throw new SafetyProviderUnavailableError(
        'safeguard',
        'not_configured',
        primary,
      );
    }
    const policy = await this.policy();
    const regions = [primary, this.config.bedrockFallbackRegion].filter(
      (region): region is string => !!region,
    );
    const perAttempt = SAFETY_TIMING.textClassifierTimeoutMs;
    const deadline =
      Date.now() + (options.timeoutMs ?? perAttempt * regions.length);
    const command = new ConverseCommand(this.request(modelId, policy, input));

    let failure: SafetyProviderUnavailableError | null = null;
    for (const region of regions) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || options.signal?.aborted) break;
      const started = Date.now();
      try {
        const output = await withDeadline(
          (abortSignal) => this.client(region).send(command, { abortSignal }),
          Math.min(perAttempt, remaining),
          options.signal,
        );
        const parsed = parseSafeguardOutput(converseOutputText(output));
        return {
          classifier: this.name,
          violation: parsed.violation,
          band: safeguardBandOf(parsed),
          policyRuleId: parsed.ruleId,
          score: null,
          sexual: parsed.sexual,
          explicitMinor: parsed.violation && parsed.explicitMinor,
          policyVersion: policy.version,
          region,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        failure = new SafetyProviderUnavailableError(
          this.name,
          bedrockFailureOf(error),
          region,
        );
      }
    }
    throw (
      failure ??
      new SafetyProviderUnavailableError(this.name, 'timeout', primary)
    );
  }

  /** Pedido Converse: política no system, cada campo do texto separado num JSON (o negativo é "o que evitar"). */
  private request(
    modelId: string,
    policy: SafetyPolicy,
    input: TextClassifierInput,
  ): ConverseCommandInput {
    const request: ConverseCommandInput = {
      modelId,
      system: [{ text: policy.policy }],
      messages: [
        {
          role: 'user',
          content: [
            {
              text: JSON.stringify({
                prompt: input.prompt ?? '',
                negative: input.negative ?? '',
                server_prompt: input.serverPrompt ?? '',
              }),
            },
          ],
        },
      ],
      inferenceConfig: { temperature: 0, maxTokens: 1024 },
    };
    if (policy.reasoningEffortParameter) {
      request.additionalModelRequestFields = {
        [policy.reasoningEffortParameter]: policy.reasoningEffort,
      };
    }
    return request;
  }

  private client(region: string): ConverseSender {
    let client = this.clients.get(region);
    if (!client) {
      client = this.clientFactory(region);
      this.clients.set(region, client);
    }
    return client;
  }
}
