/* eslint-disable @typescript-eslint/require-await -- clientes simulados são async por contrato; matchers do jest devolvem any */
import { Logger } from '@nestjs/common';
import {
  RULES_VERSION,
  SAFETY_TIMING,
} from '../../image-safety/image-safety.config';
import {
  createTextCacheStore,
  TextVerdictCache,
  type TextCacheStore,
} from '../text-classifier.cache';
import { safeguardResult } from './helpers';

function memoryStore(): TextCacheStore & {
  data: Map<string, string>;
  ttl: Map<string, number>;
} {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    data,
    ttl,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value, ttlMs) => {
      data.set(key, value);
      ttl.set(key, ttlMs);
      return 'OK';
    },
  };
}

describe('TextVerdictCache', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const SHA = 'a'.repeat(64);
  const entry = { safeguard: safeguardResult(), shadow: [] };

  it('chave com a versão das regras e da política; validade de 30 dias', async () => {
    const store = memoryStore();
    const cache = new TextVerdictCache(store);
    await cache.set('teste-1', SHA, entry);
    const key = `safety:text:${RULES_VERSION}:teste-1:${SHA}`;
    expect(store.data.has(key)).toBe(true);
    expect(store.ttl.get(key)).toBe(SAFETY_TIMING.verdictCacheTtlMs);
    await expect(cache.get('teste-1', SHA)).resolves.toEqual(entry);
    await expect(cache.get('teste-2', SHA)).resolves.toBeNull();
  });

  it('valor estranho ou de outra versão da política = miss', async () => {
    const store = memoryStore();
    const cache = new TextVerdictCache(store);
    const key = cache.key('teste-1', SHA);
    for (const raw of [
      'não é json',
      JSON.stringify({ safeguard: { classifier: 'x' }, shadow: [] }),
      JSON.stringify({
        safeguard: safeguardResult({ policyVersion: 'outra' }),
        shadow: [],
      }),
      JSON.stringify({ safeguard: safeguardResult(), shadow: 'x' }),
    ]) {
      store.data.set(key, raw);
      await expect(cache.get('teste-1', SHA)).resolves.toBeNull();
    }
  });

  it('Redis fora ou lento = miss, nunca falha (e avisa uma vez só)', async () => {
    const broken: TextCacheStore = {
      get: () => Promise.reject(new Error('fora')),
      set: () => Promise.reject(new Error('fora')),
    };
    const cache = new TextVerdictCache(broken);
    await expect(cache.get('teste-1', SHA)).resolves.toBeNull();
    await expect(cache.set('teste-1', SHA, entry)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);

    const slow = new TextVerdictCache(
      {
        get: () => new Promise(() => undefined),
        set: () => new Promise(() => undefined),
      },
      20,
    );
    await expect(slow.get('teste-1', SHA)).resolves.toBeNull();
  });

  it('sem Redis: desligado', async () => {
    const cache = new TextVerdictCache(null);
    expect(cache.enabled).toBe(false);
    await expect(cache.get('teste-1', SHA)).resolves.toBeNull();
  });

  it('createTextCacheStore: off ou sem REDIS_URL não cria conexão', () => {
    const env = jest.fn(() => 'redis://localhost:6379');
    expect(createTextCacheStore('off', env)).toBeNull();
    expect(env).not.toHaveBeenCalled();
    expect(createTextCacheStore('shadow', () => undefined)).toBeNull();
  });
});
