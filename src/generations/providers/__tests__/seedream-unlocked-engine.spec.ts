import { ConfigService } from '@nestjs/config';
import {
  SeedreamProvider,
  isUnlockedEngineSwapContext,
} from '../seedream.provider';
import { UploadsService } from '../../../uploads/uploads.service';
import { ContentSafetyError } from '../../errors/content-safety.error';

type FetchCall = { url: string; init?: RequestInit };
type KieOutcome =
  'success' | 'fail-430' | 'fail-minor' | 'fail-500' | 'generating';

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

const LITE_ALL = {
  ...KIE_ENV,
  UNLOCKED_ENGINE: 'lite',
  UNLOCKED_ENGINE_CANARY_PCT: '100',
};

const BASE_INPUT = {
  prompt: 'adult woman, 30 years old',
  resolution: 'RES_2K',
  aspectRatio: '3:4',
  skipSafetyWrapper: true,
};

const eligible = (id: string, user: string) => ({
  ...BASE_INPUT,
  id,
  engineSwapEligible: true,
  canaryKey: user,
});

describe('SeedreamProvider · motor do Unlocked (UNLOCKED_ENGINE)', () => {
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

  async function run<T>(promise: Promise<T>): Promise<T> {
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
    for (let i = 0; i < 200 && !outcome; i++)
      await jest.advanceTimersByTimeAsync(5_000);
    const settled = outcome as
      { ok: true; value: T } | { ok: false; error: unknown } | null;
    if (!settled) throw new Error('a geração não terminou no tempo simulado');
    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  const created = () =>
    calls
      .filter((call) => call.url.endsWith('/api/v1/jobs/createTask'))
      .map(
        (call) =>
          JSON.parse(call.init?.body as string) as {
            model: string;
            input: Record<string, unknown>;
          },
      );
  const createdModels = () => created().map((body) => body.model);

  /** KIE fake: cada tarefa criada responde com o estado que `outcomeFor(model)` mandar. */
  function mockKie(outcomeFor: (model: string) => KieOutcome) {
    const taskModel = new Map<string, string>();
    let next = 0;
    mockFetch((url, init) => {
      if (url.endsWith('/api/v1/jobs/createTask')) {
        const body = JSON.parse(init?.body as string) as { model: string };
        const taskId = `task-${++next}`;
        taskModel.set(taskId, body.model);
        return jsonResponse({ code: 200, msg: 'ok', data: { taskId } });
      }
      if (url.includes('/api/v1/jobs/recordInfo?taskId=')) {
        const taskId = url.split('taskId=')[1];
        const model = taskModel.get(taskId) ?? '';
        const outcome = outcomeFor(model);
        if (outcome === 'generating')
          return jsonResponse({
            code: 200,
            msg: 'ok',
            data: { taskId, model, state: 'generating' },
          });
        if (outcome === 'success')
          return jsonResponse({
            code: 200,
            msg: 'ok',
            data: {
              taskId,
              model,
              state: 'success',
              resultJson: JSON.stringify({
                resultUrls: [`https://kie.test/${taskId}.jpg`],
              }),
            },
          });
        const failMsg =
          outcome === 'fail-minor'
            ? 'The content may involve a minor (child safety)'
            : outcome === 'fail-430'
              ? 'content policy violation'
              : 'internal error';
        const failCode = outcome === 'fail-500' ? '500' : '430';
        return jsonResponse({
          code: 200,
          msg: 'ok',
          data: { taskId, model, state: 'fail', failCode, failMsg },
        });
      }
      if (url.startsWith('https://kie.test/task-')) return imageResponse();
      throw new Error(`url inesperada ${url}`);
    });
  }

  it('sem a env, nada muda: Pro com o mesmo payload de antes', async () => {
    mockKie(() => 'success');
    const provider = buildProvider(KIE_ENV);

    const result = await run(provider.generateImage(eligible('g1', 'u1')));

    expect(result.engine).toBe('pro');
    expect(created()).toEqual([
      {
        model: 'seedream/5-pro-text-to-image',
        input: expect.objectContaining({
          aspect_ratio: '3:4',
          quality: 'high',
          output_format: 'jpeg',
          nsfw_checker: false,
        }) as unknown,
      },
    ]);
  });

  it('só UNLOCKED_ENGINE=lite, sem o canário dito por extenso, não manda ninguém ao Lite', () => {
    const provider = buildProvider({ ...KIE_ENV, UNLOCKED_ENGINE: 'lite' });
    expect(provider.pickEngine(eligible('g', 'u'))).toBe('pro');
  });

  it('com o canário em 100%, o Unlocked vai ao Lite em 2K (basic) e em JPEG', async () => {
    mockKie(() => 'success');
    const provider = buildProvider(LITE_ALL);

    const result = await run(
      provider.generateImage({
        ...eligible('g2', 'u2'),
        imageUrls: ['https://cdn.test/in.jpg'],
      }),
    );

    expect(result).toEqual({
      outputUrls: ['https://cdn.test/generations/g2/output_0.jpg'],
      modelUsed: 'sem-censura',
      engine: 'lite',
    });
    const [sent] = created();
    expect(sent.model).toBe('seedream/5-lite-image-to-image');
    expect(sent.input).toMatchObject({
      quality: 'basic',
      output_format: 'jpeg',
      nsfw_checker: false,
      image_urls: ['https://cdn.test/in.jpg'],
    });
  });

  it('chamada sem engineSwapEligible (troca de rosto, Undress) fica no Pro mesmo com a env', async () => {
    mockKie(() => 'success');
    const provider = buildProvider(LITE_ALL);

    const result = await run(
      provider.generateImage({
        ...BASE_INPUT,
        id: 'g3',
        modelUsedTag: 'deepdeep',
      }),
    );

    expect(result.engine).toBe('pro');
    expect(createdModels()).toEqual(['seedream/5-pro-text-to-image']);
  });

  it('recusa de conteúdo do Lite (430 comum) é terminal, como no Pro: o Pro não vira segunda opinião', async () => {
    mockKie((model) => (model.includes('5-lite') ? 'fail-430' : 'success'));
    const provider = buildProvider(LITE_ALL);

    await expect(
      run(provider.generateImage(eligible('g4', 'u4'))),
    ).rejects.toBeInstanceOf(ContentSafetyError);
    expect(createdModels()).toEqual(['seedream/5-lite-text-to-image']);
  });

  it('falha técnica no Lite refaz no Pro', async () => {
    mockKie((model) => (model.includes('5-lite') ? 'fail-500' : 'success'));
    const provider = buildProvider(LITE_ALL);

    const result = await run(provider.generateImage(eligible('g5', 'u5')));

    expect(result.engine).toBe('pro');
    expect(createdModels()).toEqual([
      'seedream/5-lite-text-to-image',
      'seedream/5-pro-text-to-image',
    ]);
  });

  it('recusa por MENOR no Lite é terminal: não refaz no Pro', async () => {
    mockKie(() => 'fail-minor');
    const provider = buildProvider(LITE_ALL);

    await expect(
      run(provider.generateImage(eligible('g6', 'u6'))),
    ).rejects.toBeInstanceOf(ContentSafetyError);
    expect(createdModels()).toEqual(['seedream/5-lite-text-to-image']);
  });

  it('início recusado no Lite com texto de menor (createTask) não refaz no Pro', async () => {
    mockFetch((url) => {
      if (url.endsWith('/api/v1/jobs/createTask'))
        return jsonResponse({
          code: 400,
          msg: 'request rejected: depicts a minor',
          data: null,
        });
      throw new Error(`url inesperada ${url}`);
    });
    const provider = buildProvider(LITE_ALL);

    await expect(
      run(provider.generateImage(eligible('g7', 'u7'))),
    ).rejects.toThrow();
    expect(createdModels()).toEqual(['seedream/5-lite-text-to-image']);
  });

  it('Lite que não termina em ~3 min cede ao Pro (espera curta, cabe no prazo do cron)', async () => {
    mockKie((model) => (model.includes('5-lite') ? 'generating' : 'success'));
    const provider = buildProvider(LITE_ALL);

    const result = await run(provider.generateImage(eligible('g8', 'u8')));

    expect(result.engine).toBe('pro');
    const litePolls = calls.filter((call) =>
      call.url.endsWith('taskId=task-1'),
    ).length;
    expect(litePolls).toBeLessThanOrEqual(45);
  });

  it('canário: 0% = ninguém no Lite; 100% = todos; o mesmo usuário cai sempre no mesmo motor', () => {
    const at = (pct: string) =>
      buildProvider({
        ...KIE_ENV,
        UNLOCKED_ENGINE: 'lite',
        UNLOCKED_ENGINE_CANARY_PCT: pct,
      });
    const none = at('0');
    const all = at('100');
    const ten = at('10');
    const users = Array.from({ length: 2000 }, (_, i) => `user-${i}`);

    expect(users.every((u) => none.pickEngine(eligible(u, u)) === 'pro')).toBe(
      true,
    );
    expect(users.every((u) => all.pickEngine(eligible(u, u)) === 'lite')).toBe(
      true,
    );
    const inLite = users.filter(
      (u) => ten.pickEngine(eligible(u, u)) === 'lite',
    ).length;
    expect(inLite).toBeGreaterThan(120);
    expect(inLite).toBeLessThan(280);
    // estável: outra geração da mesma pessoa cai no mesmo motor
    for (const u of users.slice(0, 50)) {
      expect(ten.pickEngine(eligible('outra-geracao', u))).toBe(
        ten.pickEngine(eligible(u, u)),
      );
    }
  });

  it.each(['', '   ', 'abc', '10%', '0.5', '-5', '0x10'])(
    'canário %p (vazio ou inválido) = ninguém no Lite',
    (pct) => {
      const provider = buildProvider({
        ...KIE_ENV,
        UNLOCKED_ENGINE: 'lite',
        UNLOCKED_ENGINE_CANARY_PCT: pct,
      });
      const users = Array.from({ length: 300 }, (_, i) => `u-${i}`);
      expect(
        users.every((u) => provider.pickEngine(eligible('g', u)) === 'pro'),
      ).toBe(true);
    },
  );

  it('canário acima de 100 vale 100; " LITE " com espaço e maiúscula liga', () => {
    const provider = buildProvider({
      ...KIE_ENV,
      UNLOCKED_ENGINE: ' LITE ',
      UNLOCKED_ENGINE_CANARY_PCT: '150',
    });
    expect(provider.pickEngine(eligible('g', 'u'))).toBe('lite');
  });

  it('UNLOCKED_ENGINE_SCOPE=i2i: edição com foto vai ao Lite, só texto fica no Pro', () => {
    const provider = buildProvider({
      ...LITE_ALL,
      UNLOCKED_ENGINE_SCOPE: 'i2i',
    });
    expect(provider.pickEngine(eligible('g', 'u'))).toBe('pro');
    expect(provider.pickEngine({ ...eligible('g', 'u'), imageUrls: [] })).toBe(
      'pro',
    );
    expect(
      provider.pickEngine({
        ...eligible('g', 'u'),
        imageUrls: ['https://cdn.test/in.jpg'],
      }),
    ).toBe('lite');
  });

  it('sem UNLOCKED_ENGINE_SCOPE (ou valor desconhecido) vale para tudo, como no PR #43', () => {
    for (const scope of [undefined, '', 'qualquer']) {
      const provider = buildProvider(
        scope === undefined
          ? LITE_ALL
          : { ...LITE_ALL, UNLOCKED_ENGINE_SCOPE: scope },
      );
      expect(provider.pickEngine(eligible('g', 'u'))).toBe('lite');
    }
  });

  describe('Seedream 5.5 no só-texto (UNLOCKED_ENGINE_T2I=s55)', () => {
    const S55 = {
      ...KIE_ENV,
      UNLOCKED_ENGINE: 'lite',
      UNLOCKED_ENGINE_SCOPE: 'i2i',
      UNLOCKED_ENGINE_T2I: 's55',
      UNLOCKED_ENGINE_CANARY_PCT: '100',
    };

    it('só texto vai ao 5.5 com size 2K (sem quality); edição com foto segue no Lite', async () => {
      mockKie(() => 'success');
      const provider = buildProvider(S55);

      const text = await run(provider.generateImage(eligible('t1', 'u1')));
      const edit = await run(
        provider.generateImage({
          ...eligible('t2', 'u1'),
          imageUrls: ['https://cdn.test/in.jpg'],
        }),
      );

      expect(text.engine).toBe('s55');
      expect(edit.engine).toBe('lite');
      const [sentText, sentEdit] = created();
      expect(sentText.model).toBe('seedream/5-5-text-to-image');
      expect(sentText.input).toMatchObject({
        size: '2K',
        output_format: 'jpeg',
        nsfw_checker: false,
      });
      expect(sentText.input).not.toHaveProperty('quality');
      expect(sentText.input).not.toHaveProperty('image_urls');
      expect(sentEdit.model).toBe('seedream/5-lite-image-to-image');
    });

    it('sem UNLOCKED_ENGINE_T2I o só texto segue no Pro (o que está no ar hoje)', () => {
      const provider = buildProvider({ ...S55, UNLOCKED_ENGINE_T2I: '' });
      expect(provider.pickEngine(eligible('g', 'u'))).toBe('pro');
    });

    it('o 5.5 respeita o canário e o engineSwapEligible', () => {
      const off = buildProvider({ ...S55, UNLOCKED_ENGINE_CANARY_PCT: '0' });
      expect(off.pickEngine(eligible('g', 'u'))).toBe('pro');
      const on = buildProvider(S55);
      expect(on.pickEngine({ ...BASE_INPUT, id: 'g' })).toBe('pro');
    });

    it('falha técnica no 5.5 refaz no Pro; recusa de conteúdo é terminal', async () => {
      mockKie((model) => (model.includes('5-5') ? 'fail-500' : 'success'));
      const tech = await run(
        buildProvider(S55).generateImage(eligible('t3', 'u3')),
      );
      expect(tech.engine).toBe('pro');
      expect(createdModels()).toEqual([
        'seedream/5-5-text-to-image',
        'seedream/5-pro-text-to-image',
      ]);

      fetchMock.mockRestore();
      calls = [];
      mockKie((model) => (model.includes('5-5') ? 'fail-430' : 'success'));
      await expect(
        run(buildProvider(S55).generateImage(eligible('t4', 'u4'))),
      ).rejects.toBeInstanceOf(ContentSafetyError);
      expect(createdModels()).toEqual(['seedream/5-5-text-to-image']);
    });
  });

  it('desvio de segurança: só o das imagens entra no canário', () => {
    expect(isUnlockedEngineSwapContext('processImage:nano-banana-2')).toBe(
      true,
    );
    expect(
      isUnlockedEngineSwapContext('processImageWithFallback:theaimodelab'),
    ).toBe(true);
    expect(isUnlockedEngineSwapContext('processNanoBanana')).toBe(true);
    expect(isUnlockedEngineSwapContext('processImage:seedream-5-lite')).toBe(
      false,
    );
    expect(isUnlockedEngineSwapContext('processFaceSwap')).toBe(false);
    expect(isUnlockedEngineSwapContext('processVirtualTryOn:nano-banana')).toBe(
      false,
    );
  });
});
