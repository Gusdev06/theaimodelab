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
  CONTENT_BLOCKED_USER_MESSAGE,
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

/** Grok texto → vídeo: pedido só com texto (nenhuma mídia no job). */
const grokTextJob = (overrides: Record<string, unknown> = {}): Job =>
  ({
    id: 'job-3',
    name: GenerationJobName.TEXT_TO_VIDEO_GROK,
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
      ...overrides,
    },
  }) as unknown as Job;

/** Seedance com referência: o padrão é só o áudio enviado pela cliente (nenhuma foto nem vídeo). */
const seedanceJob = (overrides: Record<string, unknown> = {}): Job =>
  ({
    id: 'job-4',
    name: GenerationJobName.SEEDANCE_VIDEO,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      generationId: GEN_ID,
      userId: USER_ID,
      creditsConsumed: CREDITS,
      usedFreeGeneration: false,
      prompt: 'dançando na praia',
      resolution: '720p',
      durationSeconds: 5,
      referenceAudioUrls: ['https://cdn.test/voz.mp3'],
      generateAudio: true,
      hasVideoInput: false,
      ...overrides,
    },
  }) as unknown as Job;

/** URL assinada de uma entrada privada (o que vai para o job quando S3_INPUT_PRIVATE_BUCKET existe). */
const SIGNED_INPUT = (file: string) =>
  `https://s3.test/privado/inputs/${GEN_ID}/u/${file}?X-Amz-Expires=7200&X-Amz-Signature=assinatura-velha`;

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
  let contentSafety: {
    record: jest.Mock;
    hasConsentForGeneration: jest.Mock;
    preflightStatusForGeneration: jest.Mock;
  };
  let promptEnhancer: { refinePromptForSafety: jest.Mock };
  let gptImage: { generateImage: jest.Mock };
  let seedream: { generateImage: jest.Mock };
  let grok: { generateImageToVideo: jest.Mock; generateTextToVideo: jest.Mock };
  let seedance: { generateVideo: jest.Mock };
  let wan: { generateAnimateReplace: jest.Mock };
  let uploads: { deleteByPrefix: jest.Mock; refreshInputReadUrl: jest.Mock };
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
      // até o porteiro de imagem existir, o veredito é sempre 'unavailable'
      preflightStatusForGeneration: jest.fn().mockResolvedValue('unavailable'),
    };
    promptEnhancer = { refinePromptForSafety: jest.fn() };
    gptImage = { generateImage: jest.fn() };
    seedream = { generateImage: jest.fn() };
    grok = { generateImageToVideo: jest.fn(), generateTextToVideo: jest.fn() };
    seedance = { generateVideo: jest.fn() };
    wan = { generateAnimateReplace: jest.fn() };
    uploads = {
      deleteByPrefix: jest.fn().mockResolvedValue(0),
      // sem bucket privado a URL volta igual
      refreshInputReadUrl: jest.fn(async (url: string) => url),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GenerationProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditsService, useValue: credits },
        { provide: UploadsService, useValue: uploads },
        { provide: TheaimodelabProvider, useValue: {} },
        { provide: NanoBananaProvider, useValue: {} },
        { provide: WanProvider, useValue: wan },
        { provide: FaceSwapProvider, useValue: {} },
        { provide: VeoProvider, useValue: {} },
        { provide: GrokImagineProvider, useValue: grok },
        { provide: GeminiOmniVideoProvider, useValue: {} },
        { provide: BytedanceSeedanceProvider, useValue: seedance },
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
      // só texto: a reescrita no mesmo provedor só existe sem foto
      grok.generateTextToVideo
        .mockRejectedValueOnce(
          new ContentSafetyError('content policy violation'),
        )
        .mockRejectedValueOnce(
          new ContentSafetyError('flagged: sexual/minors'),
        );
      promptEnhancer.refinePromptForSafety.mockResolvedValue(
        'caminhando na praia, vestida',
      );

      await expect(processor.process(grokTextJob())).resolves.toBeUndefined();

      expect(grok.generateTextToVideo).toHaveBeenCalledTimes(2);
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

  describe('foto do usuário, atestado e checagem da imagem (desvio terminal com foto)', () => {
    const NOT_CLEAN = ['gray', 'flagged', 'unavailable'] as const;
    const ALL = ['clean', ...NOT_CLEAN] as const;

    const expectGenericTerminalBlock = () => {
      expect(failedUpdateOf(prisma)?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
        errorMessage: CONTENT_BLOCKED_USER_MESSAGE,
      });
      expect(credits.refund).toHaveBeenCalledWith(USER_ID, CREDITS, GEN_ID);
      expect(contentSafety.record).not.toHaveBeenCalled();
    };

    describe("alvo 'uncensored' (Unlocked com a foto)", () => {
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
        seedream.generateImage.mockResolvedValue({
          outputUrls: ['https://cdn.test/saida.png'],
          modelUsed: 'seedream',
        });
      });

      it.each(
        NOT_CLEAN.flatMap(
          (preflight) =>
            [
              [preflight, true],
              [preflight, false],
            ] as const,
        ),
      )(
        "com foto, checagem '%s', atestado=%s: CONTENT_SAFETY_BLOCKED, sem Unlocked e sem nova tentativa",
        async (preflight, consent) => {
          contentSafety.preflightStatusForGeneration.mockResolvedValue(
            preflight,
          );
          contentSafety.hasConsentForGeneration.mockResolvedValue(consent);

          await expect(
            processor.process(imageJob({ hasInputImages: true })),
          ).resolves.toBeUndefined();

          expect(seedream.generateImage).not.toHaveBeenCalled();
          // o desvio sem censura pede o veredito da entrada reavaliada como pedido sexual
          expect(
            contentSafety.preflightStatusForGeneration,
          ).toHaveBeenCalledWith(GEN_ID, 'uncensored');
          expectGenericTerminalBlock();
        },
      );

      it('com foto limpa e atestado: segue para o Unlocked com a foto', async () => {
        contentSafety.preflightStatusForGeneration.mockResolvedValue('clean');
        contentSafety.hasConsentForGeneration.mockResolvedValue(true);

        await expect(
          processor.process(imageJob({ hasInputImages: true })),
        ).resolves.toBeUndefined();

        expect(seedream.generateImage).toHaveBeenCalledWith(
          expect.objectContaining({ imageUrls: ['https://cdn.test/foto.png'] }),
        );
        expect(completeGeneration).toHaveBeenCalled();
        expect(failedUpdateOf(prisma)).toBeUndefined();
      });

      it('com foto limpa sem atestado: CONTENT_BLOCKED_NEEDS_CONSENT, sem Unlocked', async () => {
        contentSafety.preflightStatusForGeneration.mockResolvedValue('clean');

        await expect(
          processor.process(imageJob({ hasInputImages: true })),
        ).resolves.toBeUndefined();

        expect(seedream.generateImage).not.toHaveBeenCalled();
        expect(failedUpdateOf(prisma)?.data).toEqual({
          status: GenerationStatus.FAILED,
          errorCode: GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
          errorMessage: CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
        });
      });

      it('foto só nas imagens guardadas (job sem o marcador) também conta como foto', async () => {
        await expect(
          processor.process(imageJob({ hasInputImages: false })),
        ).resolves.toBeUndefined();

        expect(seedream.generateImage).not.toHaveBeenCalled();
        expectGenericTerminalBlock();
      });

      it('atestado gravado sem imagem guardada também conta como foto', async () => {
        prisma.generationInputImage.count.mockResolvedValue(0);
        contentSafety.hasConsentForGeneration.mockResolvedValue(true);

        await expect(
          processor.process(imageJob({ hasInputImages: false })),
        ).resolves.toBeUndefined();

        expect(seedream.generateImage).not.toHaveBeenCalled();
        expectGenericTerminalBlock();
      });

      it('leitura da checagem que falha conta como sem checagem (nunca libera)', async () => {
        contentSafety.preflightStatusForGeneration.mockRejectedValue(
          new Error('banco fora'),
        );
        contentSafety.hasConsentForGeneration.mockResolvedValue(true);

        await expect(
          processor.process(imageJob({ hasInputImages: true })),
        ).resolves.toBeUndefined();

        expect(seedream.generateImage).not.toHaveBeenCalled();
        expectGenericTerminalBlock();
      });

      it.each(ALL)(
        "só texto, checagem '%s': segue para o Unlocked (o veredito da imagem nem é lido)",
        async (preflight) => {
          prisma.generationInputImage.findMany.mockResolvedValue([]);
          prisma.generationInputImage.count.mockResolvedValue(0);
          contentSafety.preflightStatusForGeneration.mockResolvedValue(
            preflight,
          );

          await expect(processor.process(imageJob())).resolves.toBeUndefined();

          expect(seedream.generateImage).toHaveBeenCalledTimes(1);
          expect(
            contentSafety.preflightStatusForGeneration,
          ).not.toHaveBeenCalled();
          expect(failedUpdateOf(prisma)).toBeUndefined();
        },
      );
    });

    describe("alvo 'same_provider' (agente refinador: prompt reescrito no mesmo provedor)", () => {
      beforeEach(() => {
        promptEnhancer.refinePromptForSafety.mockResolvedValue(
          'caminhando na praia, vestida',
        );
      });

      it.each(ALL)(
        "com foto, checagem '%s' (inclusive limpa): encerra sem reescrever o prompt e sem reenviar a foto",
        async (preflight) => {
          contentSafety.preflightStatusForGeneration.mockResolvedValue(
            preflight,
          );
          grok.generateImageToVideo.mockRejectedValue(
            new ContentSafetyError('content policy violation'),
          );

          await expect(processor.process(grokJob())).resolves.toBeUndefined();

          expect(promptEnhancer.refinePromptForSafety).not.toHaveBeenCalled();
          expect(grok.generateImageToVideo).toHaveBeenCalledTimes(1);
          // com foto a reescrita não existe: o veredito do porteiro nem é lido
          expect(
            contentSafety.preflightStatusForGeneration,
          ).not.toHaveBeenCalled();
          expect(completeGeneration).not.toHaveBeenCalled();
          expectGenericTerminalBlock();
        },
      );

      it.each(ALL)(
        "só texto, checagem '%s': refaz com o prompt reescrito (comportamento de antes)",
        async (preflight) => {
          contentSafety.preflightStatusForGeneration.mockResolvedValue(
            preflight,
          );
          grok.generateTextToVideo
            .mockRejectedValueOnce(
              new ContentSafetyError('content policy violation'),
            )
            .mockResolvedValueOnce({
              outputUrls: ['https://cdn.test/video.mp4'],
              modelUsed: 'grok',
            });

          await expect(
            processor.process(grokTextJob()),
          ).resolves.toBeUndefined();

          expect(promptEnhancer.refinePromptForSafety).toHaveBeenCalledTimes(1);
          expect(grok.generateTextToVideo).toHaveBeenCalledTimes(2);
          expect(grok.generateTextToVideo).toHaveBeenLastCalledWith(
            expect.objectContaining({ prompt: 'caminhando na praia, vestida' }),
          );
          expect(
            contentSafety.preflightStatusForGeneration,
          ).not.toHaveBeenCalled();
          expect(failedUpdateOf(prisma)).toBeUndefined();
        },
      );
    });

    describe('saída do agente refinador passa pela trava de texto antes do provedor', () => {
      beforeEach(() => {
        grok.generateTextToVideo.mockRejectedValueOnce(
          new ContentSafetyError('content policy violation'),
        );
      });

      const promptWritesOf = () =>
        prisma.generation.update.mock.calls.filter(
          ([arg]) =>
            (arg as { data: Record<string, unknown> }).data.prompt !==
            undefined,
        );

      it('só a reescrita acusa (pedido adulto passou na trava): não chama o provedor, bloqueio genérico, NENHUM evento de menor', async () => {
        // "garota de 25 anos" passa na trava; o refinador tira a idade e escreve "young girl", que a trava acusa
        promptEnhancer.refinePromptForSafety.mockResolvedValue(
          'An original fictional character, a young girl in a two-piece swimsuit on the beach',
        );

        await expect(
          processor.process(
            grokTextJob({
              prompt: 'garota de 25 anos sexy de biquini na praia',
            }),
          ),
        ).resolves.toBeUndefined();

        expect(grok.generateTextToVideo).toHaveBeenCalledTimes(1);
        expect(promptWritesOf()).toHaveLength(0);
        // CONTENT_SAFETY_BLOCKED, estorno e nada de MINOR_BLOCKED (não conta para a guarda legal nem para o cockpit)
        expectGenericTerminalBlock();
        // entradas não ficam retidas como evidência de menor
        expect(uploads.deleteByPrefix).toHaveBeenCalledWith(
          `inputs/${GEN_ID}/`,
        );
      });

      it('reescrita e pedido original acusados: encerra como menor (refiner) com o termo do original', async () => {
        promptEnhancer.refinePromptForSafety.mockResolvedValue(
          'a teen girl on the beach',
        );

        await expect(
          processor.process(
            grokTextJob({ prompt: 'menina de 12 anos na praia' }),
          ),
        ).resolves.toBeUndefined();

        expect(grok.generateTextToVideo).toHaveBeenCalledTimes(1);
        expect(promptWritesOf()).toHaveLength(0);
        expect(failedUpdateOf(prisma)?.data).toEqual({
          status: GenerationStatus.FAILED,
          errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
          errorMessage: MINOR_BLOCK_USER_MESSAGE,
        });
        expect(contentSafety.record).toHaveBeenCalledTimes(1);
        expect(contentSafety.record).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: ContentSafetyEventKind.MINOR_BLOCKED,
            route: 'refiner:modelo-da-geracao',
            match: 'menina de 12',
            excerpt: 'prompt gravado',
            generationId: GEN_ID,
          }),
        );
      });

      it('reescrita que a trava não lê: não chama o provedor, bloqueio genérico sem evento de menor', async () => {
        promptEnhancer.refinePromptForSafety.mockResolvedValue('नग्न महिला');

        await expect(processor.process(grokTextJob())).resolves.toBeUndefined();

        expect(grok.generateTextToVideo).toHaveBeenCalledTimes(1);
        expectGenericTerminalBlock();
      });

      it('o log da nova tentativa não leva o prompt original nem o reescrito (só tamanho e sha256)', async () => {
        const original = 'caminhando na praia ao entardecer';
        const refined =
          'An original fictional character walking on the beach at dusk';
        promptEnhancer.refinePromptForSafety.mockResolvedValue(refined);
        grok.generateTextToVideo.mockResolvedValueOnce({
          outputUrls: ['https://cdn.test/video.mp4'],
          modelUsed: 'grok',
        });
        const logger = (processor as any).logger;
        const logged: string[] = [];
        for (const level of ['log', 'warn', 'error', 'debug', 'verbose']) {
          jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
            logged.push(args.map(String).join(' '));
          });
        }

        await expect(
          processor.process(grokTextJob({ prompt: original })),
        ).resolves.toBeUndefined();

        expect(grok.generateTextToVideo).toHaveBeenCalledTimes(2);
        const retryLine = logged.find((line) =>
          line.startsWith(`Retrying generation ${GEN_ID}`),
        );
        expect(retryLine).toMatch(
          /original len=\d+ sha256=[0-9a-f]{64} → refined len=\d+ sha256=[0-9a-f]{64}$/,
        );
        expect(retryLine).not.toContain(original);
        // nenhuma linha do caminho de desvio leva o texto reescrito
        expect(logged.some((line) => line.includes(refined))).toBe(false);
      });
    });
  });

  describe('áudio da cliente conta como mídia', () => {
    it('Seedance só com áudio de referência, recusado pelo filtro e sem checagem: encerra sem reescrever o prompt nem reenviar o áudio', async () => {
      seedance.generateVideo.mockRejectedValue(
        new ContentSafetyError('content policy violation'),
      );
      promptEnhancer.refinePromptForSafety.mockResolvedValue(
        'dançando na praia, vestida',
      );

      await expect(processor.process(seedanceJob())).resolves.toBeUndefined();

      expect(promptEnhancer.refinePromptForSafety).not.toHaveBeenCalled();
      expect(seedance.generateVideo).toHaveBeenCalledTimes(1);
      expect(contentSafety.preflightStatusForGeneration).not.toHaveBeenCalled();
      expect(failedUpdateOf(prisma)?.data).toEqual({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
        errorMessage: CONTENT_BLOCKED_USER_MESSAGE,
      });
      expect(contentSafety.record).not.toHaveBeenCalled();
    });
  });

  describe('URL assinada da entrada é reassinada a cada envio ao provedor', () => {
    const fresh = (url: string) => `${url.split('?')[0]}?X-Amz-Signature=nova`;

    beforeEach(() => {
      uploads.refreshInputReadUrl.mockImplementation(async (url: string) =>
        fresh(url),
      );
    });

    it('URL do job (fila): o provedor recebe a reassinada, e o job guardado no BullMQ não muda', async () => {
      const job = grokJob({ imageUrls: [SIGNED_INPUT('foto.png')] });
      grok.generateImageToVideo.mockResolvedValue({
        outputUrls: ['https://cdn.test/video.mp4'],
        modelUsed: 'grok',
      });

      await expect(processor.process(job)).resolves.toBeUndefined();

      expect(uploads.refreshInputReadUrl).toHaveBeenCalledWith(
        SIGNED_INPUT('foto.png'),
        GEN_ID,
      );
      expect(grok.generateImageToVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrls: [fresh(SIGNED_INPUT('foto.png'))],
        }),
      );
      expect((job.data as { imageUrls: string[] }).imageUrls).toEqual([
        SIGNED_INPUT('foto.png'),
      ]);
    });

    it('nova tentativa do BullMQ reassina de novo (cada tentativa tem a validade inteira)', async () => {
      const job = grokJob({ imageUrls: [SIGNED_INPUT('foto.png')] });
      grok.generateImageToVideo
        .mockRejectedValueOnce(new Error('Internal server error'))
        .mockResolvedValueOnce({
          outputUrls: ['https://cdn.test/video.mp4'],
          modelUsed: 'grok',
        });

      await expect(processor.process(job)).rejects.toThrow(
        'Internal server error',
      );
      await expect(processor.process(job)).resolves.toBeUndefined();

      expect(uploads.refreshInputReadUrl).toHaveBeenCalledTimes(2);
    });

    it('URL guardada no banco (imagem e desvio para o Unlocked): reassinada antes de cada provedor', async () => {
      prisma.generationInputImage.findMany.mockResolvedValue([
        { url: SIGNED_INPUT('foto.png') },
      ]);
      prisma.generationInputImage.count.mockResolvedValue(1);
      contentSafety.preflightStatusForGeneration.mockResolvedValue('clean');
      contentSafety.hasConsentForGeneration.mockResolvedValue(true);
      gptImage.generateImage.mockRejectedValue(
        new ContentSafetyError(
          'Your request was rejected by the safety system',
        ),
      );
      seedream.generateImage.mockResolvedValue({
        outputUrls: ['https://cdn.test/saida.png'],
        modelUsed: 'seedream',
      });

      await expect(
        processor.process(imageJob({ hasInputImages: true })),
      ).resolves.toBeUndefined();

      expect(gptImage.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrls: [fresh(SIGNED_INPUT('foto.png'))],
        }),
      );
      expect(seedream.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrls: [fresh(SIGNED_INPUT('foto.png'))],
        }),
      );
    });

    it('assinatura que falha: segue a URL gravada (pode ainda valer) em vez de derrubar a geração', async () => {
      uploads.refreshInputReadUrl.mockRejectedValue(new Error('S3 fora'));
      grok.generateImageToVideo.mockResolvedValue({
        outputUrls: ['https://cdn.test/video.mp4'],
        modelUsed: 'grok',
      });

      await expect(
        processor.process(grokJob({ imageUrls: [SIGNED_INPUT('foto.png')] })),
      ).resolves.toBeUndefined();

      expect(grok.generateImageToVideo).toHaveBeenCalledWith(
        expect.objectContaining({ imageUrls: [SIGNED_INPUT('foto.png')] }),
      );
    });
  });

  describe('logs sem o texto do pedido nem a URL assinada', () => {
    let logged: string[];

    beforeEach(() => {
      logged = [];
      const logger = (processor as any).logger;
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose']) {
        jest.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        });
      }
    });

    it('motion control: as URLs assinadas de vídeo e foto não vão para o log', async () => {
      wan.generateAnimateReplace.mockResolvedValue({
        outputUrls: ['https://cdn.test/video.mp4'],
        modelUsed: 'wan',
      });

      await processor.process({
        id: 'job-5',
        name: GenerationJobName.MOTION_CONTROL,
        attemptsMade: 0,
        opts: { attempts: 2 },
        data: {
          generationId: GEN_ID,
          userId: USER_ID,
          creditsConsumed: CREDITS,
          videoUrl: SIGNED_INPUT('input_video.mp4'),
          imageUrl: SIGNED_INPUT('input_image.jpg'),
          resolution: '720p',
        },
      } as unknown as Job);

      expect(wan.generateAnimateReplace).toHaveBeenCalledWith(
        expect.objectContaining({ videoUrl: SIGNED_INPUT('input_video.mp4') }),
      );
      const motionLine = logged.find((line) =>
        line.startsWith('[MOTION_CONTROL]'),
      );
      expect(motionLine).toContain(`/inputs/${GEN_ID}/u/input_video.mp4`);
      expect(logged.some((line) => line.includes('X-Amz-'))).toBe(false);
    });

    it('prompt e mensagem do provedor que repete o prompt: nada do texto em nenhuma linha, nem na falha final', async () => {
      const prompt = 'mulher adulta de 30 anos na praia ao entardecer';
      const providerError = new Error(
        `Internal server error for prompt "${prompt}" (download ${SIGNED_INPUT('foto.png')})`,
      );
      gptImage.generateImage.mockRejectedValue(providerError);
      const job = imageJob({ prompt });

      await expect(processor.process(job)).rejects.toThrow(providerError);
      await processor.onFailed(
        Object.assign(job, { attemptsMade: 2, finishedOn: Date.now() }) as Job,
        providerError,
      );

      expect(failedUpdateOf(prisma)?.data.errorCode).toBe(
        GenerationFailureCode.PROVIDER_ERROR,
      );
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.some((line) => line.includes(prompt))).toBe(false);
      expect(logged.some((line) => line.includes('X-Amz-'))).toBe(false);
      expect(
        logged.some((line) =>
          line.includes(`Generation ${GEN_ID} failed (PROVIDER_ERROR)`),
        ),
      ).toBe(true);
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
