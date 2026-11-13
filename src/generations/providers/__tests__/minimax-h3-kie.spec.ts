import { ConfigService } from '@nestjs/config';
import { WavespeedVideoProvider } from '../wavespeed-video.provider';
import { UploadsService } from '../../../uploads/uploads.service';
import { adultSafePrompt } from '../../../content-safety/adult-anchor';
import { ProviderFailureError } from '../../errors/failure-reason';
import { ContentSafetyError } from '../../errors/content-safety.error';
import {
  parseMinimaxH3Engine,
  parseMinimaxH3FallbackMode,
  shouldDivertMinimaxH3,
} from '../kie-minimax-h3.client';

type FetchCall = { url: string; init?: RequestInit };

/** Como cada lado responde: na criação da tarefa ou no resultado. */
type WavespeedOutcome =
  | 'success'
  | 'start-500'
  | 'start-econnrefused'
  | 'start-no-id'
  | 'failed-moderation'
  | 'failed-minor'
  | 'failed-generic'
  | 'failed-empty'
  | 'processing';
type KieOutcome =
  | 'success'
  | 'start-402'
  | 'start-430-empty'
  | 'start-430-flagged'
  | 'start-timeout'
  | 'start-no-task'
  | 'fail-430'
  | 'fail-430-generic'
  | 'fail-500';

const WS_BASE = 'https://ws.test';
const KIE_BASE = 'https://kie.test';
const WS_I2V = `${WS_BASE}/api/v3/wavespeed-ai/minimax-h3/image-to-video`;
const WS_T2V = `${WS_BASE}/api/v3/wavespeed-ai/minimax-h3/text-to-video`;
const KIE_CREATE = `${KIE_BASE}/api/v1/jobs/createTask`;

const WS_ENV = { WAVESPEED_API_KEY: 'ws-key', WAVESPEED_BASE_URL: WS_BASE };
const KIE_ENV = {
  NANO_BANANA_API_KEY: 'kie-key',
  NANO_BANANA_BASE_URL: KIE_BASE,
};
const BOTH_KEYS = { ...WS_ENV, ...KIE_ENV };

/** As mensagens de vídeo do provider (FAILURE_MESSAGES['vídeo']). */
const VIDEO_MESSAGES = {
  unavailable:
    'Não foi possível gerar o vídeo agora. Tente novamente em alguns instantes.',
  unexpected:
    'O serviço de vídeo não respondeu como esperado. Tente novamente em alguns instantes.',
  missingOutput:
    'A geração foi concluída mas o vídeo não pôde ser recuperado. Tente novamente.',
  failed: 'A geração de vídeo falhou. Tente novamente.',
  tooSlow:
    'A geração de vídeo demorou mais que o esperado. Tente novamente em alguns instantes.',
};

const PROMPT = 'adult woman, 30 years old, slow dance in a hotel room';
const I2V_INPUT = {
  id: 'gen-i2v',
  prompt: PROMPT,
  imageUrl: 'https://cdn.test/first.jpg',
  lastImageUrl: 'https://cdn.test/last.jpg',
  durationSeconds: 6,
  resolution: '480p' as const,
};
const T2V_INPUT = {
  id: 'gen-t2v',
  prompt: PROMPT,
  durationSeconds: 20,
  resolution: '768p' as const,
  aspectRatio: '9:21' as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildProvider(env: Record<string, string>) {
  const config = {
    get: (key: string, fallback?: string) => env[key] ?? fallback,
  } as unknown as ConfigService;
  const uploads = {
    uploadBuffer: jest.fn((_buffer: Buffer, folder: string, name: string) =>
      Promise.resolve(`https://storage.test/${folder}/${name}`),
    ),
  } as unknown as UploadsService;
  return new WavespeedVideoProvider(config, uploads);
}

describe('WavespeedVideoProvider · MiniMax H3 na kie (primário e desvio)', () => {
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

  /** WaveSpeed e kie falsos, mais o download do vídeo pronto. */
  function mockProviders(outcomes: {
    wavespeed?: WavespeedOutcome;
    kie?: KieOutcome;
  }) {
    const wsOutcome = outcomes.wavespeed ?? 'success';
    const kieOutcome = outcomes.kie ?? 'success';
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        calls.push({ url, init });
        return Promise.resolve(route(url));
      });

    function route(url: string): Response {
      if (url === WS_I2V || url === WS_T2V) {
        if (wsOutcome === 'start-500')
          return new Response('Internal Server Error', { status: 500 });
        if (wsOutcome === 'start-econnrefused')
          throw Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect ECONNREFUSED'), {
              code: 'ECONNREFUSED',
            }),
          });
        if (wsOutcome === 'start-no-id')
          return jsonResponse({ code: 200, data: {} });
        return jsonResponse({ code: 200, data: { id: 'pred-1' } });
      }
      if (url.startsWith(`${WS_BASE}/api/v3/predictions/`)) {
        if (wsOutcome === 'success')
          return jsonResponse({
            code: 200,
            data: {
              id: 'pred-1',
              status: 'completed',
              outputs: ['https://out.test/ws.mp4'],
            },
          });
        if (wsOutcome === 'processing')
          return jsonResponse({
            code: 200,
            data: { id: 'pred-1', status: 'processing' },
          });
        const error =
          wsOutcome === 'failed-moderation'
            ? 'Content flagged by moderation: the request violates our content policy'
            : wsOutcome === 'failed-minor'
              ? 'Content moderation blocked: sexual/minors'
              : wsOutcome === 'failed-empty'
                ? null
                : 'Inference worker crashed';
        return jsonResponse({
          code: 200,
          data: { id: 'pred-1', status: 'failed', error },
        });
      }
      if (url === KIE_CREATE) {
        if (kieOutcome === 'start-402')
          return jsonResponse({
            code: 402,
            msg: 'Credits insufficient',
            data: null,
          });
        if (kieOutcome === 'start-430-empty')
          return jsonResponse({ code: 430, msg: '', data: null });
        if (kieOutcome === 'start-430-flagged')
          return jsonResponse({
            code: 430,
            msg: 'Your prompt was flagged',
            data: null,
          });
        if (kieOutcome === 'start-timeout')
          throw Object.assign(new Error('This operation was aborted'), {
            name: 'AbortError',
          });
        if (kieOutcome === 'start-no-task')
          return jsonResponse({ code: 200, msg: 'success', data: {} });
        return jsonResponse({
          code: 200,
          msg: 'success',
          data: { taskId: 'task-1' },
        });
      }
      if (url.startsWith(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=`)) {
        if (kieOutcome === 'fail-430' || kieOutcome === 'fail-430-generic')
          return jsonResponse({
            code: 200,
            msg: 'success',
            data: {
              taskId: 'task-1',
              state: 'fail',
              failCode: '430',
              failMsg:
                kieOutcome === 'fail-430'
                  ? 'Content rejected by moderation'
                  : 'Generation failed',
            },
          });
        if (kieOutcome === 'fail-500')
          return jsonResponse({
            code: 200,
            msg: 'success',
            data: {
              taskId: 'task-1',
              state: 'fail',
              failCode: '500',
              failMsg: 'internal error',
            },
          });
        return jsonResponse({
          code: 200,
          msg: 'success',
          data: {
            taskId: 'task-1',
            state: 'success',
            resultJson: JSON.stringify({
              resultUrls: ['https://out.test/kie.mp4'],
            }),
          },
        });
      }
      if (url.startsWith('https://out.test/'))
        return new Response(Buffer.from([0, 0, 0, 24]), { status: 200 });
      throw new Error(`fetch inesperado: ${url}`);
    }
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

  const kieCalls = () => calls.filter((call) => call.url.startsWith(KIE_BASE));
  const wavespeedCalls = () =>
    calls.filter((call) => call.url.startsWith(WS_BASE));
  const bodyOf = (url: string) => {
    const call = calls.find((item) => item.url === url);
    return call
      ? (JSON.parse(call.init?.body as string) as Record<string, unknown>)
      : undefined;
  };

  describe('envs vazias', () => {
    it('i2v: só WaveSpeed, com o payload e o modelUsed de hoje', async () => {
      mockProviders({});
      const result = await run(
        buildProvider(BOTH_KEYS).generateMinimaxH3ImageToVideo(I2V_INPUT),
      );

      expect(kieCalls()).toHaveLength(0);
      expect(bodyOf(WS_I2V)).toEqual({
        prompt: adultSafePrompt(PROMPT, 2500),
        image: I2V_INPUT.imageUrl,
        resolution: '480p',
        duration: 6,
        seed: -1,
        last_image: I2V_INPUT.lastImageUrl,
      });
      expect(result).toEqual({
        outputUrls: ['https://storage.test/generations/gen-i2v/output_0.mp4'],
        modelUsed: 'wavespeed-ai/minimax-h3/image-to-video',
      });
    });

    it('t2v: só WaveSpeed, com o payload de hoje', async () => {
      mockProviders({});
      const result = await run(
        buildProvider(BOTH_KEYS).generateMinimaxH3TextToVideo(T2V_INPUT),
      );

      expect(kieCalls()).toHaveLength(0);
      expect(bodyOf(WS_T2V)).toEqual({
        prompt: adultSafePrompt(PROMPT, 2500),
        resolution: '768p',
        duration: 15,
        seed: -1,
        aspect_ratio: '9:21',
      });
      expect(result.modelUsed).toBe('wavespeed-ai/minimax-h3/text-to-video');
    });

    it('início falho na WaveSpeed não desvia', async () => {
      mockProviders({ wavespeed: 'start-500' });
      await expect(
        run(buildProvider(BOTH_KEYS).generateMinimaxH3ImageToVideo(I2V_INPUT)),
      ).rejects.toBeInstanceOf(ProviderFailureError);
      expect(kieCalls()).toHaveLength(0);
    });

    it('valor desconhecido nas flags = padrão', () => {
      expect(parseMinimaxH3Engine('KIE ')).toBe('kie');
      expect(parseMinimaxH3Engine('fal')).toBe('wavespeed');
      expect(parseMinimaxH3Engine(undefined)).toBe('wavespeed');
      expect(parseMinimaxH3FallbackMode('Tecnico+Recusa')).toBe(
        'tecnico+recusa',
      );
      expect(parseMinimaxH3FallbackMode('sempre')).toBe('off');
      expect(parseMinimaxH3FallbackMode('')).toBe('off');
    });
  });

  describe("desvio 'tecnico'", () => {
    const env = { ...BOTH_KEYS, MINIMAX_H3_KIE_FALLBACK: 'tecnico' };

    it('i2v: início falho na WaveSpeed → kie com o payload certo, modelUsed de sempre', async () => {
      mockProviders({ wavespeed: 'start-500' });
      const result = await run(
        buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT),
      );

      expect(bodyOf(KIE_CREATE)).toEqual({
        model: 'minimax-h3/image-to-video',
        input: {
          prompt: adultSafePrompt(PROMPT, 2500),
          first_frame_url: I2V_INPUT.imageUrl,
          last_frame_url: I2V_INPUT.lastImageUrl,
          duration: 6,
          resolution: '768P',
        },
      });
      const createCall = calls.find((call) => call.url === KIE_CREATE);
      expect(
        (createCall?.init?.headers as Record<string, string>).Authorization,
      ).toBe('Bearer kie-key');
      expect(result).toEqual({
        outputUrls: ['https://storage.test/generations/gen-i2v/output_0.mp4'],
        modelUsed: 'wavespeed-ai/minimax-h3/image-to-video',
      });
      expect(
        calls.some((call) => call.url === 'https://out.test/kie.mp4'),
      ).toBe(true);
    });

    it('t2v: duração limitada a 15, aspect fora da lista vira 16:9', async () => {
      mockProviders({ wavespeed: 'start-500' });
      const result = await run(
        buildProvider(env).generateMinimaxH3TextToVideo(T2V_INPUT),
      );

      expect(bodyOf(KIE_CREATE)).toEqual({
        model: 'minimax-h3/text-to-video',
        input: {
          prompt: adultSafePrompt(PROMPT, 2500),
          duration: 15,
          aspect_ratio: '16:9',
          resolution: '768P',
        },
      });
      expect(result.modelUsed).toBe('wavespeed-ai/minimax-h3/text-to-video');
    });

    it("'failed' de moderação depois de criada não desvia", async () => {
      mockProviders({ wavespeed: 'failed-moderation' });
      await expect(
        run(buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT)),
      ).rejects.toThrow(/moderation/);
      expect(kieCalls()).toHaveLength(0);
    });

    it("'failed' técnico depois de criada também não desvia (evita cobrança dupla)", async () => {
      mockProviders({ wavespeed: 'failed-generic' });
      await expect(
        run(buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT)),
      ).rejects.toThrow('Inference worker crashed');
      expect(kieCalls()).toHaveLength(0);
    });
  });

  describe("desvio 'tecnico+recusa'", () => {
    const env = { ...BOTH_KEYS, MINIMAX_H3_KIE_FALLBACK: 'tecnico+recusa' };

    it("'failed' de moderação → refaz na kie", async () => {
      mockProviders({ wavespeed: 'failed-moderation' });
      const result = await run(
        buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT),
      );

      expect(kieCalls().filter((call) => call.url === KIE_CREATE)).toHaveLength(
        1,
      );
      expect(result.modelUsed).toBe('wavespeed-ai/minimax-h3/image-to-video');
    });

    it('recusa de menor é terminal: não desvia', async () => {
      mockProviders({ wavespeed: 'failed-minor' });
      await expect(
        run(buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT)),
      ).rejects.toThrow(/sexual\/minors/);
      expect(kieCalls()).toHaveLength(0);
    });
  });

  describe('MINIMAX_H3_PROVIDER=kie', () => {
    it('kie primeiro, WaveSpeed intocada', async () => {
      mockProviders({});
      const result = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_PROVIDER: 'kie',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      );

      expect(calls[0].url).toBe(KIE_CREATE);
      expect(wavespeedCalls()).toHaveLength(0);
      expect(result).toEqual({
        outputUrls: ['https://storage.test/generations/gen-i2v/output_0.mp4'],
        modelUsed: 'wavespeed-ai/minimax-h3/image-to-video',
      });
    });

    it("início falho na kie + 'tecnico' → WaveSpeed com o payload de hoje", async () => {
      mockProviders({ kie: 'start-402' });
      await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_PROVIDER: 'kie',
          MINIMAX_H3_KIE_FALLBACK: 'tecnico',
        }).generateMinimaxH3TextToVideo(T2V_INPUT),
      );

      expect(calls[0].url).toBe(KIE_CREATE);
      expect(bodyOf(WS_T2V)).toEqual({
        prompt: adultSafePrompt(PROMPT, 2500),
        resolution: '768p',
        duration: 15,
        seed: -1,
        aspect_ratio: '9:21',
      });
    });

    it('moderação da kie (430) sai com o texto do provedor e não desvia sem o modo recusa', async () => {
      mockProviders({ kie: 'fail-430' });
      const error = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_PROVIDER: 'kie',
          MINIMAX_H3_KIE_FALLBACK: 'tecnico',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ContentSafetyError);
      expect(error).not.toBeInstanceOf(ProviderFailureError);
      expect((error as Error).message).toBe(
        'Content rejected by moderation (430)',
      );
      expect(wavespeedCalls()).toHaveLength(0);
    });

    it('falha técnica da kie sai como ProviderFailureError com o detalhe', async () => {
      mockProviders({ kie: 'fail-500' });
      const error = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_PROVIDER: 'kie',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderFailureError);
      expect((error as ProviderFailureError).message).toBe(
        'A geração de vídeo falhou. Tente novamente.',
      );
      expect((error as ProviderFailureError).providerDetail).toBe(
        'internal error (500)',
      );
    });
  });

  describe('sem a NANO_BANANA_API_KEY', () => {
    it('PROVIDER=kie + desvio ligado: nunca chama a kie', async () => {
      mockProviders({ wavespeed: 'start-500' });
      await expect(
        run(
          buildProvider({
            ...WS_ENV,
            MINIMAX_H3_PROVIDER: 'kie',
            MINIMAX_H3_KIE_FALLBACK: 'tecnico+recusa',
          }).generateMinimaxH3ImageToVideo(I2V_INPUT),
        ),
      ).rejects.toBeInstanceOf(ProviderFailureError);
      expect(wavespeedCalls().length).toBeGreaterThan(0);
      expect(kieCalls()).toHaveLength(0);
    });
  });

  describe('moderação da kie no createTask (430 no corpo)', () => {
    const env = {
      ...BOTH_KEYS,
      MINIMAX_H3_PROVIDER: 'kie',
      MINIMAX_H3_KIE_FALLBACK: 'tecnico',
    };

    it('430 sem texto: sai como bloqueio com o código e não desvia', async () => {
      mockProviders({ kie: 'start-430-empty' });
      const error = await run(
        buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ContentSafetyError);
      expect((error as ContentSafetyError).message).toBe(
        'content moderation (430)',
      );
      expect((error as ContentSafetyError).supportCode).toBe('430');
      expect(wavespeedCalls()).toHaveLength(0);
    });

    it('430 com texto vago: leva o "(430)" e não desvia', async () => {
      mockProviders({ kie: 'start-430-flagged' });
      const error = await run(
        buildProvider(env).generateMinimaxH3TextToVideo(T2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ContentSafetyError);
      expect((error as Error).message).toBe('Your prompt was flagged (430)');
      expect(wavespeedCalls()).toHaveLength(0);
    });

    it('430 no resultado com failMsg genérico: ContentSafetyError, sem desvio', async () => {
      mockProviders({ kie: 'fail-430-generic' });
      const error = await run(
        buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ContentSafetyError);
      expect((error as Error).message).toBe('Generation failed (430)');
      expect((error as ContentSafetyError).supportCode).toBe('430');
      expect(wavespeedCalls()).toHaveLength(0);
    });
  });

  describe('início incerto (a tarefa pode existir) não desvia', () => {
    it("WaveSpeed 2xx sem id + 'tecnico+recusa': erro de hoje, kie intocada", async () => {
      mockProviders({ wavespeed: 'start-no-id' });
      const error = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_KIE_FALLBACK: 'tecnico+recusa',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ProviderFailureError);
      expect((error as Error).message).toBe(
        'O serviço de vídeo não respondeu como esperado. Tente novamente em alguns instantes.',
      );
      expect(kieCalls()).toHaveLength(0);
    });

    it("kie com tempo esgotado no createTask + 'tecnico': WaveSpeed intocada", async () => {
      mockProviders({ kie: 'start-timeout' });
      await expect(
        run(
          buildProvider({
            ...BOTH_KEYS,
            MINIMAX_H3_PROVIDER: 'kie',
            MINIMAX_H3_KIE_FALLBACK: 'tecnico',
          }).generateMinimaxH3ImageToVideo(I2V_INPUT),
        ),
      ).rejects.toBeInstanceOf(ProviderFailureError);
      expect(wavespeedCalls()).toHaveLength(0);
    });

    it("kie code 200 sem taskId + 'tecnico': WaveSpeed intocada", async () => {
      mockProviders({ kie: 'start-no-task' });
      await expect(
        run(
          buildProvider({
            ...BOTH_KEYS,
            MINIMAX_H3_PROVIDER: 'kie',
            MINIMAX_H3_KIE_FALLBACK: 'tecnico',
          }).generateMinimaxH3TextToVideo(T2V_INPUT),
        ),
      ).rejects.toBeInstanceOf(ProviderFailureError);
      expect(wavespeedCalls()).toHaveLength(0);
    });

    it("rede ANTES do envio (ECONNREFUSED) na WaveSpeed + 'tecnico': desvia", async () => {
      mockProviders({ wavespeed: 'start-econnrefused' });
      const result = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_KIE_FALLBACK: 'tecnico',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      );

      expect(kieCalls().filter((call) => call.url === KIE_CREATE)).toHaveLength(
        1,
      );
      expect(result.modelUsed).toBe('wavespeed-ai/minimax-h3/image-to-video');
    });
  });

  describe("'tecnico+recusa': falha final sem motivo do provedor não desvia", () => {
    const env = { ...BOTH_KEYS, MINIMAX_H3_KIE_FALLBACK: 'tecnico+recusa' };

    it("'failed' sem texto", async () => {
      mockProviders({ wavespeed: 'failed-empty' });
      await expect(
        run(buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT)),
      ).rejects.toThrow('A geração de vídeo falhou. Tente novamente.');
      expect(kieCalls()).toHaveLength(0);
    });

    it('demora além da janela (a tarefa ainda pode terminar e cobrar)', async () => {
      mockProviders({ wavespeed: 'processing' });
      await expect(
        run(buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT)),
      ).rejects.toThrow('demorou mais que o esperado');
      expect(kieCalls()).toHaveLength(0);
    });

    it("'failed' com o motivo do provedor desvia", async () => {
      mockProviders({ wavespeed: 'failed-generic' });
      const result = await run(
        buildProvider(env).generateMinimaxH3ImageToVideo(I2V_INPUT),
      );
      expect(kieCalls().filter((call) => call.url === KIE_CREATE)).toHaveLength(
        1,
      );
      expect(result.modelUsed).toBe('wavespeed-ai/minimax-h3/image-to-video');
    });
  });

  describe('desvio que também falha: o motivo certo sobe', () => {
    it('moderação na WaveSpeed + 402 na kie: sobe a moderação, não o "tente de novo"', async () => {
      mockProviders({ wavespeed: 'failed-moderation', kie: 'start-402' });
      const error = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_KIE_FALLBACK: 'tecnico+recusa',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(kieCalls().filter((call) => call.url === KIE_CREATE)).toHaveLength(
        1,
      );
      expect(error).not.toBeInstanceOf(ProviderFailureError);
      expect((error as Error).message).toMatch(/moderation/);
    });

    it('início falho na WaveSpeed + 430 na kie: sobe o bloqueio da kie', async () => {
      mockProviders({ wavespeed: 'start-500', kie: 'fail-430' });
      const error = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_KIE_FALLBACK: 'tecnico',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ContentSafetyError);
      expect((error as Error).message).toBe(
        'Content rejected by moderation (430)',
      );
    });

    it('início falho na WaveSpeed + falha técnica na kie: sobe o erro da WaveSpeed', async () => {
      mockProviders({ wavespeed: 'start-500', kie: 'start-402' });
      const error = await run(
        buildProvider({
          ...BOTH_KEYS,
          MINIMAX_H3_KIE_FALLBACK: 'tecnico',
        }).generateMinimaxH3ImageToVideo(I2V_INPUT),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderFailureError);
      expect((error as ProviderFailureError).providerDetail).toMatch(/^500 /);
    });
  });

  describe('shouldDivertMinimaxH3', () => {
    const technical = new ProviderFailureError(
      'Não foi possível gerar o vídeo agora.',
      '503 upstream',
    );
    const moderation = new Error('Content flagged by moderation');
    const minor = new Error('Content moderation blocked: sexual/minors');
    const failedWithoutText = new Error(VIDEO_MESSAGES.failed);
    const statusWithoutText = new ProviderFailureError(
      VIDEO_MESSAGES.failed,
      'status=timeout',
    );
    const kieWithoutText = new ProviderFailureError(
      VIDEO_MESSAGES.failed,
      'unknown error (500)',
    );
    const kieWithText = new ProviderFailureError(
      VIDEO_MESSAGES.failed,
      'internal error (500)',
    );

    it.each([
      ['off', 'start', 'técnica', false, technical],
      ['tecnico', 'start', 'técnica', true, technical],
      ['tecnico', 'start', 'moderação', false, moderation],
      ['tecnico', 'final', 'técnica', false, technical],
      ['tecnico+recusa', 'final', 'moderação', true, moderation],
      ['tecnico+recusa', 'start', 'menor', false, minor],
      ['tecnico+recusa', 'final', 'menor', false, minor],
      ['tecnico+recusa', 'final', "'failed' sem texto", false, failedWithoutText],
      ['tecnico+recusa', 'final', 'timeout sem erro', false, statusWithoutText],
      ['tecnico+recusa', 'final', 'kie sem failMsg', false, kieWithoutText],
      ['tecnico+recusa', 'final', 'kie com failMsg', true, kieWithText],
      ['tecnico+recusa', 'final', 'consulta fora do ar', false, technical],
    ] as const)(
      'modo %s, falha %s (%s) → desvia=%s',
      (mode, stage, _label, expected, error) => {
        expect(
          shouldDivertMinimaxH3(mode, stage, error, VIDEO_MESSAGES),
        ).toBe(expected);
      },
    );
  });
});
