import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FreeGenerationType, GenerationType, Resolution } from '@prisma/client';
import {
  resolveMotionControlRequest,
  wanAnimateCredits,
  WAN_ANIMATE_MODEL_VARIANT,
  WAN_ANIMATE_PROMPT_MAX_LENGTH,
} from '../motion-control-engine';
import { WavespeedVideoProvider } from '../providers/wavespeed-video.provider';
import { resolveFreeGenerationType } from '../../credits/credits.service';
import { planFallback } from '../queue/generation-fallback';
import { GenerationJobName, MotionControlJobData } from '../queue/generation-queue.constants';

describe('Motion Control · motor Wan 2.2 Animate (troca de pessoa no vídeo)', () => {
  describe('resolveMotionControlRequest', () => {
    it('sem motor continua no Kling 720p, como sempre', () => {
      expect(resolveMotionControlRequest({})).toEqual({
        engine: 'kling',
        mode: null,
        resolution: '720p',
        dbResolution: Resolution.RES_720P,
        prompt: null,
      });
      expect(resolveMotionControlRequest({ resolution: '1080p' }).dbResolution).toBe(Resolution.RES_1080P);
    });

    it('Kling ignora o texto e recusa 480p', () => {
      expect(resolveMotionControlRequest({ engine: 'kling', prompt: 'qualquer coisa' }).prompt).toBeNull();
      expect(() => resolveMotionControlRequest({ engine: 'kling', resolution: '480p' })).toThrow(BadRequestException);
    });

    it('wan-replace troca a pessoa; wan-animate anima a foto; 1080p é recusado', () => {
      const replace = resolveMotionControlRequest({ engine: 'wan-replace', resolution: '480p', prompt: '  keep   the outfit ' });
      expect(replace).toEqual({
        engine: 'wan-replace',
        mode: 'replace',
        resolution: '480p',
        dbResolution: Resolution.RES_480P,
        prompt: 'keep the outfit',
      });
      expect(resolveMotionControlRequest({ engine: 'wan-animate' }).mode).toBe('animate');
      expect(resolveMotionControlRequest({ engine: 'wan-animate' }).dbResolution).toBe(Resolution.RES_720P);
      expect(() => resolveMotionControlRequest({ engine: 'wan-replace', resolution: '1080p' })).toThrow(BadRequestException);
    });

    it('texto do Wan vazio vira null e o longo é cortado no teto', () => {
      expect(resolveMotionControlRequest({ engine: 'wan-replace', prompt: '   ' }).prompt).toBeNull();
      const long = 'a'.repeat(WAN_ANIMATE_PROMPT_MAX_LENGTH + 50);
      expect(resolveMotionControlRequest({ engine: 'wan-replace', prompt: long }).prompt).toHaveLength(WAN_ANIMATE_PROMPT_MAX_LENGTH);
    });

    it('motor desconhecido é recusado antes de cobrar', () => {
      expect(() => resolveMotionControlRequest({ engine: 'sora' })).toThrow(BadRequestException);
    });
  });

  describe('preço (por segundo do vídeo, mínimo 3 s)', () => {
    it('720p = 270/s, 480p = 135/s, segundos arredondados para cima', () => {
      expect(wanAnimateCredits(Resolution.RES_720P, 5)).toBe(1350);
      expect(wanAnimateCredits(Resolution.RES_480P, 5)).toBe(675);
      expect(wanAnimateCredits(Resolution.RES_720P, 5.2)).toBe(6 * 270);
    });

    it('vídeo curto cobra o mínimo de 3 s, como a WaveSpeed', () => {
      expect(wanAnimateCredits(Resolution.RES_720P, 1.4)).toBe(3 * 270);
      expect(wanAnimateCredits(Resolution.RES_480P, 0)).toBe(3 * 135);
      expect(wanAnimateCredits(Resolution.RES_480P, Number.NaN)).toBe(3 * 135);
    });
  });

  it('o Wan não usa a geração grátis do Motion Control; o Kling continua usando', () => {
    expect(resolveFreeGenerationType(GenerationType.MOTION_CONTROL, WAN_ANIMATE_MODEL_VARIANT)).toBeNull();
    expect(resolveFreeGenerationType(GenerationType.MOTION_CONTROL, null)).toBe(FreeGenerationType.MOTION_CONTROL);
  });

  it('falha no Wan não desvia para o MiniMax (ele não troca a pessoa); o Kling segue com o desvio de sempre', () => {
    const base: MotionControlJobData = {
      generationId: 'g1',
      userId: 'u1',
      creditsConsumed: 1350,
      usedFreeGeneration: false,
      videoUrl: 'https://cdn.example/v.mp4',
      imageUrl: 'https://cdn.example/i.jpg',
      resolution: '720p',
    } as MotionControlJobData;
    const ctx = { durationSeconds: 5, aspectRatio: null } as unknown as Parameters<typeof planFallback>[2];
    expect(planFallback(GenerationJobName.MOTION_CONTROL, { ...base, engine: 'wan-replace' }, ctx)).toBeNull();
    expect(planFallback(GenerationJobName.MOTION_CONTROL, { ...base, engine: 'wan-animate' }, ctx)).toBeNull();
  });

  describe('WavespeedVideoProvider.generateWanAnimate', () => {
    const config = { get: (key: string, fallback?: string) => (key === 'WAVESPEED_API_KEY' ? 'chave-de-teste' : fallback) } as unknown as ConfigService;
    const uploads = {} as never;

    it('manda foto, vídeo, modo e resolução ao wan-2.2/animate e devolve o vídeo guardado', async () => {
      const provider = new WavespeedVideoProvider(config, uploads);
      const create = jest.spyOn(provider as never, 'createPrediction' as never).mockResolvedValue('pred-1' as never);
      jest.spyOn(provider as never, 'pollPrediction' as never).mockResolvedValue('https://wavespeed.example/out.mp4' as never);
      jest.spyOn(provider as never, 'downloadAndUpload' as never).mockResolvedValue('https://s3.example/out.mp4' as never);

      const result = await provider.generateWanAnimate({
        id: 'g1',
        imageUrl: 'https://s3.example/in.jpg',
        videoUrl: 'https://s3.example/in.mp4',
        mode: 'replace',
        resolution: '720p',
        prompt: 'Keep the outfit and background of the video.',
      });

      expect(create).toHaveBeenCalledTimes(1);
      const [model, body] = create.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(model).toBe('wavespeed-ai/wan-2.2/animate');
      expect(body).toEqual({
        image: 'https://s3.example/in.jpg',
        video: 'https://s3.example/in.mp4',
        mode: 'replace',
        resolution: '720p',
        seed: -1,
        prompt: 'Keep the outfit and background of the video.',
      });
      expect(result).toEqual({ outputUrls: ['https://s3.example/out.mp4'], modelUsed: 'wavespeed-ai/wan-2.2/animate' });
    });

    it('sem texto, o campo prompt não vai', async () => {
      const provider = new WavespeedVideoProvider(config, uploads);
      const create = jest.spyOn(provider as never, 'createPrediction' as never).mockResolvedValue('pred-2' as never);
      jest.spyOn(provider as never, 'pollPrediction' as never).mockResolvedValue('https://wavespeed.example/out.mp4' as never);
      jest.spyOn(provider as never, 'downloadAndUpload' as never).mockResolvedValue('https://s3.example/out.mp4' as never);
      await provider.generateWanAnimate({ id: 'g2', imageUrl: 'a', videoUrl: 'b', mode: 'animate', resolution: '480p' });
      const [, body] = create.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(body).not.toHaveProperty('prompt');
      expect(body.mode).toBe('animate');
    });

    it('sem a chave da WaveSpeed recusa antes de criar a tarefa', async () => {
      const noKey = { get: (_key: string, fallback?: string) => fallback ?? '' } as unknown as ConfigService;
      const provider = new WavespeedVideoProvider(noKey, uploads);
      const create = jest.spyOn(provider as never, 'createPrediction' as never);
      await expect(
        provider.generateWanAnimate({ id: 'g3', imageUrl: 'a', videoUrl: 'b', mode: 'replace', resolution: '720p' }),
      ).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    });
  });
});
