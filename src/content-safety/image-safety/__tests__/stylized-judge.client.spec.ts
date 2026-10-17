import {
  createStylizedJudge,
  FetchLike,
  HIVE_VLM_MODEL,
  HIVE_VLM_URL,
  HiveStylizedJudge,
  NoopStylizedJudge,
  parseHiveJudgeResponse,
} from '../stylized-judge.client';
import { NormalizedImage, SafetyProviderUnavailableError } from '../types';

/**
 * Juiz de estilizado: desligado sem HIVE_API_KEY; com ela, o adaptador da Hive VLM é testado com respostas
 * SIMULADAS (nenhuma chamada de rede, bytes de imagem inventados).
 */

const IMAGE: NormalizedImage = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  width: 512,
  height: 512,
  sha256: '1'.repeat(64),
  sourceMimeType: 'image/png',
};
const API_KEY = 'chave-falsa-de-teste';

function hiveBody(content: unknown): string {
  return JSON.stringify({
    id: 'resposta-simulada',
    model: HIVE_VLM_MODEL,
    created: 1_790_000_000_000,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 300, completion_tokens: 12, total_tokens: 312 },
  });
}

function fakeFetch(
  respond: (init: Parameters<FetchLike>[1]) => Promise<{
    ok: boolean;
    status: number;
    body: string;
  }>,
) {
  return jest.fn<ReturnType<FetchLike>, Parameters<FetchLike>>(
    async (_url, init) => {
      const response = await respond(init);
      return {
        ok: response.ok,
        status: response.status,
        text: () => Promise.resolve(response.body),
      };
    },
  );
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('stylized-judge.client', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('sem HIVE_API_KEY: desligado, e chamado por engano é "não configurado" (nunca "adulto")', async () => {
    const judge = createStylizedJudge({ hiveApiKey: null });
    expect(judge).toBeInstanceOf(NoopStylizedJudge);
    expect(judge.enabled).toBe(false);
    const error = await caught(judge.judge(IMAGE));
    expect(error).toBeInstanceOf(SafetyProviderUnavailableError);
    expect(error).toMatchObject({ failure: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('com a chave: pergunta neutra com a imagem em data URI, resposta em JSON estrito', async () => {
    const fetchImpl = fakeFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: hiveBody('{"appears_minor": false, "confidence": 91}'),
      }),
    );
    const judge = createStylizedJudge({ hiveApiKey: API_KEY }, fetchImpl);
    expect(judge).toBeInstanceOf(HiveStylizedJudge);
    expect(judge.enabled).toBe(true);

    expect(await judge.judge(IMAGE)).toEqual({
      status: 'judged',
      judge: 'hive-vlm',
      childlike: false,
      confidence: 91,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(HIVE_VLM_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(init.body) as {
      model: string;
      temperature: number;
      max_tokens: number;
      response_format: { type: string; json_schema: { strict: boolean } };
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          text?: string;
          image_url?: { url: string };
        }>;
      }>;
    };
    expect(body.model).toBe('hive/vision-language-model');
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1);
    expect(body.max_tokens).toBeLessThanOrEqual(2048);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    const [question, picture] = body.messages[0].content;
    expect(question.type).toBe('text');
    expect(question.text).toMatch(/under 18/);
    expect(picture.image_url?.url).toBe(
      `data:image/jpeg;base64,${IMAGE.jpeg.toString('base64')}`,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sem fetch injetado usa o fetch nativo (aqui simulado, sem rede)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(hiveBody('{"appears_minor": false, "confidence": 80}'), {
        status: 200,
      }),
    );
    const judge = createStylizedJudge({ hiveApiKey: API_KEY });
    expect(await judge.judge(IMAGE)).toMatchObject({
      childlike: false,
      confidence: 80,
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      HIVE_VLM_URL,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('traço infantil acusado volta como childlike', async () => {
    const judge = new HiveStylizedJudge(
      API_KEY,
      fakeFetch(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: hiveBody(' {"appears_minor": true, "confidence": 140} '),
        }),
      ),
    );
    expect(await judge.judge(IMAGE)).toMatchObject({
      childlike: true,
      confidence: 100,
    });
  });

  it('status de erro da Hive: limite, organização pausada, 5xx e o resto', async () => {
    const statusCases: Array<[number, string]> = [
      [429, 'throttled'],
      [401, 'auth'],
      [405, 'auth'],
      [500, 'server_error'],
      [503, 'server_error'],
      [400, 'invalid_response'],
    ];
    for (const [status, failure] of statusCases) {
      const judge = new HiveStylizedJudge(
        API_KEY,
        fakeFetch(() => Promise.resolve({ ok: false, status, body: '{}' })),
      );
      const error = await caught(judge.judge(IMAGE));
      expect(error).toBeInstanceOf(SafetyProviderUnavailableError);
      expect(error).toMatchObject({ provider: 'hive-vlm', failure });
    }
  });

  it('prazo vencido, rede fora e imagem vazia', async () => {
    const slow = new HiveStylizedJudge(
      API_KEY,
      fakeFetch(
        (init) =>
          new Promise((_, reject) =>
            init.signal.addEventListener('abort', () =>
              reject(new Error('abortado')),
            ),
          ),
      ),
    );
    expect(await caught(slow.judge(IMAGE, { timeoutMs: 20 }))).toMatchObject({
      failure: 'timeout',
    });

    const offline = new HiveStylizedJudge(
      API_KEY,
      fakeFetch(() => Promise.reject(new Error('ECONNRESET'))),
    );
    expect(await caught(offline.judge(IMAGE))).toMatchObject({
      failure: 'server_error',
    });

    const fetchImpl = fakeFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: '',
      }),
    );
    const emptyImage = await caught(
      new HiveStylizedJudge(API_KEY, fetchImpl).judge({
        ...IMAGE,
        jpeg: Buffer.alloc(0),
      }),
    );
    expect(emptyImage).toMatchObject({ failure: 'invalid_media' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancelamento de quem chamou chega à requisição', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const judge = new HiveStylizedJudge(
      API_KEY,
      fakeFetch(
        (init) =>
          new Promise((_, reject) => {
            received = init.signal;
            init.signal.addEventListener('abort', () =>
              reject(new Error('abortado')),
            );
          }),
      ),
    );
    const pending = caught(judge.judge(IMAGE, { signal: controller.signal }));
    controller.abort();
    expect(await pending).toMatchObject({ failure: 'timeout' });
    expect(received?.aborted).toBe(true);
  });

  it('parseHiveJudgeResponse: qualquer coisa fora do formato é resposta inválida', () => {
    const invalid = [
      'não é json',
      JSON.stringify({ choices: [] }),
      hiveBody(null),
      hiveBody('texto livre'),
      hiveBody('{"appears_minor": "sim", "confidence": 90}'),
      hiveBody('{"appears_minor": true}'),
      hiveBody('{"appears_minor": true, "confidence": "alta"}'),
    ];
    for (const body of invalid) {
      expect(() => parseHiveJudgeResponse(body)).toThrow(
        SafetyProviderUnavailableError,
      );
    }
    expect(
      parseHiveJudgeResponse(
        hiveBody('{"appears_minor": false, "confidence": -5}'),
      ),
    ).toEqual({ childlike: false, confidence: 0 });
  });
});
