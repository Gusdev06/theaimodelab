import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { GenerationStatus } from '@prisma/client';
import { ContentSafetyError } from '../../../generations/errors/content-safety.error';
import { activeUserCache } from '../../../auth/strategies/jwt.strategy';
import { CreditsService } from '../../../credits/credits.service';
import { ContentSafetyService } from '../../content-safety.service';
import {
  GenerationFailureCode,
  IMAGE_SAFETY_BLOCKED_MESSAGE,
} from '../../../generations/errors/failure-reason';
import { GenerationEventsService } from '../../../generations/generation-events.service';
import { BytedanceSeedanceProvider } from '../../../generations/providers/bytedance-seedance.provider';
import { ComfyDeployProvider } from '../../../generations/providers/comfydeploy.provider';
import { DeepDeepProvider } from '../../../generations/providers/deepdeep.provider';
import { FaceSwapProvider } from '../../../generations/providers/face-swap.provider';
import { GeminiOmniVideoProvider } from '../../../generations/providers/gemini-omni-video.provider';
import { GptImageProvider } from '../../../generations/providers/gpt-image.provider';
import { GrokImagineProvider } from '../../../generations/providers/grok-imagine.provider';
import { KlingProvider } from '../../../generations/providers/kling.provider';
import { NanoBananaProvider } from '../../../generations/providers/nano-banana.provider';
import { SeedreamLiteProvider } from '../../../generations/providers/seedream-lite.provider';
import { SeedreamProvider } from '../../../generations/providers/seedream.provider';
import { TheaimodelabProvider } from '../../../generations/providers/theaimodelab.provider';
import { VeoProvider } from '../../../generations/providers/veo.provider';
import { WanProvider } from '../../../generations/providers/wan.provider';
import { WavespeedAudioProvider } from '../../../generations/providers/wavespeed-audio.provider';
import { WavespeedVideoProvider } from '../../../generations/providers/wavespeed-video.provider';
import { GenerationProcessor } from '../../../generations/queue/generation.processor';
import { GenerationJobName } from '../../../generations/queue/generation-queue.constants';
import { PrismaService } from '../../../prisma/prisma.service';
import { PromptEnhancerService } from '../../../prompt-enhancer/prompt-enhancer.service';
import { UploadsService } from '../../../uploads/uploads.service';
import { ImageSafetyService } from '../../image-safety/image-safety.service';
import { NoopKnownHashMatcher } from '../../image-safety/known-csam.matcher';
import { NoopStylizedJudge } from '../../image-safety/stylized-judge.client';
import { StrikesService } from '../strikes.service';
import type { SuspensionEffects } from '../strikes.types';
import {
  FakeQueue,
  memoryDb,
  memoryPrisma,
  strikesConfig,
  type MemoryDb,
} from './strikes.harness';

/**
 * Ponta a ponta da suspensão com o GenerationProcessor de verdade (provedores simulados): a conta com 3 jobs na fila
 * recebe um sinal forte e NENHUM job chega ao provedor. Os que esperavam saem da fila e encerram com estorno; o que já
 * estava com o worker para no preflight (sinal de cancelamento). A sessão cai na hora.
 */

const USER = 'cmuser000000000000000001';
const OTHER = 'cmuser000000000000000002';
const CREDITS = 100;

function generation(id: string, userId: string) {
  return {
    id,
    userId,
    status: GenerationStatus.PROCESSING,
    type: 'TEXT_TO_IMAGE',
    modelUsed: 'gpt-image-2',
    prompt: 'mulher adulta na praia',
    negativePrompt: null,
    parameters: {},
    safetyCheckedAt: null,
    updatedAt: new Date(),
    creditsConsumed: CREDITS,
    usedFreeGeneration: false,
    expiresAt: null,
    errorCode: null,
    errorMessage: null,
  };
}

const jobData = (generationId: string, userId = USER) => ({
  generationId,
  userId,
  creditsConsumed: CREDITS,
  usedFreeGeneration: false,
  prompt: 'mulher adulta na praia',
  model: 'gpt-image-2',
  resolution: 'RES_2K',
  aspectRatio: '1:1',
  hasInputImages: false,
});

const asJob = (id: string, data: Record<string, unknown>): Job =>
  ({
    id,
    name: GenerationJobName.IMAGE,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data,
    updateData: jest.fn(async () => undefined),
    moveToDelayed: jest.fn(async () => undefined),
  }) as unknown as Job;

describe('suspensão por sinal forte · nenhum job chega ao provedor', () => {
  let db: MemoryDb;
  let processor: GenerationProcessor;
  let strikes: StrikesService;
  let queue: FakeQueue;
  let gptImage: { generateImage: jest.Mock };
  let theaimodelab: { generateImage: jest.Mock };
  let nanoBanana: { generateImage: jest.Mock };
  let seedream: { generateImage: jest.Mock };
  let credits: { refund: jest.Mock; refundFreeGeneration: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    db = memoryDb({
      users: [
        {
          id: USER,
          isActive: true,
          email: 'pessoa@exemplo.com',
          name: 'Pessoa',
          locale: 'pt-BR',
        },
        {
          id: OTHER,
          isActive: true,
          email: 'outra@exemplo.com',
          name: 'Outra',
          locale: 'pt-BR',
        },
      ],
      generations: [
        generation('g1', USER),
        generation('g2', USER),
        generation('g3', USER),
        generation('g4', USER),
        generation('go', OTHER),
      ],
    });
    const prisma = Object.assign(memoryPrisma(db), {
      // gerações sem foto enviada: o desvio de segurança é permitido pela guarda, a conta é que decide
      generationInputImage: {
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
    });
    const config = strikesConfig('shadow');
    queue = new FakeQueue();
    gptImage = {
      generateImage: jest.fn(async () => ({
        outputUrls: ['https://cdn.test/x.png'],
        modelUsed: 'gpt-image-2',
      })),
    };
    theaimodelab = { generateImage: jest.fn() };
    nanoBanana = { generateImage: jest.fn() };
    seedream = { generateImage: jest.fn() };
    credits = {
      refund: jest.fn(async () => undefined),
      refundFreeGeneration: jest.fn(async () => undefined),
    };
    events = { emit: jest.fn() };
    const contentSafety = {
      record: jest.fn(async () => 'evt-x'),
      hasConsentForGeneration: jest.fn(async () => false),
      preflightStatusForGeneration: jest.fn(async () => 'unavailable'),
      // porteiro em sombra: o desvio com mídia depende da checagem
      enforcesMediaPreflight: jest.fn(() => true),
    };
    const uploads = {
      deleteByPrefix: jest.fn(async () => 0),
      refreshInputReadUrl: jest.fn(async (url: string) => url),
      locateStoredMedia: jest.fn(() => null),
    };

    let imageSafety: ImageSafetyService | null = null;
    const effects: SuspensionEffects = {
      queues: () => [{ name: 'generation', queue, unlimited: false }],
      failGeneration: (generationId, error) =>
        processor.failForSafety(generationId, error, 'processing'),
      releaseUnlimitedLock: async () => undefined,
      holdUncheckedOutputs: async (userId) =>
        imageSafety ? imageSafety.holdUncheckedOutputsOfAccount(userId) : 0,
      sendNotice: async () => true,
    };
    const blocklist = {
      match: jest.fn(async () => null),
      add: jest.fn(async () => 'block-1'),
      countRecent: jest.fn(async () => 0),
    };
    strikes = new StrikesService(
      config,
      prisma as never,
      blocklist as never,
      effects,
    );
    imageSafety = new ImageSafetyService(
      config,
      prisma as never,
      uploads as never,
      contentSafety as never,
      {} as never,
      blocklist as never,
      new NoopKnownHashMatcher(),
      new NoopStylizedJudge(),
      {} as never,
      { name: 'rekognition', detect: jest.fn() } as never,
      strikes,
    );

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
        { provide: PromptEnhancerService, useValue: {} },
        { provide: ContentSafetyService, useValue: contentSafety },
        { provide: ImageSafetyService, useValue: imageSafety },
      ],
    }).compile();
    processor = moduleRef.get(GenerationProcessor);
  });

  afterEach(() => {
    activeUserCache.invalidate(USER);
    jest.restoreAllMocks();
  });

  const statusOf = (id: string) => db.generations.find((row) => row.id === id)!;

  it('3 jobs na fila + 1 já com o worker: sinal forte, nenhum provedor chamado, estorno de todos, sessão derrubada', async () => {
    queue.add('j1', jobData('g1'));
    queue.add('j2', jobData('g2'), 'delayed');
    queue.add('j3', jobData('g3'), 'prioritized');
    queue.add('j4', jobData('g4'), 'active');
    queue.add('jo', jobData('go', OTHER));
    await activeUserCache.resolve(USER, async () => true);

    const outcome = await strikes.applySignal(USER, 'STRONG', 'evt-0', {
      layer: 'input',
      match: 'E2/STRONG',
      generationId: 'g0',
    });
    expect(outcome.action).toBe('suspended');

    // os 3 que esperavam saíram da fila e encerraram com o código genérico e estorno
    expect(queue.jobs.map((job) => job.id)).toEqual(['j4', 'jo']);
    for (const id of ['g1', 'g2', 'g3']) {
      expect(statusOf(id)).toMatchObject({
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
        errorMessage: IMAGE_SAFETY_BLOCKED_MESSAGE,
      });
      expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, id);
    }

    // o que já estava com o worker para no preflight, antes de qualquer provedor
    await expect(
      processor.process(asJob('j4', jobData('g4'))),
    ).resolves.toBeUndefined();
    expect(statusOf('g4')).toMatchObject({
      status: GenerationStatus.FAILED,
      errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
    });
    expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, 'g4');

    // um worker atrasado que ainda tivesse um dos jobs tirados também não chama o provedor
    await expect(
      processor.process(asJob('j1', jobData('g1'))),
    ).resolves.toBeUndefined();

    expect(gptImage.generateImage).not.toHaveBeenCalled();
    expect(credits.refund).toHaveBeenCalledTimes(4);
    // a outra conta segue intacta
    expect(statusOf('go').status).toBe(GenerationStatus.PROCESSING);
    expect(db.users.find((row) => row.id === OTHER)?.isActive).toBe(true);

    // JWT: a próxima requisição da conta vai ao banco e encontra a conta inativa
    const lookup = jest.fn(async () => false);
    await expect(activeUserCache.resolve(USER, lookup)).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  const suspendDuringCall = () =>
    strikes.applySignal(USER, 'STRONG', 'evt-0', {
      layer: 'input',
      match: 'E2/STRONG',
      generationId: 'g0',
    });

  it('suspensa enquanto o provedor gerava: a recusa do filtro não desvia para o Unlocked', async () => {
    gptImage.generateImage.mockImplementationOnce(async () => {
      await suspendDuringCall();
      throw new ContentSafetyError('blocked by the provider safety filter');
    });
    await expect(
      processor.process(asJob('j4', jobData('g4'))),
    ).resolves.toBeUndefined();
    expect(gptImage.generateImage).toHaveBeenCalledTimes(1);
    expect(seedream.generateImage).not.toHaveBeenCalled();
    expect(statusOf('g4')).toMatchObject({
      status: GenerationStatus.FAILED,
      errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
      errorMessage: IMAGE_SAFETY_BLOCKED_MESSAGE,
    });
    expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, 'g4');
  });

  it('suspensa enquanto o provedor gerava: a falha técnica não cai na Nano Banana', async () => {
    theaimodelab.generateImage.mockImplementationOnce(async () => {
      await suspendDuringCall();
      throw new Error('upstream 500');
    });
    const data = { ...jobData('g4'), model: 'gemini-3-pro-image-preview' };
    await expect(
      processor.process({
        ...asJob('j4', data),
        name: GenerationJobName.IMAGE_WITH_FALLBACK,
      } as unknown as Job),
    ).resolves.toBeUndefined();
    expect(theaimodelab.generateImage).toHaveBeenCalledTimes(1);
    expect(nanoBanana.generateImage).not.toHaveBeenCalled();
    expect(statusOf('g4')).toMatchObject({
      status: GenerationStatus.FAILED,
      errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
    });
    expect(credits.refund).toHaveBeenCalledWith(USER, CREDITS, 'g4');
  });

  it('conta ativa: o desvio de segurança segue como antes', async () => {
    gptImage.generateImage.mockRejectedValueOnce(
      new ContentSafetyError('blocked by the provider safety filter'),
    );
    seedream.generateImage.mockResolvedValueOnce({
      outputUrls: ['https://cdn.test/y.png'],
      modelUsed: 'sem-censura',
    });
    await processor.process(asJob('j4', jobData('g4'))).catch(() => undefined);
    expect(seedream.generateImage).toHaveBeenCalledTimes(1);
  });
});
