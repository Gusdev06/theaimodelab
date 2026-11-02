import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  groundVerdict,
  JUDGE_SYSTEM_PROMPT,
  judgeInput,
  judgeMessage,
  parseVerdict,
  POLICY_VERSION,
  VERDICT_SCHEMA,
  type JudgeContext,
  type JudgeVerdict,
} from './prompt-judge.policy';

export type JudgeMode = 'off' | 'shadow' | 'enforce';

/** O que o interceptor recebe: veredito (ou indisponível) e de onde veio. */
export interface JudgeOutcome {
  /** null = o juiz não respondeu (chave ausente, tempo esgotado, erro, resposta fora do contrato): nunca bloqueia */
  verdict: JudgeVerdict | null;
  source: 'model' | 'cache' | 'unavailable';
  latencyMs: number;
  model: string;
}

/** Só o que o juiz usa do cliente da Anthropic (os testes passam um falso por este token). */
export interface JudgeClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<Anthropic.Message>;
  };
}

export const PROMPT_JUDGE_CLIENT = Symbol('PROMPT_JUDGE_CLIENT');

export const JUDGE_DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 2000;
const MAX_TOKENS = 200;
const DEFAULT_CONTEXT: JudgeContext = { uncensored: false };

/**
 * Juiz de prompt: lê o pedido inteiro com um modelo Claude e diz se ele sexualiza menor de idade ou mira pessoa
 * real. Roda depois da trava de termos e antes do provedor, uma vez por pedido (pedido igual em 10 min reaproveita o
 * veredito). Falha de rede, tempo esgotado ou resposta fora do contrato = "indisponível": o pedido segue (a trava de
 * termos já cobriu o explícito) e fica no log. Modos: off (nada roda), shadow (só log), enforce (bloqueia o que vier
 * como menor com confiança alta). O modelo padrão é o Haiku pelo volume (um pedido por geração), como o bot de
 * suporte; PROMPT_JUDGE_MODEL troca sem deploy. A resposta vem no esquema VERDICT_SCHEMA imposto pela API
 * (structured outputs), e o veredito de pessoa real ainda é conferido contra o texto (groundVerdict).
 */
@Injectable()
export class PromptJudgeService {
  private readonly logger = new Logger(PromptJudgeService.name);
  private client: JudgeClient | null = null;
  private readonly cache = new Map<string, { verdict: JudgeVerdict; at: number }>();

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(PROMPT_JUDGE_CLIENT) injectedClient?: JudgeClient,
  ) {
    this.client = injectedClient ?? null;
  }

  mode(): JudgeMode {
    const raw = (this.config.get<string>('PROMPT_JUDGE_MODE') ?? 'off').trim().toLowerCase();
    return raw === 'enforce' || raw === 'shadow' ? raw : 'off';
  }

  /** Pessoa real só é bloqueada com a opção ligada; o padrão é registrar no log (não há código de erro próprio ainda). */
  realPersonEnforced(): boolean {
    return (this.config.get<string>('PROMPT_JUDGE_REAL_PERSON') ?? 'shadow').trim().toLowerCase() === 'enforce';
  }

  enabled(): boolean {
    return this.mode() !== 'off' && Boolean(this.apiKey());
  }

  model(): string {
    return (this.config.get<string>('PROMPT_JUDGE_MODEL') ?? JUDGE_DEFAULT_MODEL).trim() || JUDGE_DEFAULT_MODEL;
  }

  private apiKey(): string | null {
    const key = this.config.get<string>('ANTHROPIC_API_KEY')?.trim();
    return key ? key : null;
  }

  private timeoutMs(): number {
    const raw = Number(this.config.get<string>('PROMPT_JUDGE_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw >= 500 ? raw : DEFAULT_TIMEOUT_MS;
  }

  private clientOrNull(): JudgeClient | null {
    if (this.client) return this.client;
    const apiKey = this.apiKey();
    if (!apiKey) return null;
    this.client = new Anthropic({ apiKey, maxRetries: 0 });
    return this.client;
  }

  /** Lê os textos livres de um pedido. Nunca lança: qualquer falha vira `unavailable`. */
  async review(texts: readonly string[], context: JudgeContext = DEFAULT_CONTEXT): Promise<JudgeOutcome> {
    const model = this.model();
    const input = judgeInput(texts);
    const started = Date.now();
    if (!input) return { verdict: null, source: 'unavailable', latencyMs: 0, model };

    const key = createHash('sha256').update(`${POLICY_VERSION}|${model}|${context.uncensored ? 'u' : 'f'}|${input}`).digest('hex');
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { verdict: cached.verdict, source: 'cache', latencyMs: 0, model };
    }

    const client = this.clientOrNull();
    if (!client) return { verdict: null, source: 'unavailable', latencyMs: 0, model };

    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: JUDGE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: judgeMessage(input, context) }],
          // classificação curta: sem raciocínio estendido (ele consumiria o max_tokens antes do JSON), esforço baixo e
          // resposta presa ao esquema do veredito
          thinking: { type: 'disabled' },
          output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA as unknown as Record<string, unknown> } },
        },
        { timeout: this.timeoutMs(), maxRetries: 0 },
      );
      const latencyMs = Date.now() - started;
      if (response.stop_reason === 'refusal') {
        // o próprio Claude recusou ler o pedido: não é veredito, mas é sinal; fica no log para o revisor
        this.logger.warn(`[PROMPT_JUDGE] recusa do modelo ao ler o pedido (${model}, ${latencyMs} ms)`);
        return { verdict: null, source: 'unavailable', latencyMs, model };
      }
      const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      const parsed = parseVerdict(text);
      if (!parsed) {
        this.logger.warn(`[PROMPT_JUDGE] resposta fora do contrato (${model}, stop=${response.stop_reason}, ${latencyMs} ms)`);
        return { verdict: null, source: 'unavailable', latencyMs, model };
      }
      const verdict = groundVerdict(parsed, input);
      this.remember(key, verdict);
      return { verdict, source: 'model', latencyMs, model };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const reason = error instanceof Anthropic.APIError ? `${error.status ?? 'rede'} ${error.name}` : error instanceof Error ? error.message : String(error);
      this.logger.warn(`[PROMPT_JUDGE] indisponível (${model}, ${latencyMs} ms): ${reason.slice(0, 160)}`);
      return { verdict: null, source: 'unavailable', latencyMs, model };
    }
  }

  private remember(key: string, verdict: JudgeVerdict): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { verdict, at: Date.now() });
  }
}
