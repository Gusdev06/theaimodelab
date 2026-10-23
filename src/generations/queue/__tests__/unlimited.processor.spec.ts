import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { GenerationStatus } from '@prisma/client';
import { UnlimitedProcessor } from '../unlimited.processor';
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
import {
  ConsentRequiredSafetyError,
  ContentSafetyError,
  MINOR_BLOCK_USER_MESSAGE,
  MinorSafetyBlockError,
  UnverifiedContentBlockError,
} from '../../errors/content-safety.error';
import {
  CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
  CONTENT_BLOCKED_USER_MESSAGE,
  GenerationFailureCode,
} from '../../errors/failure-reason';

/**
 * O modo ilimitado usa o mesmo dispatcher do GenerationProcessor. Bloqueio terminal (menor, foto sem atestado)
 * encerra a geração sem nova tentativa, sem estorno (o ilimitado não debita) e com o texto para o usuário, nunca o
 * texto cru do provedor.
 */

const GEN_ID = 'gen-u1';
const USER_ID = 'user-u1';

const job = (extra: Record<string, unknown> = {}): Job =>
  ({
    id: 'job-u1',
    name: GenerationJobName.IMAGE,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      generationId: GEN_ID,
      userId: USER_ID,
      creditsConsumed: 0,
      prompt: 'mulher adulta na praia',
      model: 'gpt-image-2',
      hasInputImages: false,
    },
    ...extra,
  }) as unknown as Job;

describe('UnlimitedProcessor · bloqueio de segurança', () => {
  let processor: UnlimitedProcessor;
  let prisma: {
    generation: { findUnique: jest.Mock; update: jest.Mock };
  };
  let generationProcessor: {
    dispatch: jest.Mock;
    terminalSafetyBlockOf: jest.Mock;
    recordProviderMinorBlock: jest.Mock;
    failStuckGeneration: jest.Mock;
  };
  let unlimitedService: { releaseLock: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(() => {
    prisma = {
      generation: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: GenerationStatus.PROCESSING }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    generationProcessor = {
      dispatch: jest.fn(),
      terminalSafetyBlockOf: jest.fn().mockReturnValue(null),
      recordProviderMinorBlock: jest.fn().mockResolvedValue(undefined),
      failStuckGeneration: jest.fn().mockResolvedValue(undefined),
    };
    unlimitedService = { releaseLock: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };
    processor = new UnlimitedProcessor(
      prisma as any,
      generationProcessor as any,
      unlimitedService as any,
      events as any,
    );
  });

  it('recusa por menor: encerra sem nova tentativa, texto de menor, 1 MINOR_BLOCKED e nada de estorno', async () => {
    const minor = new MinorSafetyBlockError(
      new ContentSafetyError('Request blocked (support code: 58061214)'),
      'gpt-image-2',
    );
    generationProcessor.dispatch.mockRejectedValue(minor);
    generationProcessor.terminalSafetyBlockOf.mockReturnValue(minor);

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(prisma.generation.update).toHaveBeenCalledWith({
      where: { id: GEN_ID },
      data: {
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
        errorMessage: MINOR_BLOCK_USER_MESSAGE,
      },
    });
    expect(generationProcessor.recordProviderMinorBlock).toHaveBeenCalledTimes(
      1,
    );
    expect(generationProcessor.recordProviderMinorBlock).toHaveBeenCalledWith(
      GEN_ID,
      USER_ID,
      minor,
    );
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        data: expect.objectContaining({ creditsRefunded: 0 }),
      }),
    );
  });

  it('foto sem atestado: CONTENT_BLOCKED_NEEDS_CONSENT sem nova tentativa', async () => {
    const blocked = new ConsentRequiredSafetyError(
      new ContentSafetyError('content policy violation'),
      'gpt-image-2',
    );
    generationProcessor.dispatch.mockRejectedValue(blocked);
    generationProcessor.terminalSafetyBlockOf.mockReturnValue(blocked);

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(prisma.generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
          errorMessage: CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
        }),
      }),
    );
    expect(generationProcessor.recordProviderMinorBlock).not.toHaveBeenCalled();
  });

  it('foto sem checagem limpa da imagem: CONTENT_SAFETY_BLOCKED genérico, sem nova tentativa nem MINOR_BLOCKED', async () => {
    const blocked = new UnverifiedContentBlockError(
      new ContentSafetyError('content policy violation'),
      'gpt-image-2',
      'unverified_media',
    );
    generationProcessor.dispatch.mockRejectedValue(blocked);
    generationProcessor.terminalSafetyBlockOf.mockReturnValue(blocked);

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(prisma.generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
          errorMessage: CONTENT_BLOCKED_USER_MESSAGE,
        }),
      }),
    );
    expect(generationProcessor.recordProviderMinorBlock).not.toHaveBeenCalled();
  });

  it('encerramento do bloqueio que falha não relança (sem reenvio) e cai na reserva', async () => {
    const minor = new MinorSafetyBlockError(
      'flagged: sexual/minors',
      'gpt-image-2',
    );
    generationProcessor.dispatch.mockRejectedValue(minor);
    generationProcessor.terminalSafetyBlockOf.mockReturnValue(minor);
    prisma.generation.update.mockRejectedValue(new Error('banco fora'));

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(generationProcessor.failStuckGeneration).toHaveBeenCalledWith(
      GEN_ID,
      USER_ID,
      minor,
    );
  });

  it('falha comum relança (o retry do BullMQ segue valendo)', async () => {
    generationProcessor.dispatch.mockRejectedValue(
      new Error('Internal server error'),
    );

    await expect(processor.process(job())).rejects.toThrow(
      'Internal server error',
    );
    expect(prisma.generation.update).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    it('texto cru de menor no fim das tentativas: mostra o texto de menor, registra MINOR_BLOCKED e solta o lock', async () => {
      const raw = new ContentSafetyError('Image flagged: sexual/minors');

      await processor.onFailed(
        job({ attemptsMade: 2, finishedOn: Date.now() }),
        raw,
      );

      expect(prisma.generation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
            errorMessage: MINOR_BLOCK_USER_MESSAGE,
          }),
        }),
      );
      expect(
        generationProcessor.recordProviderMinorBlock,
      ).toHaveBeenCalledTimes(1);
      expect(unlimitedService.releaseLock).toHaveBeenCalledWith(USER_ID);
    });

    it('falha definitiva antes da última tentativa (finishedOn) encerra e solta o lock', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1, finishedOn: Date.now() }),
        new Error('Internal server error'),
      );

      expect(prisma.generation.update).toHaveBeenCalled();
      expect(unlimitedService.releaseLock).toHaveBeenCalledWith(USER_ID);
    });

    it('job que ainda vai ser repetido não encerra nem solta o lock', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1 }),
        new Error('Internal server error'),
      );

      expect(prisma.generation.update).not.toHaveBeenCalled();
      expect(unlimitedService.releaseLock).not.toHaveBeenCalled();
    });

    it('encerramento que lança: reserva marca FAILED e o lock sai do mesmo jeito', async () => {
      prisma.generation.update.mockRejectedValue(new Error('banco fora'));

      await expect(
        processor.onFailed(
          job({ attemptsMade: 2, finishedOn: Date.now() }),
          new Error('Internal server error'),
        ),
      ).resolves.toBeUndefined();

      expect(generationProcessor.failStuckGeneration).toHaveBeenCalled();
      expect(unlimitedService.releaseLock).toHaveBeenCalledWith(USER_ID);
    });
  });
});

/**
 * Pela fila ilimitada, com o GenerationProcessor de verdade: a recusa do filtro num pedido com foto segue a mesma regra
 * do fluxo normal. Porteiro de imagem desligado (padrão): foto atestada cai no Unlocked como antes. Ligado (shadow ou
 * enforce): sem checagem limpa, encerra sem desvio. Menor encerra nos dois modos.
 */
describe('UnlimitedProcessor · desvio depois da recusa, pelo modo do porteiro de imagem', () => {
  let processor: UnlimitedProcessor;
  let prisma: {
    generation: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    generationInputImage: {
      findMany: jest.Mock;
      count: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let contentSafety: {
    record: jest.Mock;
    hasConsentForGeneration: jest.Mock;
    preflightStatusForGeneration: jest.Mock;
    enforcesMediaPreflight: jest.Mock;
  };
  let gptImage: { generateImage: jest.Mock };
  let seedream: { generateImage: jest.Mock };
  let events: { emit: jest.Mock };
  let completeGeneration: jest.SpyInstance;

  const photoJob = (): Job =>
    ({
      id: 'job-u2',
      name: GenerationJobName.IMAGE,
      attemptsMade: 0,
      opts: { attempts: 2 },
      data: {
        generationId: GEN_ID,
        userId: USER_ID,
        creditsConsumed: 0,
        prompt: 'mulher adulta na praia',
        model: 'gpt-image-2',
        resolution: 'RES_2K',
        aspectRatio: '1:1',
        hasInputImages: true,
      },
    }) as unknown as Job;

  /** Chamada do update que gravou FAILED (o markProcessingStarted também usa update). */
  const failedUpdate = () =>
    prisma.generation.update.mock.calls
      .map(([arg]) => arg as { data: Record<string, unknown> })
      .find((arg) => arg.data.status === GenerationStatus.FAILED);

  beforeEach(async () => {
    prisma = {
      generation: {
        findUnique: jest.fn().mockResolvedValue({
          status: GenerationStatus.PROCESSING,
          modelUsed: 'gpt-image-2',
          prompt: 'mulher adulta na praia',
          parameters: {},
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      generationInputImage: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ url: 'https://cdn.test/foto.png' }]),
        count: jest.fn().mockResolvedValue(1),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    contentSafety = {
      record: jest.fn().mockResolvedValue('evt-1'),
      // foto atestada: o que a regra de antes da checagem pede para o Unlocked
      hasConsentForGeneration: jest.fn().mockResolvedValue(true),
      preflightStatusForGeneration: jest.fn().mockResolvedValue('unavailable'),
      enforcesMediaPreflight: jest.fn().mockReturnValue(false),
    };
    gptImage = {
      generateImage: jest
        .fn()
        .mockRejectedValue(
          new ContentSafetyError(
            'Your request was rejected by the safety system',
          ),
        ),
    };
    seedream = {
      generateImage: jest.fn().mockResolvedValue({
        outputUrls: ['https://cdn.test/saida.png'],
        modelUsed: 'seedream',
      }),
    };
    events = { emit: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationProcessor,
        { provide: PrismaService, useValue: prisma },
        {
          provide: CreditsService,
          useValue: {
            refund: jest.fn().mockResolvedValue(undefined),
            refundFreeGeneration: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: UploadsService,
          useValue: {
            deleteByPrefix: jest.fn().mockResolvedValue(0),
            refreshInputReadUrl: jest.fn(async (url: string) => url),
          },
        },
        { provide: TheaimodelabProvider, useValue: {} },
        { provide: NanoBananaProvider, useValue: {} },
        { provide: WanProvider, useValue: {} },
        { provide: FaceSwapProvider, useValue: {} },
        { provide: VeoProvider, useValue: {} },
        { provide: GrokImagineProvider, useValue: {} },
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
        {
          provide: PromptEnhancerService,
          useValue: { refinePromptForSafety: jest.fn() },
        },
        { provide: ContentSafetyService, useValue: contentSafety },
      ],
    }).compile();

    const generationProcessor = moduleRef.get(GenerationProcessor);
    // a conclusão (upload, galeria, SSE de sucesso) não é o assunto aqui
    completeGeneration = jest
      .spyOn(generationProcessor as any, 'completeGeneration')
      .mockResolvedValue(undefined);
    processor = new UnlimitedProcessor(
      prisma as any,
      generationProcessor,
      { releaseLock: jest.fn().mockResolvedValue(undefined) } as any,
      events as any,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('desligado (off, padrão): foto atestada sem checagem cai no Unlocked com a foto, como antes', async () => {
    await expect(processor.process(photoJob())).resolves.toBeUndefined();

    expect(seedream.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: ['https://cdn.test/foto.png'] }),
    );
    expect(contentSafety.preflightStatusForGeneration).not.toHaveBeenCalled();
    expect(completeGeneration).toHaveBeenCalled();
    expect(failedUpdate()).toBeUndefined();
  });

  it('desligado (off, padrão): foto sem atestado encerra pedindo o atestado, sem Unlocked', async () => {
    contentSafety.hasConsentForGeneration.mockResolvedValue(false);

    await expect(processor.process(photoJob())).resolves.toBeUndefined();

    expect(seedream.generateImage).not.toHaveBeenCalled();
    expect(failedUpdate()?.data).toEqual({
      status: GenerationStatus.FAILED,
      errorCode: GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
      errorMessage: CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
    });
  });

  it.each(['gray', 'flagged', 'unavailable'] as const)(
    "ligado (shadow ou enforce), checagem '%s': CONTENT_SAFETY_BLOCKED genérico, sem Unlocked e sem estorno",
    async (preflight) => {
      contentSafety.enforcesMediaPreflight.mockReturnValue(true);
      contentSafety.preflightStatusForGeneration.mockResolvedValue(preflight);

      await expect(processor.process(photoJob())).resolves.toBeUndefined();

      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(contentSafety.preflightStatusForGeneration).toHaveBeenCalledWith(
        GEN_ID,
        'uncensored',
      );
      expect(failedUpdate()?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
        errorMessage: CONTENT_BLOCKED_USER_MESSAGE,
      });
      expect(events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          data: expect.objectContaining({ creditsRefunded: 0 }),
        }),
      );
      expect(contentSafety.record).not.toHaveBeenCalled();
    },
  );

  it("ligado (shadow ou enforce), checagem 'clean' e atestado: segue para o Unlocked", async () => {
    contentSafety.enforcesMediaPreflight.mockReturnValue(true);
    contentSafety.preflightStatusForGeneration.mockResolvedValue('clean');

    await expect(processor.process(photoJob())).resolves.toBeUndefined();

    expect(seedream.generateImage).toHaveBeenCalledTimes(1);
    expect(failedUpdate()).toBeUndefined();
  });

  it.each([false, true])(
    'recusa por menor com foto atestada (porteiro ligado=%s): encerra como menor, sem Unlocked',
    async (enforce) => {
      contentSafety.enforcesMediaPreflight.mockReturnValue(enforce);
      contentSafety.preflightStatusForGeneration.mockResolvedValue('clean');
      gptImage.generateImage.mockRejectedValue(
        new ContentSafetyError('Request blocked (support code: 58061214)'),
      );

      await expect(processor.process(photoJob())).resolves.toBeUndefined();

      expect(seedream.generateImage).not.toHaveBeenCalled();
      expect(failedUpdate()?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
        errorMessage: MINOR_BLOCK_USER_MESSAGE,
      });
      expect(contentSafety.record).toHaveBeenCalledTimes(1);
    },
  );
});
