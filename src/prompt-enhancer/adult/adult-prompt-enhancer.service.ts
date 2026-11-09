import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assessText } from '../../content-safety/minor-guard';
import {
  ADULT_ENHANCER_SYSTEM_PROMPT,
  ADULT_ENHANCER_VERSION,
  adultEnhancerMessage,
  composeEnhanced,
  deterministicEnhancement,
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
  /** model = reescrito pelo modelo do OpenRouter; fallback = bloco fixo do estudo (indisponível, recusou ou saiu do contrato) */
  source: 'model' | 'fallback';
}

/** Uma chamada de chat ao OpenRouter: devolve o texto da resposta (os testes passam um falso por este token). */
export interface EnhancerClient {
  complete(params: { model: string; system: string; user: string; maxTokens: number; timeoutMs: number }): Promise<string>;
}

export const ADULT_ENHANCER_CLIENT = Symbol('ADULT_ENHANCER_CLIENT');

/**
 * Por que OpenRouter e não Claude: a política de uso da Anthropic proíbe usar o Claude para gerar conteúdo sexualmente
 * explícito ("Do Not Generate Sexually Explicit Content", sem exceção), e este melhorador reescreve pedidos explícitos
 * sem suavizar. O Claude segue na plataforma só lendo e classificando (juiz de prompt, pré-voo do site). Grok 4.3 é o
 * mesmo modelo que o Clone de Prompt 18+ já usa pelo OpenRouter (descreve nudez adulta sem recusar, teste de 20/10);
 * a lista troca sem deploy (OPENROUTER_ENHANCER_MODELS, em ordem; o primeiro que responder no contrato vale).
 */
export const ADULT_ENHANCER_DEFAULT_MODELS = 'x-ai/grok-4.3';
const DEFAULT_TIMEOUT_MS = 60_000;
/** um prompt de 320 palavras + lista "evitar" + nota cabe com folga */
const MAX_TOKENS = 2400;

/** Cliente de texto do OpenRouter (mesmo endpoint e cabeçalhos do cliente de visão do Clone de Prompt). */
export class OpenRouterTextClient implements EnhancerClient {
  constructor(private readonly apiKey: string) {}

  async complete({ model, system, user, maxTokens, timeoutMs }: { model: string; system: string; user: string; maxTokens: number; timeoutMs: number }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'The AI Model Lab' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string }; choices?: { message?: { content?: string | null } }[] };
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      return data?.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  }
}

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

  /** Sem chave do OpenRouter o melhorador sem filtro não existe: o site mantém o botão escondido pelo flag dele. */
  enabled(): boolean {
    return Boolean(this.apiKey()) && this.models().length > 0;
  }

  models(): string[] {
    const raw = this.config.get<string>('OPENROUTER_ENHANCER_MODELS') ?? ADULT_ENHANCER_DEFAULT_MODELS;
    const list = raw.split(',').map((model) => model.trim()).filter(Boolean);
    return list.length ? list : [ADULT_ENHANCER_DEFAULT_MODELS];
  }

  private apiKey(): string | null {
    const key = this.config.get<string>('OPENROUTER_API_KEY')?.trim();
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
    this.client = new OpenRouterTextClient(apiKey);
    return this.client;
  }

  /** Nunca lança por falha do modelo: o pior caso é o bloco fixo. Lança só se o próprio pedido for inválido (vazio). */
  async enhance(prompt: string, context: AdultEnhancerContext): Promise<AdultEnhanceResult> {
    const original = prompt.trim();
    if (!original) throw new Error('prompt vazio');
    const started = Date.now();

    const fromModel = await this.askModels(original, context);
    const enhancement = fromModel?.enhancement ?? deterministicEnhancement(original, context);
    const source: AdultEnhanceResult['source'] = fromModel ? 'model' : 'fallback';
    const model = fromModel?.model ?? 'bloco fixo';

    // o texto que volta para a cliente vai virar o prompt da geração: tem que passar na mesma trava que o pedido passou
    const composed = composeEnhanced(enhancement);
    if (assessText(composed).blocked) {
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

  /** Tenta os modelos em ordem; o primeiro que responde no contrato vale. Nenhum = null (bloco fixo). */
  private async askModels(prompt: string, context: AdultEnhancerContext): Promise<{ enhancement: AdultEnhancement; model: string } | null> {
    // sem chave não há modelo, mesmo com cliente injetado (testes): só o bloco fixo
    const client = this.enabled() ? this.clientOrNull() : null;
    if (!client) return null;
    for (const model of this.models()) {
      try {
        const text = await client.complete({
          model,
          system: ADULT_ENHANCER_SYSTEM_PROMPT,
          user: adultEnhancerMessage(prompt, context),
          maxTokens: MAX_TOKENS,
          timeoutMs: this.timeoutMs(),
        });
        const parsed = parseEnhancement(text);
        if (!parsed) {
          this.logger.warn(`[ADULT_ENHANCER] resposta fora do contrato (${model})`);
          continue;
        }
        // o modelo devolveu o pedido intacto (regra da política para pedido sobre menor): não há o que melhorar
        if (parsed.prompt.trim() === prompt.trim() && !parsed.avoid) return null;
        return { enhancement: parsed, model };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[ADULT_ENHANCER] indisponível (${model}): ${reason.slice(0, 160)}`);
      }
    }
    return null;
  }
}
