import type { FetchLike } from './fanvue.client';

/**
 * Texto da Mia pelo OpenRouter (Grok por padrão). Nunca Claude: a política de uso da Anthropic proíbe gerar texto
 * sexual explícito; o Claude segue na casa só lendo e classificando (feedback_claude_api_so_classifica_18).
 *
 * Toda chamada passa pelo teto da cliente: antes de chamar, o pior caso da chamada (entrada estimada + máximo de
 * saída) tem que caber no que sobra do mês; depois, soma o custo que o OpenRouter devolve (ou o estimado pelos tokens).
 * Sem teto, sem chave ou com falha: o serviço usa o texto pronto do kit, custo zero.
 */

export interface LlmPricing {
  priceInPerMTok: number;
  priceOutPerMTok: number;
}

export interface ChatterCompletion {
  text: string;
  costUsd: number;
  model: string;
}

export interface ChatterTextClient {
  complete(params: { model: string; system: string; user: string; maxTokens: number; timeoutMs: number }): Promise<{ text: string; costUsd: number | null; promptTokens: number; completionTokens: number }>;
}

/** ~4 caracteres por token (estimativa conservadora para inglês/português/espanhol). */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

/** Pior caso de uma chamada: toda a entrada estimada + o máximo de saída, aos preços do teto. */
export function worstCaseCallUsd(system: string, user: string, maxTokens: number, pricing: LlmPricing): number {
  const input = estimateTokens(system) + estimateTokens(user) + 16;
  return (input * pricing.priceInPerMTok + maxTokens * pricing.priceOutPerMTok) / 1_000_000;
}

export function costFromTokens(promptTokens: number, completionTokens: number, pricing: LlmPricing): number {
  return (Math.max(0, promptTokens) * pricing.priceInPerMTok + Math.max(0, completionTokens) * pricing.priceOutPerMTok) / 1_000_000;
}

/** Mês do teto em UTC (AAAA-MM): virou o mês, o gasto da cliente recomeça do zero. */
export function costMonthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Quanto já foi gasto no mês corrente (gasto guardado de outro mês conta como zero). */
export function spentThisMonth(storedMonth: string | null | undefined, storedUsd: number, now: Date): number {
  return storedMonth === costMonthOf(now) ? Math.max(0, storedUsd) : 0;
}

export function fitsCap(spentUsd: number, callWorstCaseUsd: number, capUsd: number): boolean {
  return spentUsd + callWorstCaseUsd <= capUsd;
}

export class OpenRouterChatterClient implements ChatterTextClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  async complete({ model, system, user, maxTokens, timeoutMs }: { model: string; system: string; user: string; maxTokens: number; timeoutMs: number }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'The AI Model Lab' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.9,
          // devolve o custo real da chamada em `usage.cost` (US$)
          usage: { include: true },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const cost = Number(data?.usage?.cost);
      return {
        text: data?.choices?.[0]?.message?.content ?? '',
        costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
        promptTokens: Number(data?.usage?.prompt_tokens) || 0,
        completionTokens: Number(data?.usage?.completion_tokens) || 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
