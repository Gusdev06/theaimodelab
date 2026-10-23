import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Purga do CDN por URL (Cloudflare, `POST /zones/{zone}/purge_cache` com `files`), usada na remoção (camada 8): apagar
 * o arquivo do bucket não tira a cópia que o CDN já guardou (a mídia pública tem cache de até 1 dia). Só com
 * CLOUDFLARE_PURGE_TOKEN (token com a permissão "Cache Purge" da zona) e CLOUDFLARE_ZONE_ID; sem eles a purga fica
 * PENDENTE com o motivo, e a varredura da remoção tenta de novo quando as duas existirem. O token nunca vai para log
 * nem para mensagem de erro.
 */

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
/** URLs por chamada: o limite do plano gratuito (os planos pagos aceitam mais). */
export const PURGE_BATCH_SIZE = 30;
const PURGE_TIMEOUT_MS = 10_000;
const ZONE_ID_FORMAT = /^[0-9a-f]{32}$/i;
const ERROR_MAX_LENGTH = 300;

/** Troca do `fetch` nos testes (nenhuma chamada de rede de verdade). */
export const CDN_PURGE_FETCH = Symbol('CDN_PURGE_FETCH');
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** Resultado da purga de uma URL. */
export type PurgeOutcome =
  /** o CDN aceitou a purga */
  | { status: 'done' }
  /** a purga não foi tentada (sem token ou zona): fica para quando a configuração existir */
  | { status: 'pending'; reason: string }
  /** a purga foi tentada e o CDN recusou ou não respondeu (nova tentativa pela varredura) */
  | { status: 'failed'; reason: string };

interface CloudflareResponse {
  success?: unknown;
  errors?: Array<{ code?: unknown; message?: unknown }>;
}

function clip(text: string): string {
  return text.length > ERROR_MAX_LENGTH
    ? `${text.slice(0, ERROR_MAX_LENGTH - 1)}…`
    : text;
}

/** Só http(s): o resto (data:, URL assinada de outro serviço sem esquema) não é endereço do CDN. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

@Injectable()
export class CdnPurgeService {
  private readonly logger = new Logger(CdnPurgeService.name);
  private readonly token: string | null;
  private readonly zoneId: string | null;
  /** por que a purga não roda (null = configurada) */
  readonly unavailableReason: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(
    config: ConfigService,
    @Optional() @Inject(CDN_PURGE_FETCH) fetchImpl?: FetchLike | null,
  ) {
    this.token = config.get<string>('CLOUDFLARE_PURGE_TOKEN')?.trim() || null;
    const zone = config.get<string>('CLOUDFLARE_ZONE_ID')?.trim() || null;
    this.zoneId = zone && ZONE_ID_FORMAT.test(zone) ? zone : null;
    if (!this.token && !zone) {
      this.unavailableReason =
        'CLOUDFLARE_PURGE_TOKEN e CLOUDFLARE_ZONE_ID ausentes: purga do CDN pendente (o arquivo já saiu do bucket; a cópia em cache vence no max-age)';
    } else if (!this.token) {
      this.unavailableReason =
        'CLOUDFLARE_PURGE_TOKEN ausente: purga do CDN pendente';
    } else if (!zone) {
      this.unavailableReason =
        'CLOUDFLARE_ZONE_ID ausente: purga do CDN pendente';
    } else if (!this.zoneId) {
      this.unavailableReason =
        'CLOUDFLARE_ZONE_ID inválido (esperado o id de 32 caracteres da zona): purga do CDN pendente';
    } else {
      this.unavailableReason = null;
    }
    this.fetchImpl =
      fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  get configured(): boolean {
    return this.unavailableReason === null;
  }

  /**
   * Purga as URLs em lotes de 30. Devolve o resultado de cada URL (a mesma URL repetida vale uma vez). Nunca lança:
   * erro de rede ou resposta recusada vira `failed` com o motivo.
   */
  async purgeUrls(urls: string[]): Promise<Map<string, PurgeOutcome>> {
    const outcomes = new Map<string, PurgeOutcome>();
    const valid: string[] = [];
    for (const url of new Set(urls)) {
      if (isHttpUrl(url)) valid.push(url);
      else outcomes.set(url, { status: 'failed', reason: 'URL inválida' });
    }
    if (!valid.length) return outcomes;
    if (!this.configured) {
      const reason = this.unavailableReason as string;
      for (const url of valid) outcomes.set(url, { status: 'pending', reason });
      return outcomes;
    }
    for (let start = 0; start < valid.length; start += PURGE_BATCH_SIZE) {
      const batch = valid.slice(start, start + PURGE_BATCH_SIZE);
      const outcome = await this.purgeBatch(batch);
      for (const url of batch) outcomes.set(url, outcome);
    }
    return outcomes;
  }

  private async purgeBatch(files: string[]): Promise<PurgeOutcome> {
    const endpoint = `${CLOUDFLARE_API_BASE}/zones/${this.zoneId}/purge_cache`;
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
      });
      let payload: CloudflareResponse | null = null;
      try {
        payload = (await response.json()) as CloudflareResponse;
      } catch {
        payload = null;
      }
      if (response.ok && payload?.success === true) return { status: 'done' };
      const first = payload?.errors?.[0];
      const detail =
        first && (first.code !== undefined || first.message !== undefined)
          ? `${String(first.code ?? '')} ${String(first.message ?? '')}`.trim()
          : 'sem detalhe';
      const reason = clip(`Cloudflare HTTP ${response.status}: ${detail}`);
      this.logger.warn(
        `Purga do CDN recusada (${files.length} URL): ${reason}`,
      );
      return { status: 'failed', reason };
    } catch (error) {
      const name = (error as { name?: string }).name;
      const reason =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'Cloudflare não respondeu a tempo'
          : clip(
              `falha de rede: ${error instanceof Error ? error.message : String(error)}`,
            );
      this.logger.warn(`Purga do CDN falhou (${files.length} URL): ${reason}`);
      return { status: 'failed', reason };
    }
  }
}
