import Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assessText } from '../../content-safety/minor-guard';
import {
  ADULT_ENHANCER_SYSTEM_PROMPT,
  ADULT_ENHANCER_VERSION,
  adultEnhancerMessage,
  composeEnhanced,
  deterministicEnhancement,
  ENHANCEMENT_SCHEMA,
  parseEnhancement,
  type AdultEnhancement,
  type AdultEnhancerContext,
} from './adult-enhancer.policy';

export interface AdultEnhanceResult {
  enhancedPrompt: string;
  /** os modelos sem filtro não têm campo negativo: a lista "evitar" já vai dentro do prompt; aqui fica vazio */
  negativePrompt: string;
  /** 1 frase no idioma da cliente dizendo o que foi acrescentado (o site mostra no toast); vazia no fallback */
  note: string;
  /** model = reescrito pelo Claude; fallback = bloco fixo do estudo (modelo indisponível, recusou ou saiu do contrato) */
  source: 'model' | 'fallback';
}

/** Só o que o melhorador usa do cliente da Anthropic (os testes passam um falso por este token). */
export interface EnhancerClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): Promise<Anthropic.Message>;
  };
}

export const ADULT_ENHANCER_CLIENT = Symbol('ADULT_ENHANCER_CLIENT');

/**
 * Regra do dono: produto chama o modelo mais avançado. Teste de 02/11 em 20 prompts reais do Unlocked (10 explícitos):
 * Fable 5.1 reescreveu 19/20 (1 cortado pelo max_tokens antigo), p50 12 s, US$ 0,048 por pedido; Opus 5.5 20/20,
 * p50 9 s, US$ 0,017. Nenhuma recusa nos dois. PROMPT_ENHANCER_MODEL troca sem deploy.
 */
export const ADULT_ENHANCER_DEFAULT_MODEL = 'claude-fable-5-1';
const DEFAULT_TIMEOUT_MS = 60_000;
/** o raciocínio do Fable/Opus conta no teto; 1.200 cortou um prompt de 300 palavras no teste */
const MAX_TOKENS = 2400;

/**
 * "Melhorar prompt com IA" dos modelos sem filtro. O melhorador de sempre (Gemini) recusa cena sensível e devolve
 * outra cena sem avisar; este mantém tudo o que a cliente pediu e escreve do jeito que as clientes que mais geram
 * escrevem (identidade travada, idade adulta explícita, uma cena, realismo, câmera, lista "evitar"). Falhou, recusou
 * ou saiu do contrato: a cliente ainda recebe o bloco fixo do estudo (deterministicEnhancement). O texto final passa
 * pela trava de termos antes de voltar: o modelo nunca pode devolver o que a trava barraria.
 */
@Injectable()
export class AdultPromptEnhancerService {
  private readonly logger = new Logger(AdultPromptEnhancerService.name);
  private client: EnhancerClient | null = null;

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(ADULT_ENHANCER_CLIENT) injectedClient?: EnhancerClient,
  ) {
    this.client = injectedClient ?? null;
  }

  /** Sem chave da Anthropic o melhorador sem filtro não existe: o site mantém o botão escondido pelo flag dele. */
  enabled(): boolean {
    return Boolean(this.apiKey());
  }

  model(): string {
    return (this.config.get<string>('PROMPT_ENHANCER_MODEL') ?? ADULT_ENHANCER_DEFAULT_MODEL).trim() || ADULT_ENHANCER_DEFAULT_MODEL;
  }

  private apiKey(): string | null {
    const key = this.config.get<string>('ANTHROPIC_API_KEY')?.trim();
    return key ? key : null;
  }

  private timeoutMs(): number {
    const raw = Number(this.config.get<string>('PROMPT_ENHANCER_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw >= 5000 ? raw : DEFAULT_TIMEOUT_MS;
  }

  private clientOrNull(): EnhancerClient | null {
    if (this.client) return this.client;
    const apiKey = this.apiKey();
    if (!apiKey) return null;
    this.client = new Anthropic({ apiKey, maxRetries: 1 });
    return this.client;
  }

  /** Nunca lança por falha do modelo: o pior caso é o bloco fixo. Lança só se o próprio pedido for inválido (vazio). */
  async enhance(prompt: string, context: AdultEnhancerContext): Promise<AdultEnhanceResult> {
    const original = prompt.trim();
    if (!original) throw new Error('prompt vazio');
    const model = this.model();
    const started = Date.now();

    const fromModel = await this.askModel(original, context, model);
    const enhancement = fromModel ?? deterministicEnhancement(original, context);
    const source: AdultEnhanceResult['source'] = fromModel ? 'model' : 'fallback';

    // o texto que volta para a cliente vai virar o prompt da geração: tem que passar na mesma trava que o pedido passou
    const composed = composeEnhanced(enhancement);
    if (assessText(composed, { source: 'description' }).blocked) {
      this.logger.warn(`[ADULT_ENHANCER] texto do modelo barrado pela trava (${model}, ${ADULT_ENHANCER_VERSION}); usando o bloco fixo`);
      const fallback = composeEnhanced(deterministicEnhancement(original, context));
      return {
        enhancedPrompt: assessText(fallback).blocked ? original : fallback,
        negativePrompt: '',
        note: '',
        source: 'fallback',
      };
    }

    this.logger.log(`[ADULT_ENHANCER] ${source} (${model}, ${Date.now() - started} ms, ${original.length} → ${composed.length} caracteres)`);
    return { enhancedPrompt: composed, negativePrompt: '', note: enhancement.note, source };
  }

  private async askModel(prompt: string, context: AdultEnhancerContext, model: string): Promise<AdultEnhancement | null> {
    // sem chave não há modelo, mesmo com cliente injetado (testes): só o bloco fixo
    const client = this.enabled() ? this.clientOrNull() : null;
    if (!client) return null;
    try {
      const response = await client.messages.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: ADULT_ENHANCER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: adultEnhancerMessage(prompt, context) }],
          // Fable/Opus: raciocínio sempre ligado (desligar dá 400); esforço baixo basta para reescrita; resposta presa ao esquema
          output_config: { effort: 'low', format: { type: 'json_schema', schema: ENHANCEMENT_SCHEMA as unknown as Record<string, unknown> } },
        },
        { timeout: this.timeoutMs(), maxRetries: 1 },
      );
      if (response.stop_reason === 'refusal') {
        this.logger.warn(`[ADULT_ENHANCER] recusa do modelo (${model})`);
        return null;
      }
      const text = response.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
      const parsed = parseEnhancement(text);
      if (!parsed) {
        this.logger.warn(`[ADULT_ENHANCER] resposta fora do contrato (${model}, stop=${response.stop_reason})`);
        return null;
      }
      // o modelo devolveu o pedido intacto (regra da política para pedido sobre menor): não há o que melhorar
      if (parsed.prompt.trim() === prompt.trim() && !parsed.avoid) return null;
      return parsed;
    } catch (error) {
      const reason = error instanceof Anthropic.APIError ? `${error.status ?? 'rede'} ${error.name}` : error instanceof Error ? error.message : String(error);
      this.logger.warn(`[ADULT_ENHANCER] indisponível (${model}): ${reason.slice(0, 160)}`);
      return null;
    }
  }
}
