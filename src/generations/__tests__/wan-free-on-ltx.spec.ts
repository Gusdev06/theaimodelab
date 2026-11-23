import {
  FreeGenerationType,
  GenerationStatus,
  GenerationType,
  Resolution,
} from '@prisma/client';
import { GenerationsService } from '../generations.service';
import {
  CreditsService,
  isWanFreeOnLtxEnabled,
  wanFreeOnLtxType,
} from '../../credits/credits.service';
import { GenerationJobName } from '../queue/generation-queue.constants';
import type { GenerateWavespeedImageToVideoDto } from '../dto/videos/generate-wavespeed-image-to-video.dto';

/**
 * TKT-382 · a grátis do Wan (COMFYDEPLOY_WAN, modelo desligado) vale no LTX 2.3 Spicy de até 5 s em 480p/720p.
 * Estimativa e geração usam a mesma regra: o botão mostra "grátis" só quando a API não vai cobrar.
 */
describe('TKT-382 · grátis do Wan no LTX Spicy', () => {
  const LTX = 'WAVESPEED_LTX_SPICY';

  describe('wanFreeOnLtxType', () => {
    it('LTX até 5 s em 480p ou 720p usa a grátis do Wan', () => {
      expect(wanFreeOnLtxType(LTX, Resolution.RES_720P, 5, {})).toBe(FreeGenerationType.COMFYDEPLOY_WAN);
      expect(wanFreeOnLtxType(LTX, Resolution.RES_480P, 5, {})).toBe(FreeGenerationType.COMFYDEPLOY_WAN);
    });

    it('mais longo, 1080p, outro modelo ou sem duração: cobra normal', () => {
      expect(wanFreeOnLtxType(LTX, Resolution.RES_720P, 6, {})).toBeNull();
      expect(wanFreeOnLtxType(LTX, Resolution.RES_720P, 10, {})).toBeNull();
      expect(wanFreeOnLtxType(LTX, Resolution.RES_1080P, 5, {})).toBeNull();
      expect(wanFreeOnLtxType('WAVESPEED_SEEDANCE_SPICY', Resolution.RES_720P, 5, {})).toBeNull();
      expect(wanFreeOnLtxType(LTX, Resolution.RES_720P, undefined, {})).toBeNull();
      expect(wanFreeOnLtxType(LTX, Resolution.RES_720P, Number.NaN, {})).toBeNull();
      expect(wanFreeOnLtxType(LTX, null, 5, {})).toBeNull();
    });

    it('WAN_FREE_ON_LTX=off desliga sem deploy (ligado por padrão)', () => {
      expect(isWanFreeOnLtxEnabled({})).toBe(true);
      for (const off of ['off', 'OFF', 'false', '0', ' off ']) {
        expect(isWanFreeOnLtxEnabled({ WAN_FREE_ON_LTX: off })).toBe(false);
        expect(wanFreeOnLtxType(LTX, Resolution.RES_720P, 5, { WAN_FREE_ON_LTX: off })).toBeNull();
      }
    });
  });

  describe('estimateCost', () => {
    function estimator(wanRemaining: number, locked = false) {
      const plansService = { calculateGenerationCost: jest.fn(async () => 675) };
      const service = Object.assign(Object.create(CreditsService.prototype), {
        plansService,
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      }) as CreditsService;
      jest.spyOn(service, 'getBalance').mockResolvedValue({
        totalCreditsAvailable: 95,
        freeGenerations: { COMFYDEPLOY_WAN: wanRemaining },
      } as any);
      jest.spyOn(service as any, 'isLockedByExpiredPrepaid').mockResolvedValue(locked);
      return service;
    }

    it('caso real (Arif): 95 créditos, 2 grátis do Wan, LTX 5 s 720p → grátis, sem folha', async () => {
      const r = await estimator(2).estimateCost('u-1', GenerationType.IMAGE_TO_VIDEO, Resolution.RES_720P, 5, false, 1, LTX);
      expect(r).toMatchObject({
        creditsRequired: 675,
        canUseFreeGeneration: true,
        hasSufficientBalance: true,
        freeGenerationType: FreeGenerationType.COMFYDEPLOY_WAN,
        freeGenerationsRemainingForType: 2,
      });
    });

    it('sem grátis do Wan: continua pedindo créditos e não anuncia tipo grátis', async () => {
      const r = await estimator(0).estimateCost('u-1', GenerationType.IMAGE_TO_VIDEO, Resolution.RES_720P, 5, false, 1, LTX);
      expect(r).toMatchObject({ canUseFreeGeneration: false, hasSufficientBalance: false, freeGenerationType: null });
    });

    it('LTX de 10 s: cobra normal mesmo com grátis do Wan', async () => {
      const r = await estimator(2).estimateCost('u-1', GenerationType.IMAGE_TO_VIDEO, Resolution.RES_720P, 10, false, 1, LTX);
      expect(r.canUseFreeGeneration).toBe(false);
    });

    it('trava do pré-pago vencido continua valendo', async () => {
      const r = await estimator(2, true).estimateCost('u-1', GenerationType.IMAGE_TO_VIDEO, Resolution.RES_720P, 5, false, 1, LTX);
      expect(r.canUseFreeGeneration).toBe(false);
    });
  });

  describe('generateImageToVideoWavespeed', () => {
    function harness(hasWanFree: boolean) {
      const prisma = {
        generation: { create: jest.fn(async (args: any) => ({ id: 'gen-ltx', ...args.data })) },
        generationInputImage: { createMany: jest.fn(async () => ({ count: 1 })) },
      };
      const creditsService = {
        getBalance: jest.fn(async () => ({ totalCreditsAvailable: 5_000 })),
        hasFreeGeneration: jest.fn(async (_u: string, t: FreeGenerationType) => hasWanFree && t === FreeGenerationType.COMFYDEPLOY_WAN),
      };
      const plansService = { calculateGenerationCost: jest.fn(async () => 675) };
      const modelsService = { assertActiveBySlug: jest.fn(async () => undefined) };
      const generationQueue = { add: jest.fn(async () => undefined) };
      const service = Object.assign(Object.create(GenerationsService.prototype), {
        prisma,
        creditsService,
        plansService,
        modelsService,
        generationQueue,
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        uploadBase64ImagePublic: jest.fn(async () => 'https://cdn/first.jpg'),
        consumeFreeGenerationOrRollback: jest.fn(async () => undefined),
        debitCredits: jest.fn(async () => undefined),
      }) as any;
      return { service: service as GenerationsService, raw: service, prisma, generationQueue, creditsService };
    }

    const dto = (over: Partial<GenerateWavespeedImageToVideoDto> = {}): GenerateWavespeedImageToVideoDto =>
      ({
        prompt: 'she turns to the camera and smiles',
        first_frame: 'data:image/jpeg;base64,AAAA',
        resolution: Resolution.RES_720P,
        duration_seconds: 5,
        ...over,
      }) as GenerateWavespeedImageToVideoDto;

    it('com grátis do Wan: 0 crédito, consome COMFYDEPLOY_WAN, fila marca usedFreeGeneration (estorno da grátis se falhar)', async () => {
      const h = harness(true);
      const r = await h.service.generateImageToVideoWavespeed('u-1', dto());
      expect(r).toEqual({ id: 'gen-ltx', status: GenerationStatus.PROCESSING, creditsConsumed: 0 });
      const created = h.prisma.generation.create.mock.calls[0][0].data;
      expect(created).toMatchObject({ creditsConsumed: 0, usedFreeGeneration: true, modelUsed: 'wavespeed-ltx-spicy' });
      expect(h.raw.consumeFreeGenerationOrRollback).toHaveBeenCalledWith('u-1', 'gen-ltx', FreeGenerationType.COMFYDEPLOY_WAN);
      expect(h.raw.debitCredits).not.toHaveBeenCalled();
      expect(h.creditsService.getBalance).not.toHaveBeenCalled();
      expect(h.generationQueue.add).toHaveBeenCalledWith(
        GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO,
        expect.objectContaining({ creditsConsumed: 0, usedFreeGeneration: true }),
      );
    });

    it('sem grátis do Wan: cobra os créditos como antes', async () => {
      const h = harness(false);
      const r = await h.service.generateImageToVideoWavespeed('u-1', dto());
      expect(r.creditsConsumed).toBe(675);
      expect(h.raw.debitCredits).toHaveBeenCalledWith('u-1', 675, 'gen-ltx', GenerationType.IMAGE_TO_VIDEO, Resolution.RES_720P);
      expect(h.raw.consumeFreeGenerationOrRollback).not.toHaveBeenCalled();
      expect(h.generationQueue.add).toHaveBeenCalledWith(
        GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO,
        expect.objectContaining({ creditsConsumed: 675, usedFreeGeneration: false }),
      );
    });

    it('vídeo de 10 s não usa a grátis (nem consulta) e cobra', async () => {
      const h = harness(true);
      const r = await h.service.generateImageToVideoWavespeed('u-1', dto({ duration_seconds: 10 }));
      expect(r.creditsConsumed).toBe(675);
      expect(h.creditsService.hasFreeGeneration).not.toHaveBeenCalled();
      expect(h.raw.consumeFreeGenerationOrRollback).not.toHaveBeenCalled();
    });
  });
});
