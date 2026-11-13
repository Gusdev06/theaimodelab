import { ConfigService } from '@nestjs/config';
import { SeedreamProvider } from '../seedream.provider';
import { UploadsService } from '../../../uploads/uploads.service';
import { ContentSafetyError } from '../../errors/content-safety.error';

type FetchCall = { url: string; init?: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function imageResponse(): Response {
  return new Response(Buffer.from([0xff, 0xd8, 0xff]), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
}

function buildProvider(env: Record<string, string>) {
  const config = {
    get: (key: string, fallback?: string) => env[key] ?? fallback,
  } as unknown as ConfigService;
  const uploads = {
    uploadBuffer: jest.fn((_buffer: Buffer, folder: string, name: string) =>
      Promise.resolve(`https://cdn.test/${folder}/${name}`),
    ),
  } as unknown as UploadsService;
  return new SeedreamProvider(config, uploads);
}

const KIE_ENV = {
  NANO_BANANA_API_KEY: 'kie-key',
  NANO_BANANA_BASE_URL: 'https://kie.test',
};
const WS_ENV = {
  WAVESPEED_API_KEY: 'ws-key',
  WAVESPEED_BASE_URL: 'https://ws.test',
};

describe('SeedreamProvider · plano B na WaveSpeed (TKT-216)', () => {
  let calls: FetchCall[];
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    calls = [];
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });

  afterEach(() => {
    fetchMock?.mockRestore();
    jest.useRealTimers();
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        calls.push({ url, init });
        return Promise.resolve(handler(url, init));
      });
  }

  function sentBody(call: FetchCall | undefined): Record<string, unknown> {
    return JSON.parse(call?.init?.body as string) as Record<string, unknown>;
  }

  async function run<T>(promise: Promise<T>): Promise<T> {
    // os retries e o polling usam setTimeout: avança o relógio até a promessa resolver. O handler é ligado na hora,
    // para a rejeição nunca ficar solta enquanto o relógio anda.
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null =
      null;
    promise.then(
      (value) => {
        outcome = { ok: true, value };
      },
      (error: unknown) => {
        outcome = { ok: false, error };
      },
    );
    for (let i = 0; i < 50 && !outcome; i++)
      await jest.advanceTimersByTimeAsync(5_000);
    const settled = outcome as
      { ok: true; value: T } | { ok: false; error: unknown } | null;
    if (!settled) throw new Error('a geração não terminou no tempo simulado');
    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  const kieOutOfBalance = (url: string) =>
    url.includes('kie.test/api/v1/jobs/createTask')
      ? jsonResponse({ code: 402, msg: 'Credits insufficient', data: null })
      : null;

  it('com a flag ligada, a falha de início na KIE roda a mesma geração na WaveSpeed', async () => {
    mockFetch((url) => {
      const kie = kieOutOfBalance(url);
      if (kie) return kie;
      if (url === 'https://ws.test/api/v3/bytedance/seedream-v5.0-pro')
        return jsonResponse({ data: { id: 'pred-1' } });
      if (url === 'https://ws.test/api/v3/predictions/pred-1/result')
        return jsonResponse({
          data: { status: 'completed', outputs: ['https://ws.test/out.jpg'] },
        });
      if (url === 'https://ws.test/out.jpg') return imageResponse();
      throw new Error(`url inesperada ${url}`);
    });
    const provider = buildProvider({
      ...KIE_ENV,
      ...WS_ENV,
      UNLOCKED_WAVESPEED_FALLBACK: 'true',
    });

    const result = await run(
      provider.generateImage({
        id: 'gen-1',
        prompt: 'adult woman, 28 years old',
        resolution: 'RES_2K',
        aspectRatio: '3:4',
        skipSafetyWrapper: true,
      }),
    );

    expect(result).toEqual({
      outputUrls: ['https://cdn.test/generations/gen-1/output_0.jpg'],
      modelUsed: 'sem-censura',
      engine: 'pro',
    });
    const wsCreate = calls.find(
      (call) =>
        call.url === 'https://ws.test/api/v3/bytedance/seedream-v5.0-pro',
    );
    const sent = sentBody(wsCreate);
    // a âncora de adulto (adult-anchor) vem colada no fim do prompt
    expect(sent).toMatchObject({
      prompt: expect.stringContaining('adult woman, 28 years old'),
      resolution: '2k',
      aspect_ratio: '3:4',
    });
    expect(
      (wsCreate?.init?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer ws-key');
  });

  it('com foto de entrada usa o endpoint de edição e manda as mesmas imagens', async () => {
    mockFetch((url) => {
      const kie = kieOutOfBalance(url);
      if (kie) return kie;
      if (url === 'https://ws.test/api/v3/bytedance/seedream-v5.0-pro/edit')
        return jsonResponse({ id: 'pred-2' });
      if (url === 'https://ws.test/api/v3/predictions/pred-2/result')
        return jsonResponse({
          data: { status: 'completed', outputs: ['https://ws.test/out2.jpg'] },
        });
      if (url === 'https://ws.test/out2.jpg') return imageResponse();
      throw new Error(`url inesperada ${url}`);
    });
    const provider = buildProvider({
      ...KIE_ENV,
      ...WS_ENV,
      UNLOCKED_WAVESPEED_FALLBACK: '1',
    });

    await run(
      provider.generateImage({
        id: 'gen-2',
        prompt: 'p',
        resolution: 'RES_1K',
        aspectRatio: '1:1',
        imageUrls: ['https://cdn.test/in.jpg'],
        skipSafetyWrapper: true,
      }),
    );

    const wsCreate = calls.find((call) =>
      call.url.endsWith('/seedream-v5.0-pro/edit'),
    );
    expect(sentBody(wsCreate)).toMatchObject({
      images: ['https://cdn.test/in.jpg'],
      resolution: '1k',
    });
  });

  it('sem a flag, nada muda: o erro de início da KIE sobe e a WaveSpeed não é chamada', async () => {
    mockFetch((url) => kieOutOfBalance(url) ?? jsonResponse({}, 500));
    const provider = buildProvider({ ...KIE_ENV, ...WS_ENV });

    await expect(
      run(
        provider.generateImage({
          id: 'gen-3',
          prompt: 'p',
          resolution: 'RES_2K',
          aspectRatio: '1:1',
          skipSafetyWrapper: true,
        }),
      ),
    ).rejects.toThrow('Não foi possível iniciar a geração');
    expect(calls.some((call) => call.url.startsWith('https://ws.test'))).toBe(
      false,
    );
  });

  it('o Undress (deepdeep) não usa o plano B', async () => {
    mockFetch((url) => kieOutOfBalance(url) ?? jsonResponse({}, 500));
    const provider = buildProvider({
      ...KIE_ENV,
      ...WS_ENV,
      UNLOCKED_WAVESPEED_FALLBACK: 'true',
    });

    await expect(
      run(
        provider.generateImage({
          id: 'gen-4',
          prompt: 'p',
          resolution: 'RES_2K',
          aspectRatio: '1:1',
          skipSafetyWrapper: true,
          modelUsedTag: 'deepdeep',
        }),
      ),
    ).rejects.toThrow('Não foi possível iniciar a geração');
    expect(calls.some((call) => call.url.startsWith('https://ws.test'))).toBe(
      false,
    );
  });

  it('recusa de conteúdo na KIE não vai ao plano B', async () => {
    mockFetch((url) =>
      url.includes('kie.test/api/v1/jobs/createTask')
        ? jsonResponse({
            code: 400,
            msg: 'content policy violation: nsfw content detected',
            data: null,
          })
        : jsonResponse({}, 500),
    );
    const provider = buildProvider({
      ...KIE_ENV,
      ...WS_ENV,
      UNLOCKED_WAVESPEED_FALLBACK: 'true',
    });

    const outcome = run(
      provider.generateImage({
        id: 'gen-5',
        prompt: 'p',
        resolution: 'RES_2K',
        aspectRatio: '1:1',
        skipSafetyWrapper: true,
      }),
    );
    await expect(outcome).rejects.toBeInstanceOf(ContentSafetyError);
    expect(calls.some((call) => call.url.startsWith('https://ws.test'))).toBe(
      false,
    );
  });

  it('se o plano B também falhar, o erro original da KIE é o que sobe', async () => {
    mockFetch(
      (url) => kieOutOfBalance(url) ?? jsonResponse({ message: 'down' }, 503),
    );
    const provider = buildProvider({
      ...KIE_ENV,
      ...WS_ENV,
      UNLOCKED_WAVESPEED_FALLBACK: 'true',
    });

    await expect(
      run(
        provider.generateImage({
          id: 'gen-6',
          prompt: 'p',
          resolution: 'RES_2K',
          aspectRatio: '1:1',
          skipSafetyWrapper: true,
        }),
      ),
    ).rejects.toThrow('Não foi possível iniciar a geração');
    expect(
      calls.filter((call) => call.url.startsWith('https://ws.test')).length,
    ).toBe(2);
  });
});
