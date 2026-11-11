import { ConfigService } from '@nestjs/config';
import { Resolution } from '@prisma/client';
import {
  fitsWanAnimateKie,
  WAN_ANIMATE_KIE_MAX_BYTES,
  WAN_ANIMATE_KIE_MODEL,
  wanAnimateCredits,
  wanAnimateOnKie,
} from '../motion-control-engine';
import { WanProvider } from '../providers/wan.provider';

describe('Troca de pessoa na kie (TKT-245)', () => {
  it('interruptor: só "kie" liga; vazio ou outro valor segue na WaveSpeed', () => {
    expect(wanAnimateOnKie('kie')).toBe(true);
    expect(wanAnimateOnKie(' KIE ')).toBe(true);
    expect(wanAnimateOnKie(undefined)).toBe(false);
    expect(wanAnimateOnKie('wavespeed')).toBe(false);
  });

  it('arquivos: até 10 MB cada; tamanho desconhecido não arrisca', () => {
    expect(fitsWanAnimateKie(5_000_000, 800_000)).toBe(true);
    expect(fitsWanAnimateKie(WAN_ANIMATE_KIE_MAX_BYTES + 1, 800_000)).toBe(false);
    expect(fitsWanAnimateKie(5_000_000, WAN_ANIMATE_KIE_MAX_BYTES + 1)).toBe(false);
    expect(fitsWanAnimateKie(undefined, 800_000)).toBe(false);
  });

  it('preço com a kie: 720p 210 cr/s e 480p 100 cr/s; sem ela, o de hoje (270/135); mínimo de 3 s nos dois', () => {
    expect(wanAnimateCredits(Resolution.RES_720P, 8, { kie: true })).toBe(1680);
    expect(wanAnimateCredits(Resolution.RES_480P, 8, { kie: true })).toBe(800);
    expect(wanAnimateCredits(Resolution.RES_720P, 8)).toBe(2160);
    expect(wanAnimateCredits(Resolution.RES_480P, 7.88)).toBe(1080);
    expect(wanAnimateCredits(Resolution.RES_720P, 1, { kie: true })).toBe(630);
  });

  it('margem da reserva na WaveSpeed com o preço da kie fica acima do piso de 15% no crédito mais barato', () => {
    const cheapestCreditUsd = 0.0005;
    const wavespeedUsdPerSecond = { [Resolution.RES_720P]: 0.08, [Resolution.RES_480P]: 0.04 } as const;
    for (const resolution of [Resolution.RES_720P, Resolution.RES_480P] as const) {
      const revenue = wanAnimateCredits(resolution, 10, { kie: true }) * cheapestCreditUsd;
      const cost = wavespeedUsdPerSecond[resolution] * 10;
      expect(1 - cost / revenue).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('manda vídeo, foto, resolução e nsfw_checker=false ao wan/2-2-animate-replace e devolve o vídeo guardado', async () => {
    const config = { get: (_key: string, fallback?: string) => fallback ?? 'chave' } as unknown as ConfigService;
    const provider = new WanProvider(config, {} as never);
    const fetchMock = jest
      .spyOn(provider as never, 'fetchWithTimeout' as never)
      .mockResolvedValue({ ok: true, json: async () => ({ code: 200, msg: 'ok', data: { taskId: 't1' } }) } as never);
    const poll = jest.spyOn(provider as never, 'pollTaskStatus' as never).mockResolvedValue(['https://kie.example/out.mp4'] as never);
    jest.spyOn(provider as never, 'downloadAndUpload' as never).mockResolvedValue('https://s3.example/out.mp4' as never);

    const result = await provider.generateWanAnimateReplace({
      id: 'g1',
      videoUrl: 'https://s3.example/in.mp4',
      imageUrl: 'https://s3.example/in.jpg',
      resolution: '480p',
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('https://api.kie.ai/api/v1/jobs/createTask');
    expect(JSON.parse(init.body)).toEqual({
      model: WAN_ANIMATE_KIE_MODEL,
      input: { video_url: 'https://s3.example/in.mp4', image_url: 'https://s3.example/in.jpg', resolution: '480p', nsfw_checker: false },
    });
    expect((poll.mock.calls[0] as unknown[])[0]).toBe('t1');
    expect(result).toEqual({ outputUrls: ['https://s3.example/out.mp4'], modelUsed: 'wan/2-2-animate-replace' });
  });

  it('createTask recusado vira erro (o processador cai na WaveSpeed)', async () => {
    const config = { get: (_key: string, fallback?: string) => fallback ?? 'chave' } as unknown as ConfigService;
    const provider = new WanProvider(config, {} as never);
    jest
      .spyOn(provider as never, 'fetchWithTimeout' as never)
      .mockResolvedValue({ ok: true, json: async () => ({ code: 402, msg: 'insufficient', data: null }) } as never);
    await expect(
      provider.generateWanAnimateReplace({ id: 'g2', videoUrl: 'a', imageUrl: 'b', resolution: '720p' }),
    ).rejects.toThrow(/createTask failed/);
  });
});
