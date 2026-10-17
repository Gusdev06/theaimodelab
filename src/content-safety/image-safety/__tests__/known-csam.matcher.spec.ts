import { Logger } from '@nestjs/common';
import {
  createKnownHashMatcher,
  KnownHashLookup,
  KnownHashTransport,
  NoopKnownHashMatcher,
  TransportKnownHashMatcher,
} from '../known-csam.matcher';
import { NormalizedImage, SafetyProviderUnavailableError } from '../types';

/**
 * Hash de abuso conhecido: desligado por padrão e sem nenhuma chamada de rede. O adaptador genérico é testado com um
 * transporte falso (bytes inventados, nenhum fornecedor real).
 */

const IMAGE: NormalizedImage = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  width: 100,
  height: 100,
  sha256: '0'.repeat(64),
  sourceMimeType: 'image/jpeg',
};

function transport(
  lookup: (jpeg: Buffer, signal: AbortSignal) => Promise<KnownHashLookup>,
): KnownHashTransport & { lookup: jest.Mock } {
  return { name: 'fornecedor-falso', lookup: jest.fn(lookup) };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('known-csam.matcher', () => {
  const spyOnWarn = () =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  let fetchSpy: jest.SpyInstance;
  let warnSpy: ReturnType<typeof spyOnWarn>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    warnSpy = spyOnWarn();
  });

  afterEach(() => jest.restoreAllMocks());

  it('sem chave: Noop desligado, nunca acusa e nunca chama a rede', async () => {
    const matcher = createKnownHashMatcher({ arachnidApiKey: null });
    expect(matcher).toBeInstanceOf(NoopKnownHashMatcher);
    expect(matcher.enabled).toBe(false);
    expect(matcher.name).toBe('none');
    expect(await matcher.match(IMAGE)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('com chave mas sem adaptador conferido: segue desligado e avisa (sem a chave no aviso)', async () => {
    const matcher = createKnownHashMatcher({
      arachnidApiKey: 'chave-falsa-de-teste',
    });
    expect(matcher.enabled).toBe(false);
    expect(await matcher.match(IMAGE)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining('chave-falsa-de-teste'),
    );
  });

  it('transporte conferido: acerto é sempre forte, fonte known-csam', async () => {
    const fake = transport(() =>
      Promise.resolve({ matched: true, distance: 2 }),
    );
    const matcher = createKnownHashMatcher({ arachnidApiKey: null }, fake);
    expect(matcher).toBeInstanceOf(TransportKnownHashMatcher);
    expect(matcher.enabled).toBe(true);
    expect(matcher.name).toBe('fornecedor-falso');
    expect(await matcher.match(IMAGE)).toEqual({
      source: 'known-csam',
      matcher: 'fornecedor-falso',
      distance: 2,
      blockId: null,
      strength: 'STRONG',
    });
    expect(fake.lookup).toHaveBeenCalledWith(IMAGE.jpeg, expect.any(Object));
  });

  it('sem acerto: null; distância que o fornecedor não informa vira null', async () => {
    expect(
      await new TransportKnownHashMatcher(
        transport(() => Promise.resolve({ matched: false, distance: null })),
      ).match(IMAGE),
    ).toBeNull();
    expect(
      await new TransportKnownHashMatcher(
        transport(() =>
          Promise.resolve({ matched: true, distance: Number.NaN }),
        ),
      ).match(IMAGE),
    ).toMatchObject({ distance: null, strength: 'STRONG' });
  });

  it('fornecedor fora, lento ou com resposta estranha: indisponível, nunca "não está na lista"', async () => {
    const down = await caught(
      new TransportKnownHashMatcher(
        transport(() => Promise.reject(new Error('503'))),
      ).match(IMAGE),
    );
    expect(down).toBeInstanceOf(SafetyProviderUnavailableError);
    expect(down).toMatchObject({
      provider: 'fornecedor-falso',
      failure: 'server_error',
    });

    const slow = await caught(
      new TransportKnownHashMatcher(
        transport(() => new Promise<never>(() => undefined)),
      ).match(IMAGE, { timeoutMs: 20 }),
    );
    expect(slow).toMatchObject({ failure: 'timeout' });

    const odd = await caught(
      new TransportKnownHashMatcher(
        transport(() =>
          Promise.resolve({ distance: 1 } as unknown as KnownHashLookup),
        ),
      ).match(IMAGE),
    );
    expect(odd).toMatchObject({ failure: 'invalid_response' });

    const empty = await caught(
      new TransportKnownHashMatcher(
        transport(() => Promise.resolve({ matched: false, distance: null })),
      ).match({ ...IMAGE, jpeg: Buffer.alloc(0) }),
    );
    expect(empty).toMatchObject({ failure: 'invalid_media' });
  });

  it('cancelamento de quem chamou chega ao transporte', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const fake = transport(
      (_jpeg, signal) =>
        new Promise((_, reject) => {
          received = signal;
          signal.addEventListener('abort', () =>
            reject(new Error('cancelado')),
          );
        }),
    );
    const pending = caught(
      new TransportKnownHashMatcher(fake).match(IMAGE, {
        signal: controller.signal,
      }),
    );
    controller.abort();
    expect(await pending).toMatchObject({ failure: 'timeout' });
    expect(received?.aborted).toBe(true);
  });
});
