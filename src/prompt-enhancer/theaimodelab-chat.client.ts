import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FunctionCall {
  name: string;
  args?: Record<string, any>;
}

export interface FunctionResponse {
  name: string;
  response: Record<string, any>;
}

export interface ChatPart {
  text?: string;
  inline_data?: { base64: string; mime_type: string };
  // Function calling passthrough (Gemini): functionCall vem do modelo,
  // functionResponse é o resultado que devolvemos.
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
}

export interface ChatMessage {
  role: 'user' | 'model';
  parts: ChatPart[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  system_instruction?: string;
  model?: string;
  temperature?: number;
  max_output_tokens?: number;
  thinking_level?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  google_search?: boolean;
  // Declarações de ferramentas (function calling). Repassadas cru ao provider.
  tools?: Record<string, any>[];
  tool_config?: Record<string, any>;
}

export interface ChatResponse {
  text: string;
  role: string;
  finishReason?: string;
  usage?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  // Partes cruas do turno do modelo (texto + functionCall), na ordem original.
  parts?: ChatPart[];
  // Atalho: apenas as chamadas de função deste turno.
  functionCalls?: FunctionCall[];
  groundingChunks?: any[];
}

@Injectable()
export class TheaimodelabChatClient {
  private readonly logger = new Logger(TheaimodelabChatClient.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;

  constructor(configService: ConfigService) {
    this.baseUrl = configService.get<string>('THEAIMODELAB_PROVIDER_URL', 'http://localhost:8012');
    this.apiKey = configService.get<string>('THEAIMODELAB_API_KEY', '');
    this.defaultModel = configService.get<string>('THEAIMODELAB_CHAT_MODEL', 'gemini-3.1-pro-preview');
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/chat`;
    const body = {
      ...req,
      model: req.model || this.defaultModel,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }

      if (!res.ok) {
        const msg = data?.message || data?.error?.message || data?.raw || `HTTP ${res.status}`;
        this.logger.error(`The AI Model Lab chat failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
        throw new InternalServerErrorException(
          typeof msg === 'string' ? msg : 'The AI Model Lab chat request failed',
        );
      }

      return data as ChatResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
