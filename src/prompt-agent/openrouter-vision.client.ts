import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cliente de visão do OpenRouter usado como plano B do Clone de Prompt:
 * quando o Gemini recusa a imagem (conteúdo 18+), tenta os modelos daqui em
 * ordem. Grok 4.3 descreve nudez adulta sem recusar (teste 20/10/2026);
 * Qwen3-VL fica de reserva.
 */
@Injectable()
export class OpenRouterVisionClient {
  private readonly logger = new Logger(OpenRouterVisionClient.name);
  private readonly apiKey: string;
  private readonly models: string[];

  constructor(configService: ConfigService) {
    this.apiKey = configService.get<string>('OPENROUTER_API_KEY', '');
    this.models = configService
      .get<string>('OPENROUTER_PROMPT_MODELS', 'x-ai/grok-4.3,qwen/qwen3-vl-235b-a22b-instruct')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }

  get enabled(): boolean {
    return !!this.apiKey && this.models.length > 0;
  }

  /** Devolve o texto do primeiro modelo que responder; lança se todos falharem. */
  async describe(params: {
    system: string;
    image: { base64: string; mime_type: string };
    text: string;
  }): Promise<string> {
    let lastError: unknown;
    for (const model of this.models) {
      try {
        const text = await this.call(model, params);
        if (text.trim()) return text;
        lastError = new Error(`${model} devolveu resposta vazia`);
      } catch (err) {
        lastError = err;
        this.logger.warn(`OpenRouter ${model} falhou: ${(err as Error).message}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('OpenRouter sem resposta');
  }

  private async call(
    model: string,
    { system, image, text }: { system: string; image: { base64: string; mime_type: string }; text: string },
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'The AI Model Lab',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 4096,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:${image.mime_type};base64,${image.base64}` } },
                { type: 'text', text },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error?.message || `HTTP ${res.status}`);
      }
      return data?.choices?.[0]?.message?.content || '';
    } finally {
      clearTimeout(timeout);
    }
  }
}
