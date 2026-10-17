import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DelayedError, type Job } from 'bullmq';
import { GenerationStatus } from '@prisma/client';
import { GenerationProcessor } from '../generation.processor';
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
import { ImageSafetyService } from '../../../content-safety/image-safety/image-safety.service';
import { loadImageSafetyConfig } from '../../../content-safety/image-safety/image-safety.config';
import { NoopKnownHashMatcher } from '../../../content-safety/image-safety/known-csam.matcher';
import { NoopStylizedJudge } from '../../../content-safety/image-safety/stylized-judge.client';
import {
  ContentSafetyError,
  InputImageSafetyBlockError,
  OutputImageSafetyBlockError,
  SafetyCheckPendingError,
  SafetyCheckUnavailableError,
  UnverifiedContentBlockError,
} from '../../errors/content-safety.error';
import {
  GenerationFailureCode,
  IMAGE_SAFETY_BLOCKED_MESSAGE,
  SAFETY_CHECK_UNAVAILABLE_MESSAGE,
} from '../../errors/failure-reason';

/**
 * Ganchos da segurança de imagem no processor: preflight antes do 1º provedor (fila e run*Directly), espera na fila
 * quando a checagem cai, checagem da saída dentro do completeGeneration sem lançar (nenhum desvio regera) e o
 * encerramento das gerações seguradas. O serviço de segurança é simulado; com os modos off ele é o de verdade.
 */

const GEN = 'gen-1';
const USER = 'user-1';
const CREDITS = 120;
const PROVIDER_URL = `https://cdn.test/generations/${GEN}/q/output_0.png`;
const PUBLIC_URL = `https://cdn.test/generations/${GEN}/pub/output_0.png`;

function createPrisma(
  initialStatus: GenerationStatus = GenerationStatus.PROCESSING,
) {
  const state = { status: initialStatus as GenerationStatus };
  return {
    state,
    generation: {
      findUnique: jest.fn(async () => ({
        status: state.status,
        type: 'TEXT_TO_IMAGE',
        quantity: 1,
        creditsConsumed: CREDITS,
        usedFreeGeneration: false,
        userId: USER,
        user: { isActive: true },
        modelUsed: 'modelo-da-geracao',
        prompt: 'prompt gravado',
        parameters: {},
      })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        if (typeof args.data.status === 'string') {
          state.status = args.data.status as GenerationStatus;
        }
        return { userId: USER };
      }),
      updateMany: jest.fn(
        async (args: {
          where: { status?: GenerationStatus };
          data: { status?: GenerationStatus };
        }) => {
          if (args.where.status && args.where.status !== state.status) {
            return { count: 0 };
          }
          if (args.data.status) state.status = args.data.status;
          return { count: 1 };
        },
      ),
    },
    generationInputImage: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    generationOutput: { createMany: jest.fn(async () => ({ count: 1 })) },
    subscription: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
  };
}

type PrismaMock = ReturnType<typeof createPrisma>;

const failedUpdateOf = (prisma: PrismaMock) =>
  prisma.generation.update.mock.calls
    .map(([arg]) => arg as { data: Record<string, unknown> })
    .find((arg) => arg.data.status === GenerationStatus.FAILED);

const imageJob = (
  overrides: Record<string, unknown> = {},
  name: string = GenerationJobName.IMAGE,
): Job =>
  ({
    id: 'job-1',
    name,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      generationId: GEN,
      userId: USER,
      creditsConsumed: CREDITS,
      usedFreeGeneration: false,
      prompt: 'mulher adulta na praia',
      model: 'gpt-image-2',
      resolution: 'RES_2K',
      aspectRatio: '1:1',
      hasInputImages: false,
      ...overrides,
    },
    updateData: jest.fn(async () => undefined),
    moveToDelayed: jest.fn(async () => undefined),
  }) as unknown as Job;

describe('GenerationProcessor · segurança de imagem (preflight e saída)', () => {
  let processor: GenerationProcessor;
  let prisma: PrismaMock;
  let credits: { refund: jest.Mock; refundFreeGeneration: jest.Mock };
  let events: { emit: jest.Mock };
  let contentSafety: {
    record: jest.Mock;
    hasConsentForGeneration: jest.Mock;
    preflightStatusForGeneration: jest.Mock;
  };
  let promptEnhancer: { refinePromptForSafety: jest.Mock };
  let gptImage: { generateImage: jest.Mock };
  let seedream: { generateImage: jest.Mock };
  let theaimodelab: { generateImage: jest.Mock };
  let nanoBanana: { generateImage: jest.Mock };
  let grok: { generateTextToVideo: jest.Mock; generateImageToVideo: jest.Mock };
  let uploads: Record<string, jest.Mock>;
  let imageSafety: {
    preflight: jest.Mock;
    checkOutput: jest.Mock;
    checkRefinedPrompt: jest.Mock;
    discardFailedOutputs: jest.Mock;
  };

  async function build(safety: unknown = imageSafety) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditsService, useValue: credits },
        { provide: UploadsService, useValue: uploads },
        { provide: TheaimodelabProvider, useValue: theaimodelab },
        { provide: NanoBananaProvider, useValue: nanoBanana },
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
        { provide: ImageSafetyService, useValue: safety },
      ],
    }).compile();
    processor = moduleRef.get(GenerationProcessor);
  }

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // o blur da imagem baixa a saída: nada de rede no teste
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false } as unknown as Response);
    prisma = createPrisma();
    credits = {
      refund: jest.fn().mockResolvedValue(undefined),
      refundFreeGeneration: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };
    contentSafety = {
      record: jest.fn().mockResolvedValue('evt-1'),
      hasConsentForGeneration: jest.fn().mockResolvedValue(false),
      preflightStatusForGeneration: jest.fn().mockResolvedValue('unavailable'),
    };
    promptEnhancer = { refinePromptForSafety: jest.fn() };
    gptImage = {
      generateImage: jest
        .fn()
        .mockResolvedValue({
          outputUrls: [PROVIDER_URL],
          modelUsed: 'gpt-image-2',
        }),
    };
    seedream = { generateImage: jest.fn() };
    theaimodelab = {
      generateImage: jest
        .fn()
        .mockResolvedValue({
          outputUrls: [PROVIDER_URL],
          modelUsed: 'gemini-3-pro-image',
        }),
    };
    nanoBanana = { generateImage: jest.fn() };
    grok = { generateTextToVideo: jest.fn(), generateImageToVideo: jest.fn() };
    uploads = {
      deleteByPrefix: jest.fn().mockResolvedValue(0),
      refreshInputReadUrl: jest.fn(async (url: string) => url),
      generateThumbnail: jest
        .fn()
        .mockResolvedValue('https://cdn.test/thumb.webp'),
      generateBlurDataUrl: jest
        .fn()
        .mockResolvedValue('data:image/webp;base64,x'),
      promoteFromQuarantine: jest.fn(),
    };
    imageSafety = {
      preflight: jest
        .fn()
        .mockResolvedValue({ action: 'proceed', status: 'clean' }),
      checkOutput: jest.fn(async (_id: string, urls: string[]) => ({
        action: 'promote',
        outputs: urls,
      })),
      checkRefinedPrompt: jest.fn().mockResolvedValue(null),
      discardFailedOutputs: jest.fn().mockResolvedValue(undefined),
    };
    await build();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('modo off = Onda 0', () => {
    it('com o serviço de verdade e tudo off: nenhuma leitura nova, saída publicada como veio, nada IN_REVIEW', async () => {
      const { config } = loadImageSafetyConfig(() => undefined);
      const realOff = new ImageSafetyService(
        config,
        prisma as never,
        uploads as never,
        contentSafety as never,
        {} as never,
        {} as never,
        new NoopKnownHashMatcher(),
        new NoopStylizedJudge(),
        {} as never,
        null,
      );
      await build(realOff);

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(gptImage.generateImage).toHaveBeenCalledTimes(1);
      expect(prisma.generationOutput.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ generationId: GEN, url: PROVIDER_URL }),
        ],
      });
      expect(prisma.state.status).toBe(GenerationStatus.COMPLETED);
      expect(uploads.promoteFromQuarantine).not.toHaveBeenCalled();
      expect(prisma.generation.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: GenerationStatus.IN_REVIEW }),
        }),
      );
    });
  });

  describe('preflight antes do 1º provedor', () => {
    it('entrada barrada: provedor nunca chamado; falha com o código genérico, estorno e SSE; nenhum MINOR_BLOCKED do processor', async () => {
      imageSafety.preflight.mockRejectedValue(
        new InputImageSafetyBlockError('E2', 'STRONG'),
      );

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(gptImage.generateImage).not.toHaveBeenCalled();
      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(imageSafety.preflight).toHaveBeenCalledWith(
        {
          name: GenerationJobName.IMAGE,
          data: expect.objectContaining({ generationId: GEN }),
        },
        { queued: true },
      );
      expect(failedUpdateOf(prisma)?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
        errorMessage: IMAGE_SAFETY_BLOCKED_MESSAGE,
      });
      expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, GEN);
      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          data: expect.objectContaining({
            errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
          }),
        }),
      );
      expect(contentSafety.record).not.toHaveBeenCalled();
    });

    it('segurada para revisão: o job conclui sem provedor, sem falha e sem estorno', async () => {
      imageSafety.preflight.mockResolvedValue({ action: 'held' });

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(gptImage.generateImage).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)).toBeUndefined();
      expect(credits.refund).not.toHaveBeenCalled();
    });

    it('checagem indisponível: volta à fila com espera (moveToDelayed + DelayedError), sem provedor', async () => {
      imageSafety.preflight.mockRejectedValue(
        new SafetyCheckPendingError('rekognition', 'timeout', 30_000, 1_000, 0),
      );
      const job = imageJob();
      const before = Date.now();

      await expect(processor.process(job, 'token-1')).rejects.toBeInstanceOf(
        DelayedError,
      );

      expect(job.updateData).toHaveBeenCalledWith(
        expect.objectContaining({
          generationId: GEN,
          safetyFirstAttemptAt: 1_000,
          safetyDeferrals: 1,
        }),
      );
      const [timestamp, token] = (job.moveToDelayed as jest.Mock).mock.calls[0];
      expect(token).toBe('token-1');
      expect(timestamp).toBeGreaterThanOrEqual(before + 30_000);
      expect(gptImage.generateImage).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)).toBeUndefined();
    });

    it('adiamento impossível: o erro pendente volta ao BullMQ; no fim, SAFETY_CHECK_UNAVAILABLE com estorno', async () => {
      const pending = new SafetyCheckPendingError(
        'rekognition',
        'timeout',
        30_000,
        1_000,
        0,
      );
      imageSafety.preflight.mockRejectedValue(pending);
      const job = imageJob();
      (job.moveToDelayed as jest.Mock).mockRejectedValue(
        new Error('Missing lock'),
      );

      await expect(processor.process(job)).rejects.toBe(pending);

      const finalJob = Object.assign(job, { attemptsMade: 2, finishedOn: 1 });
      await processor.onFailed(finalJob, pending);
      expect(failedUpdateOf(prisma)?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.SAFETY_CHECK_UNAVAILABLE,
        errorMessage: SAFETY_CHECK_UNAVAILABLE_MESSAGE,
      });
      expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, GEN);
    });

    it('run*Directly (Seedream direto, sem fila): checagem fora encerra na hora com estorno', async () => {
      imageSafety.preflight.mockRejectedValue(
        new SafetyCheckUnavailableError('rekognition', 'timeout'),
      );

      await processor.runImageJobDirectly(
        imageJob({ model: 'sem-censura' }).data,
      );

      expect(imageSafety.preflight).toHaveBeenCalledWith(
        expect.objectContaining({ name: GenerationJobName.IMAGE }),
        { queued: false },
      );
      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.SAFETY_CHECK_UNAVAILABLE,
      );
      expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, GEN);
    });
  });

  describe('checagem da saída dentro do completeGeneration', () => {
    it('promovida: as saídas gravadas e o SSE usam as URLs públicas', async () => {
      imageSafety.checkOutput.mockResolvedValue({
        action: 'promote',
        outputs: [PUBLIC_URL],
      });

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(imageSafety.checkOutput).toHaveBeenCalledWith(
        GEN,
        [PROVIDER_URL],
        expect.objectContaining({ modelUsed: 'gpt-image-2', provider: null }),
      );
      expect(prisma.generationOutput.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ url: PUBLIC_URL })],
      });
      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          data: expect.objectContaining({ outputUrls: [PUBLIC_URL] }),
        }),
      );
    });

    it('segurada: nada publicado, nenhuma miniatura, nenhuma falha', async () => {
      imageSafety.checkOutput.mockResolvedValue({ action: 'held' });

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(prisma.generationOutput.createMany).not.toHaveBeenCalled();
      expect(uploads.generateThumbnail).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)).toBeUndefined();
      expect(events.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('menor no resultado dentro do processImageWithFallback: nem Nano Banana nem Unlocked; falha com estorno', async () => {
      imageSafety.checkOutput.mockResolvedValue({
        action: 'blocked',
        error: new OutputImageSafetyBlockError('S1', 'STRONG'),
      });

      await expect(
        processor.process(
          imageJob(
            { model: 'gemini-3-pro-image' },
            GenerationJobName.IMAGE_WITH_FALLBACK,
          ),
        ),
      ).resolves.toBeUndefined();

      expect(theaimodelab.generateImage).toHaveBeenCalledTimes(1);
      expect(nanoBanana.generateImage).not.toHaveBeenCalled();
      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(prisma.generationOutput.createMany).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
      );
      expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, GEN);
    });

    it('bloqueio terminal que chega ao catch do provedor nunca vira desvio genérico', async () => {
      theaimodelab.generateImage.mockRejectedValue(
        new OutputImageSafetyBlockError('S6', 'STRONG'),
      );

      await expect(
        processor.process(
          imageJob(
            { model: 'gemini-3-pro-image' },
            GenerationJobName.IMAGE_WITH_FALLBACK,
          ),
        ),
      ).resolves.toBeUndefined();

      expect(nanoBanana.generateImage).not.toHaveBeenCalled();
      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
      );
    });
  });

  describe('gerações seguradas (cron da quarentena)', () => {
    it('completeHeldGeneration: só uma conclusão vence (IN_REVIEW → concluída)', async () => {
      prisma.state.status = GenerationStatus.IN_REVIEW;

      await expect(
        processor.completeHeldGeneration(GEN, [PUBLIC_URL], {
          modelUsed: 'gpt-image-2',
          provider: null,
          processingTimeMs: 3000,
        }),
      ).resolves.toBe(true);
      expect(prisma.generationOutput.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ url: PUBLIC_URL })],
      });
      expect(prisma.state.status).toBe(GenerationStatus.COMPLETED);

      await expect(
        processor.completeHeldGeneration(GEN, [PUBLIC_URL], {
          modelUsed: 'gpt-image-2',
          provider: null,
          processingTimeMs: 3000,
        }),
      ).resolves.toBe(false);
      expect(prisma.generationOutput.createMany).toHaveBeenCalledTimes(1);
    });

    it('failForSafety: segurada que venceu falha com estorno', async () => {
      prisma.state.status = GenerationStatus.IN_REVIEW;

      await processor.failForSafety(
        GEN,
        new SafetyCheckUnavailableError('quarentena', 'sem checagem no prazo'),
      );

      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.SAFETY_CHECK_UNAVAILABLE,
      );
      expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, GEN);
    });

    it('troca IN_REVIEW → PROCESSING grava safetyCheckedAt agora (o cron de presas não estorna junto)', async () => {
      prisma.state.status = GenerationStatus.IN_REVIEW;

      await processor.failForSafety(
        GEN,
        new SafetyCheckUnavailableError('quarentena', 'sem checagem no prazo'),
      );
      prisma.state.status = GenerationStatus.IN_REVIEW;
      await processor.completeHeldGeneration(GEN, [PUBLIC_URL], {
        modelUsed: 'gpt-image-2',
        provider: null,
        processingTimeMs: 3000,
      });

      const transitions = prisma.generation.updateMany.mock.calls
        .map(([arg]) => arg as { where: { status?: string }; data: Record<string, unknown> })
        .filter((arg) => arg.where.status === GenerationStatus.IN_REVIEW);
      expect(transitions).toHaveLength(2);
      for (const transition of transitions) {
        expect(transition.data).toEqual({
          status: GenerationStatus.PROCESSING,
          safetyCheckedAt: expect.any(Date),
        });
      }
    });

    it('failForSafety: quem perde a troca (outra réplica ou o revisor encerrou antes) não estorna de novo', async () => {
      prisma.state.status = GenerationStatus.FAILED;

      await processor.failForSafety(
        GEN,
        new SafetyCheckUnavailableError('quarentena', 'sem checagem no prazo'),
      );

      expect(failedUpdateOf(prisma)).toBeUndefined();
      expect(credits.refund).not.toHaveBeenCalled();
    });

    it('evidência pendente: o encerramento estorna mas NÃO apaga as entradas nem a sobra da quarentena', async () => {
      imageSafety.preflight.mockRejectedValue(
        new InputImageSafetyBlockError('E2', 'STRONG', {
          evidencePending: true,
        }),
      );

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, GEN);
      expect(uploads.deleteByPrefix).not.toHaveBeenCalled();
      expect(prisma.generationInputImage.deleteMany).not.toHaveBeenCalled();
      expect(imageSafety.discardFailedOutputs).not.toHaveBeenCalled();
    });

    it('falha comum: limpa as entradas e a sobra do resultado na quarentena', async () => {
      imageSafety.preflight.mockRejectedValue(
        new InputImageSafetyBlockError('E2', 'STRONG'),
      );

      await expect(processor.process(imageJob())).resolves.toBeUndefined();

      expect(uploads.deleteByPrefix).toHaveBeenCalledWith(`inputs/${GEN}/`);
      expect(imageSafety.discardFailedOutputs).toHaveBeenCalledWith(GEN);
    });

    it('falha comum de job não mexe numa geração segurada', async () => {
      prisma.state.status = GenerationStatus.IN_REVIEW;
      const job = Object.assign(imageJob(), { attemptsMade: 2, finishedOn: 1 });

      await processor.onFailed(job, new Error('Internal Error'));

      expect(failedUpdateOf(prisma)).toBeUndefined();
      expect(credits.refund).not.toHaveBeenCalled();
    });
  });

  it('refinador: reescrita acusada pelo leitor de sentido encerra sem reenviar nem gravar o prompt reescrito', async () => {
    grok.generateTextToVideo.mockRejectedValueOnce(
      new ContentSafetyError('content policy violation'),
    );
    promptEnhancer.refinePromptForSafety.mockResolvedValue(
      'caminhando na praia, vestida',
    );
    imageSafety.checkRefinedPrompt.mockResolvedValue(
      new UnverifiedContentBlockError(
        'refined prompt flagged',
        '',
        'refiner_flagged',
      ),
    );

    await expect(
      processor.process({
        ...imageJob(
          { resolution: '720p', durationSeconds: 6 },
          GenerationJobName.TEXT_TO_VIDEO_GROK,
        ),
      } as Job),
    ).resolves.toBeUndefined();

    expect(imageSafety.checkRefinedPrompt).toHaveBeenCalledWith(
      GEN,
      'caminhando na praia, vestida',
      '',
    );
    expect(grok.generateTextToVideo).toHaveBeenCalledTimes(1);
    expect(prisma.generation.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prompt: 'caminhando na praia, vestida',
        }),
      }),
    );
    expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
      GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
    );
  });
});
