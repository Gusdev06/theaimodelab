import { Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { parseRedisConfig } from '../../common/redis-config';
import {
  RULES_VERSION,
  SAFETY_TIMING,
} from '../image-safety/image-safety.config';
import type { TextClassifierResult } from '../image-safety/types';

/**
 * Cache dos RESULTADOS dos classificadores por sha256 do texto canônico (nunca o veredito: ele depende de o pedido
 * ser sexual e de onde o texto veio). Chave `safety:text:<RULES_VERSION>:<versão da política>:<sha256>`, validade de
 * 30 dias. Redis fora, lento ou com valor estranho = cache miss; nunca falha a checagem.
 */

export interface CachedTextClassification {
  safeguard: TextClassifierResult;
  /** classificadores em sombra (omni) que responderam */
  shadow: TextClassifierResult[];
}

/** O mínimo de Redis que o cache usa (o adaptador do ioredis fica em createTextCacheStore). */
export interface TextCacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<unknown>;
  quit?(): Promise<unknown>;
}

/** Leitura do cache não pode atrasar a fila. */
const CACHE_TIMEOUT_MS = 250;
const BANDS = new Set(['none', 'medium', 'high']);

function isResult(value: unknown): value is TextClassifierResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.classifier === 'string' &&
    typeof result.violation === 'boolean' &&
    typeof result.band === 'string' &&
    BANDS.has(result.band) &&
    typeof result.explicitMinor === 'boolean' &&
    (result.sexual === null || typeof result.sexual === 'boolean') &&
    (result.policyRuleId === null || typeof result.policyRuleId === 'string') &&
    (result.score === null || typeof result.score === 'number')
  );
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('cache lento')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class TextVerdictCache implements OnApplicationShutdown {
  private readonly logger = new Logger('TextVerdictCache');
  private warned = false;

  constructor(
    private readonly store: TextCacheStore | null,
    private readonly timeoutMs = CACHE_TIMEOUT_MS,
  ) {}

  get enabled(): boolean {
    return this.store !== null;
  }

  key(policyVersion: string, sha256: string): string {
    return `safety:text:${RULES_VERSION}:${policyVersion}:${sha256}`;
  }

  async get(
    policyVersion: string,
    sha256: string,
  ): Promise<CachedTextClassification | null> {
    if (!this.store) return null;
    try {
      const raw = await within(
        this.store.get(this.key(policyVersion, sha256)),
        this.timeoutMs,
      );
      if (!raw) return null;
      const data = JSON.parse(raw) as Partial<CachedTextClassification>;
      if (
        !isResult(data?.safeguard) ||
        data.safeguard.policyVersion !== policyVersion ||
        !Array.isArray(data.shadow) ||
        !data.shadow.every(isResult)
      ) {
        return null;
      }
      return { safeguard: data.safeguard, shadow: data.shadow };
    } catch {
      this.warnOnce();
      return null;
    }
  }

  async set(
    policyVersion: string,
    sha256: string,
    value: CachedTextClassification,
  ): Promise<void> {
    if (!this.store) return;
    try {
      await within(
        this.store.set(
          this.key(policyVersion, sha256),
          JSON.stringify(value),
          SAFETY_TIMING.verdictCacheTtlMs,
        ),
        this.timeoutMs,
      );
    } catch {
      this.warnOnce();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.store?.quit?.().catch(() => undefined);
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(
      'cache do classificador de texto indisponível; seguindo sem cache',
    );
  }
}

/**
 * Redis do cache, no padrão do unlimited.module (parseRedisConfig). Só é criado com o classificador ligado; sem
 * REDIS_URL, sem cache. Fila offline desligada: Redis fora responde erro na hora (= cache miss), sem acumular.
 */
export function createTextCacheStore(
  textMode: string,
  env: (key: string) => string | undefined,
): TextCacheStore | null {
  if (textMode === 'off') return null;
  const url = env('REDIS_URL');
  if (!url) return null;
  let redis: Redis;
  try {
    const { host, port, password, username, db } = parseRedisConfig(
      url,
      env('REDIS_DB'),
    );
    redis = new Redis({
      host,
      port,
      password,
      username,
      db,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
  } catch {
    return null;
  }
  // sem ouvinte, o ioredis derruba o processo no erro de conexão
  redis.on('error', () => undefined);
  return {
    get: (key) => redis.get(key),
    set: (key, value, ttlMs) => redis.set(key, value, 'PX', ttlMs),
    quit: () => redis.quit(),
  };
}
