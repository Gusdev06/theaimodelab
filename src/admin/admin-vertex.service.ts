import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─── Tipos ───────────────────────────────────────────────────

export interface VertexCredential {
  id: string;
  name: string;
  quotaProjectId: string;
  active: boolean;
  createdAt: string;
}

export interface CreateVertexCredentialInput {
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  quotaProjectId: string;
}

/**
 * Proxy para as rotas de credentials do AI Model Lab Provider (gestão de contas Vertex).
 * A THEAIMODELAB_API_KEY nunca sai do servidor — o frontend só fala com este controller.
 */
@Injectable()
export class AdminVertexService {
  private readonly logger = new Logger(AdminVertexService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>(
      'THEAIMODELAB_PROVIDER_URL',
      'http://localhost:3001',
    );
    this.apiKey = this.configService.get<string>('THEAIMODELAB_API_KEY', '');
  }

  async listCredentials(): Promise<VertexCredential[]> {
    return this.request<VertexCredential[]>('GET', '/api/credentials');
  }

  async createCredential(
    input: CreateVertexCredentialInput,
  ): Promise<VertexCredential> {
    return this.request<VertexCredential>('POST', '/api/credentials', input);
  }

  async deleteCredential(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api/credentials/${id}`);
  }

  // ─── Helper de proxy ───────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    this.logger.log(`[VERTEX] ${method} ${url}`);

    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        url,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        30_000,
      );
    } catch (error) {
      this.logger.error(
        `[VERTEX] Fetch failed to ${url}: ${(error as Error).message}`,
      );
      throw new BadGatewayException(
        'Falha ao comunicar com o AI Model Lab Provider.',
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      this.logger.error(`[VERTEX] ${method} ${url} → ${response.status}: ${errorText}`);
      throw new HttpException(
        this.extractMessage(errorText) ?? 'Erro no AI Model Lab Provider.',
        response.status,
      );
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private extractMessage(raw: string): string | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { message?: string; error?: string };
      return parsed.message ?? parsed.error ?? null;
    } catch {
      return raw.slice(0, 300);
    }
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}
