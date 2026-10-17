import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { ContentSafetyEventKind, GenerationStatus } from '@prisma/client';
import { GenerationProcessor, willBeRetried } from '../generation.processor';
import { GenerationJobName } from '../generation-queue.constants';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreditsService } from '../../../credits/credits.service';
import { UploadsService } from '../../../uploads/uploads.service';
import { TheaimodelabProvider } from '../../providers/theaimodelab.provider';
import { NanoBananaProvider } from '../../providers/nano-banana.provider';
import { WanProvider } from '../../providers/wan.provider';
import { FaceSwapProvider } from '../../providers/face-swap.provider';
import { VeoProvider } from '../../providers/veo.provider';
import { GrokImagineProvider } from '../../providers/grok-imagine.provider';
import { GeminiOmniVideoProvider } from '../../providers/gemini-omni-video.provider';
import { BytedanceSeedanceProvider } from '../../providers/bytedance-seedance.provider';
import { KlingProvider } from '../../providers/kling.provider';
import { ComfyDeployProvider } from '../../providers/comfydeploy.provider';
import { WavespeedVideoProvider } from '../../providers/wavespeed-video.provider';
import { SeedreamLiteProvider } from '../../providers/seedream-lite.provider';
import { SeedreamProvider } from '../../providers/seedream.provider';
import { GptImageProvider } from '../../providers/gpt-image.provider';
import { DeepDeepProvider } from '../../providers/deepdeep.provider';
import { WavespeedAudioProvider } from '../../providers/wavespeed-audio.provider';
import { GenerationEventsService } from '../../generation-events.service';
import { PromptEnhancerService } from '../../../prompt-enhancer/prompt-enhancer.service';
import { ContentSafetyService } from '../../../content-safety/content-safety.service';
import {
  ContentSafetyError,
  MINOR_BLOCK_USER_MESSAGE,
} from '../../errors/content-safety.error';
import {
  CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
  GenerationFailureCode,
} from '../../errors/failure-reason';

/**
 * Bloqueio terminal (menor de idade, foto sem atestado) encerra a geração e CONCLUI o job: relançar faria o
 * BullMQ (attempts 2, backoff 30 s) mandar o mesmo prompt e as mesmas fotos ao provedor de novo.
 */

const GEN_ID = 'gen-1';
const USER_ID = 'user-1';
const CREDITS = 120;

const createPrisma = () => ({
  generation: {
    findUnique: jest.fn().mockResolvedValue({
      status: GenerationStatus.PROCESSING,
      modelUsed: 'modelo-da-geracao',
      prompt: 'prompt gravado',
      parameters: {},
    }),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  generationInputImage: {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
});

type PrismaMock = ReturnType<typeof createPrisma>;

/** Chamada do update que gravou FAILED (o markProcessingStarted também usa update). */
const failedUpdateOf = (prisma: PrismaMock) =>
  prisma.generation.update.mock.calls
    .map(([arg]) => arg as { data: Record<string, unknown> })
    .find((arg) => arg.data.status === GenerationStatus.FAILED);

const imageJob = (overrides: Record<string, unknown> = {}): Job =>
  ({
    id: 'job-1',
    name: GenerationJobName.IMAGE,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      generationId: GEN_ID,
      userId: USER_ID,
      creditsConsumed: CREDITS,
      usedFreeGeneration: false,
      prompt: 'mulher adulta na praia',
      model: 'gpt-image-2',
      resolution: 'RES_2K',
      aspectRatio: '1:1',
      hasInputImages: false,
      ...overrides,
    },
  }) as unknown as Job;

const grokJob = (overrides: Record<string, unknown> = {}): Job =>
  ({
    id: 'job-2',
    name: GenerationJobName.IMAGE_TO_VIDEO_GROK,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      generationId: GEN_ID,
      userId: USER_ID,
      creditsConsumed: CREDITS,
      usedFreeGeneration: false,
      prompt: 'caminhando na praia',
      resolution: '720p',
      durationSeconds: 6,
      imageUrls: ['https://cdn.test/foto.png'],
      ...overrides,
    },
  }) as unknown as Job;

describe('GenerationProcessor · bloqueio de segurança sem nova tentativa', () => {
  let processor: GenerationProcessor;
  let prisma: PrismaMock;
  let credits: { refund: jest.Mock; refundFreeGeneration: jest.Mock };
  let events: { emit: jest.Mock };
  let contentSafety: { record: jest.Mock; hasConsentForGeneration: jest.Mock };
  let promptEnhancer: { refinePromptForSafety: jest.Mock };
  let gptImage: { generateImage: jest.Mock };
  let seedream: { generateImage: jest.Mock };
  let grok: { generateImageToVideo: jest.Mock; generateTextToVideo: jest.Mock };
  let completeGeneration: jest.SpyInstance;

  beforeEach(async () => {
    prisma = createPrisma();
    credits = {
      refund: jest.fn().mockResolvedValue(undefined),
      refundFreeGeneration: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };
    contentSafety = {
      record: jest.fn().mockResolvedValue('evt-1'),
      hasConsentForGeneration: jest.fn().mockResolvedValue(false),
    };
    promptEnhancer = { refinePromptForSafety: jest.fn() };
    gptImage = { generateImage: jest.fn() };
    seedream = { generateImage: jest.fn() };
    grok = { generateImageToVideo: jest.fn(), generateTextToVideo: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditsService, useValue: credits },
        {
          provide: UploadsService,
          useValue: { deleteByPrefix: jest.fn().mockResolvedValue(0) },
        },
        { provide: TheaimodelabProvider, useValue: {} },
        { provide: NanoBananaProvider, useValue: {} },
        { provide: WanProvider, useValue: {} },
        { provide: FaceSwapProvider, useValue: {} },
        { provide: VeoProvider, useValue: {} },
        { provide: GrokImagineProvider, useValue: grok },
        { provide: GeminiOmniVideoProvider, useValue: {} },
        { provide: BytedanceSeedanceProvider, useValue: {} },
        { provide: KlingProvider, useValue: {} },
        { provide: ComfyDeployProvider, useValue: {} },
        { provide: WavespeedVideoProvider, useValue: {} },
        { provide: SeedreamLiteProvider, useValue: {} },
        { provide: SeedreamProvider, useValue: seedream },
        { provide: GptImageProvider, useValue: gptImage },
        { provide: DeepDeepProvider, useValue: {} },
        { provide: WavespeedAudioProvider, useValue: {} },
        { provide: GenerationEventsService, useValue: events },
        { provide: PromptEnhancerService, useValue: promptEnhancer },
        { provide: ContentSafetyService, useValue: contentSafety },
      ],
    }).compile();

    processor = moduleRef.get(GenerationProcessor);
    // a conclusão (upload, galeria, SSE de sucesso) não é o assunto aqui
    completeGeneration = jest
      .spyOn(processor as any, 'completeGeneration')
      .mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('recusa por MENOR de idade', () => {
    it('provedor com filtro recusa: encerra com CONTENT_POLICY_MINOR, estorna, registra 1 MINOR_BLOCKED e não vai ao Unlocked', async () => {
      gptImage.generateImage.mockRejectedValue(
        new ContentSafetyError('Request blocked (support code: 58061214)'),
      );

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
        errorMessage: MINOR_BLOCK_USER_MESSAGE,
      });
      expect(credits.refund).toHaveBeenCalledWith(USER_ID, CREDITS, GEN_ID);
      expect(contentSafety.record).toHaveBeenCalledTimes(1);
      expect(contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          kind: ContentSafetyEventKind.MINOR_BLOCKED,
          route: 'provider:gpt-image-2',
          match: '58061214',
          generationId: GEN_ID,
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          data: expect.objectContaining({
            errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
          }),
        }),
      );
    });

    it('o próprio Unlocked (modelo sem censura direto) recusa: não volta para a fila', async () => {
      seedream.generateImage.mockRejectedValue(
        new ContentSafetyError('Image flagged: sexual/minors'),
      );

      await expect(
        processor.process(imageJob({ model: 'sem-censura' })),
      ).resolves.toBeUndefined();

      expect(seedream.generateImage).toHaveBeenCalledTimes(1);
      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.CONTENT_POLICY_MINOR,
      );
      expect(contentSafety.record).toHaveBeenCalledTimes(1);
      expect(contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({ route: 'provider:sem-censura' }),
      );
    });

    it('o Unlocked do fallback recusa por menor depois de um bloqueio comum: encerra, registrado como sem-censura', async () => {
      gptImage.generateImage.mockRejectedValue(
        new ContentSafetyError(
          'Your request was rejected by the safety system',
        ),
      );
      seedream.generateImage.mockRejectedValue(
        new ContentSafetyError('Sexual content involving a minor.'),
      );

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(seedream.generateImage).toHaveBeenCalledTimes(1);
      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.CONTENT_POLICY_MINOR,
      );
      expect(contentSafety.record).toHaveBeenCalledTimes(1);
      expect(contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({ route: 'provider:sem-censura' }),
      );
    });

    it("alvo 'same_provider': menor para antes de reescrever o prompt", async () => {
      grok.generateImageToVideo.mockRejectedValue(
        new ContentSafetyError('The image appears to contain a child'),
      );

      await expect(processor.process(grokJob())).resolves.toBeUndefined();

      expect(promptEnhancer.refinePromptForSafety).not.toHaveBeenCalled();
      expect(grok.generateImageToVideo).toHaveBeenCalledTimes(1);
      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.CONTENT_POLICY_MINOR,
      );
      expect(contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({ route: 'provider:grok-imagine' }),
      );
    });

    it('a nova tentativa com o prompt reescrito é recusada por menor: encerra sem voltar para a fila', async () => {
      grok.generateImageToVideo
        .mockRejectedValueOnce(
          new ContentSafetyError('content policy violation'),
        )
        .mockRejectedValueOnce(
          new ContentSafetyError('flagged: sexual/minors'),
        );
      promptEnhancer.refinePromptForSafety.mockResolvedValue(
        'caminhando na praia, vestida',
      );

      await expect(processor.process(grokJob())).resolves.toBeUndefined();

      expect(grok.generateImageToVideo).toHaveBeenCalledTimes(2);
      expect(failedUpdateOf(prisma)?.data).toEqual(
        expect.objectContaining({
          errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
          errorMessage: MINOR_BLOCK_USER_MESSAGE,
        }),
      );
      expect(contentSafety.record).toHaveBeenCalledTimes(1);
      // o job do Grok não traz o modelo: a trilha usa o da geração
      expect(contentSafety.record).toHaveBeenCalledWith(
        expect.objectContaining({
          route: 'provider:modelo-da-geracao',
          excerpt: 'prompt gravado',
        }),
      );
    });

    it('o encerramento falha no estorno: o job ainda conclui (sem reenvio ao provedor)', async () => {
      gptImage.generateImage.mockRejectedValue(
        new ContentSafetyError('Request blocked (support code: 17301594)'),
      );
      credits.refund.mockRejectedValue(new Error('banco fora'));

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(gptImage.generateImage).toHaveBeenCalledTimes(1);
      expect(prisma.generation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GEN_ID, status: GenerationStatus.PROCESSING },
        }),
      );
    });

    it('o encerramento nem grava o FAILED: a reserva marca FAILED se ainda estiver PROCESSING e avisa o site', async () => {
      gptImage.generateImage.mockRejectedValue(
        new ContentSafetyError('Request blocked (support code: 58061214)'),
      );
      prisma.generation.update.mockImplementation(
        (arg: { data: Record<string, unknown> }) =>
          arg.data.status === GenerationStatus.FAILED
            ? Promise.reject(new Error('banco fora'))
            : Promise.resolve({}),
      );
      prisma.generation.updateMany.mockResolvedValue({ count: 1 });

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(prisma.generation.updateMany).toHaveBeenCalledWith({
        where: { id: GEN_ID, status: GenerationStatus.PROCESSING },
        data: {
          status: GenerationStatus.FAILED,
          errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
          errorMessage: MINOR_BLOCK_USER_MESSAGE,
        },
      });
      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({ generationId: GEN_ID, status: 'failed' }),
      );
    });
  });

  describe('foto do usuário e o atestado de imagem', () => {
    beforeEach(() => {
      prisma.generationInputImage.findMany.mockResolvedValue([
        { url: 'https://cdn.test/foto.png' },
      ]);
      prisma.generationInputImage.count.mockResolvedValue(1);
      gptImage.generateImage.mockRejectedValue(
        new ContentSafetyError(
          'Your request was rejected by the safety system',
        ),
      );
    });

    it("alvo 'uncensored' sem atestado: CONTENT_BLOCKED_NEEDS_CONSENT, estorna, sem Unlocked e sem nova tentativa", async () => {
      await expect(
        processor.process(imageJob({ hasInputImages: true })),
      ).resolves.toBeUndefined();

      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
        errorMessage: CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
      });
      expect(credits.refund).toHaveBeenCalledWith(USER_ID, CREDITS, GEN_ID);
      expect(contentSafety.record).not.toHaveBeenCalled();
    });

    it("alvo 'uncensored' com atestado: segue para o Unlocked com a foto", async () => {
      contentSafety.hasConsentForGeneration.mockResolvedValue(true);
      seedream.generateImage.mockResolvedValue({
        outputUrls: ['https://cdn.test/saida.png'],
        modelUsed: 'seedream',
      });

      await expect(
        processor.process(imageJob({ hasInputImages: true })),
      ).resolves.toBeUndefined();

      expect(seedream.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ imageUrls: ['https://cdn.test/foto.png'] }),
      );
      expect(completeGeneration).toHaveBeenCalled();
      expect(failedUpdateOf(prisma)).toBeUndefined();
    });

    it("alvo 'same_provider' sem atestado: refaz com o prompt reescrito no mesmo provedor (nem consulta o atestado)", async () => {
      grok.generateImageToVideo
        .mockRejectedValueOnce(
          new ContentSafetyError('content policy violation'),
        )
        .mockResolvedValueOnce({
          outputUrls: ['https://cdn.test/video.mp4'],
          modelUsed: 'grok',
        });
      promptEnhancer.refinePromptForSafety.mockResolvedValue(
        'caminhando na praia, vestida',
      );

      await expect(processor.process(grokJob())).resolves.toBeUndefined();

      expect(grok.generateImageToVideo).toHaveBeenCalledTimes(2);
      expect(grok.generateImageToVideo).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: 'caminhando na praia, vestida' }),
      );
      expect(contentSafety.hasConsentForGeneration).not.toHaveBeenCalled();
      expect(completeGeneration).toHaveBeenCalled();
      expect(failedUpdateOf(prisma)).toBeUndefined();
    });
  });

  it('falha comum continua relançando (o retry do BullMQ segue valendo)', async () => {
    gptImage.generateImage.mockRejectedValue(
      new Error('Internal server error'),
    );

    await expect(processor.process(imageJob())).rejects.toThrow(
      'Internal server error',
    );
    expect(failedUpdateOf(prisma)).toBeUndefined();
    expect(credits.refund).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    const failedJob = (extra: Record<string, unknown>): Job =>
      Object.assign(imageJob(), extra) as Job;

    it('falha definitiva com tentativas sobrando (UnrecoverableError, job descartado: finishedOn) encerra a geração', async () => {
      await processor.onFailed(
        failedJob({ attemptsMade: 1, finishedOn: Date.now() }),
        new Error('Internal server error'),
      );

      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.PROVIDER_ERROR,
      );
      expect(credits.refund).toHaveBeenCalledWith(USER_ID, CREDITS, GEN_ID);
    });

    it('job que o BullMQ ainda vai repetir não encerra', async () => {
      await processor.onFailed(
        failedJob({ attemptsMade: 1 }),
        new Error('Internal server error'),
      );

      expect(failedUpdateOf(prisma)).toBeUndefined();
      expect(credits.refund).not.toHaveBeenCalled();
    });

    it('encerramento que lança não deixa a geração PROCESSING', async () => {
      prisma.generation.update.mockRejectedValue(new Error('banco fora'));
      prisma.generation.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        processor.onFailed(
          failedJob({ attemptsMade: 2, finishedOn: Date.now() }),
          new Error('Internal server error'),
        ),
      ).resolves.toBeUndefined();

      expect(prisma.generation.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: GEN_ID, status: GenerationStatus.PROCESSING },
          data: expect.objectContaining({ status: GenerationStatus.FAILED }),
        }),
      );
    });
  });
});

describe('willBeRetried', () => {
  it.each([
    [{ attemptsMade: 1, opts: { attempts: 2 } }, true],
    [{ attemptsMade: 2, opts: { attempts: 2 } }, false],
    [
      { attemptsMade: 1, opts: { attempts: 2 }, finishedOn: 1_760_000_000_000 },
      false,
    ],
    [{ attemptsMade: 1, opts: {} }, false],
  ])('%j → %s', (job, expected) => {
    expect(willBeRetried(job as unknown as Job)).toBe(expected);
  });
});
