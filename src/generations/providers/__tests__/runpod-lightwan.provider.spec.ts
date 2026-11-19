import { ConfigService } from '@nestjs/config';
import { RUNPOD_LIGHTWAN_MODEL, RunpodLightwanProvider } from '../runpod-lightwan.provider';
import { UploadsService } from '../../../uploads/uploads.service';

const ON = {
  SPICY_I2V_ENGINE: 'runpod',
  SPICY_I2V_RUNPOD_PCT: '100',
  RUNPOD_API_KEY: 'rp-key',
  RUNPOD_LIGHTWAN_ENDPOINT_ID: 'ep123',
};

function build(env: Record<string, string>) {
  const config = { get: (key: string, fallback?: string) => env[key] ?? fallback } as unknown as ConfigService;
  const uploads = {
    uploadBuffer: jest.fn((_b: Buffer, folder: string, name: string) => Promise.resolve(`https://cdn.test/${folder}/${name}`)),
  } as unknown as UploadsService;
  return { provider: new RunpodLightwanProvider(config, uploads), uploads };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ROUTE = { canaryKey: 'user-1', resolution: '480p', durationSeconds: 5 };

describe('RunpodLightwanProvider (vídeo 18+ no worker próprio)', () => {
  let fetchMock: jest.SpyInstance;
  let calls: Array<{ url: string; body?: unknown }>;

  beforeEach(() => {
    calls = [];
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    fetchMock?.mockRestore();
    jest.useRealTimers();
  });

  function mockFetch(handler: (url: string) => Response) {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return Promise.resolve(handler(url));
    });
  }

  async function settle<T>(promise: Promise<T>): Promise<T> {
    let done: { ok: true; v: T } | { ok: false; e: unknown } | null = null;
    promise.then((v) => (done = { ok: true, v }), (e: unknown) => (done = { ok: false, e }));
    for (let i = 0; i < 400 && !done; i++) await jest.advanceTimersByTimeAsync(2_500);
    const result = done as { ok: true; v: T } | { ok: false; e: unknown } | null;
    if (!result) throw new Error('não terminou');
    if (!result.ok) throw result.e;
    return result.v;
  }

  it('desligado por padrão: sem flag, sem chave, sem endpoint ou canário vazio = WaveSpeed', async () => {
    for (const env of [{}, { ...ON, SPICY_I2V_ENGINE: '' }, { ...ON, RUNPOD_API_KEY: '' }, { ...ON, RUNPOD_LIGHTWAN_ENDPOINT_ID: '' }, { ...ON, SPICY_I2V_RUNPOD_PCT: '' }]) {
      expect(build(env).provider.isEligible(ROUTE)).toBe(false);
    }
    mockFetch(() => json({}));
    expect(await build({}).provider.route(ROUTE)).toBe('wavespeed');
    expect(calls).toHaveLength(0);
  });

  it('só 5 s em 480p cabem no worker', () => {
    const { provider } = build(ON);
    expect(provider.isEligible(ROUTE)).toBe(true);
    expect(provider.isEligible({ ...ROUTE, resolution: '720p' })).toBe(false);
    expect(provider.isEligible({ ...ROUTE, durationSeconds: 8 })).toBe(false);
  });

  it('canário estável por pessoa', () => {
    const { provider } = build({ ...ON, SPICY_I2V_RUNPOD_PCT: '30' });
    const users = Array.from({ length: 300 }, (_, i) => `u${i}`);
    const picks = users.map((u) => provider.isEligible({ ...ROUTE, canaryKey: u }));
    const inside = picks.filter(Boolean).length;
    expect(inside).toBeGreaterThan(50);
    expect(inside).toBeLessThan(130);
    users.forEach((u, i) => expect(provider.isEligible({ ...ROUTE, canaryKey: u })).toBe(picks[i]));
  });

  it('worker quente → RunPod; frio → WaveSpeed e dispara 1 aquecimento (com intervalo)', async () => {
    let idle = 1;
    mockFetch((url) => (url.endsWith('/health') ? json({ workers: { idle, ready: 0 } }) : json({ id: 'w1' })));
    const { provider } = build(ON);
    expect(await provider.route(ROUTE)).toBe('runpod');
    idle = 0;
    expect(await provider.route(ROUTE)).toBe('wavespeed');
    expect(await provider.route(ROUTE)).toBe('wavespeed');
    const runs = calls.filter((c) => c.url.endsWith('/run'));
    expect(runs).toHaveLength(1);
    expect(runs[0].body).toEqual({ input: { warmup: true } });
  });

  it('saúde ilegível = WaveSpeed; modo wait vai ao RunPod sem olhar a saúde', async () => {
    mockFetch(() => json({}, 500));
    expect(await build(ON).provider.route(ROUTE)).toBe('wavespeed');
    calls = [];
    expect(await build({ ...ON, SPICY_I2V_RUNPOD_COLD: 'wait' }).provider.route(ROUTE)).toBe('runpod');
    expect(calls.filter((c) => c.url.endsWith('/health'))).toHaveLength(0);
  });

  it('gera: manda imagem + prompt com âncora de adulto, espera o job e sobe o mp4', async () => {
    const video = Buffer.alloc(5_000, 1).toString('base64');
    let polls = 0;
    mockFetch((url) => {
      if (url.endsWith('/run')) return json({ id: 'job-1' });
      polls += 1;
      return polls < 3 ? json({ status: 'IN_PROGRESS' }) : json({ status: 'COMPLETED', output: { video_base64: video, seconds_gen: 11.3 } });
    });
    const { provider, uploads } = build(ON);
    const result = await settle(provider.generateImageToVideo({ id: 'gen-1', prompt: 'mulher adulta sorrindo', imageUrl: 'https://cdn.test/in.jpg' }));
    expect(result).toEqual({ outputUrls: ['https://cdn.test/generations/gen-1/output_0.mp4'], modelUsed: RUNPOD_LIGHTWAN_MODEL });
    const sent = calls.find((c) => c.url.endsWith('/run'))?.body as { input: { image_url: string; prompt: string } };
    expect(sent.input.image_url).toBe('https://cdn.test/in.jpg');
    expect(sent.input.prompt).toContain('mulher adulta sorrindo');
    expect((uploads.uploadBuffer as jest.Mock).mock.calls[0][3]).toBe('video/mp4');
  });

  it('job que falha ou volta sem vídeo vira erro (o processor cai na WaveSpeed)', async () => {
    mockFetch((url) => (url.endsWith('/run') ? json({ id: 'j' }) : json({ status: 'COMPLETED', output: { error: 'geração: boom' } })));
    await expect(settle(build(ON).provider.generateImageToVideo({ id: 'g', prompt: 'p', imageUrl: 'https://x/i.jpg' }))).rejects.toThrow(
      'geração: boom',
    );
    fetchMock.mockRestore();
    mockFetch((url) => (url.endsWith('/run') ? json({ id: 'j' }) : json({ status: 'FAILED', error: 'oom' })));
    await expect(settle(build(ON).provider.generateImageToVideo({ id: 'g', prompt: 'p', imageUrl: 'https://x/i.jpg' }))).rejects.toThrow(
      'FAILED',
    );
  });
});
