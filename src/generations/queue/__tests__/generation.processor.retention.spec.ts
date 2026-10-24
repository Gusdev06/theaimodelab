import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GenerationStatus, GenerationType } from '@prisma/client';
import { GenerationProcessor } from '../generation.processor';
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
import { PlansService } from '../../../plans/plans.service';
import { ConfigService } from '@nestjs/config';

/**
 * Prazo de expiração na galeria ao concluir: conta sob guarda legal (inativa) não ganha prazo, senão o cron da galeria
 * apagaria a evidência de uma geração que terminou depois da guarda (o cron não filtra mais por conta ativa).
 */

const GEN_ID = 'gen-1';
const USER_ID = 'user-1';
const RETENTION_DAYS = 30;

type Op = { op: string; args: Record<string, any> };

function createPrisma(ownerActive: boolean | null) {
  return {
    generation: {
      findUnique: jest.fn(async (args: { select: Record<string, unknown> }) => {
        if (args.select.status) return { status: GenerationStatus.PROCESSING };
        return {
          type: GenerationType.VOICE_CLONE,
          quantity: 1,
          creditsConsumed: 10,
          userId: USER_ID,
          user: ownerActive === null ? null : { isActive: ownerActive },
        };
      }),
      update: jest.fn(
        (args: Record<string, any>): Op => ({ op: 'update', args }),
      ),
      updateMany: jest.fn(
        (args: Record<string, any>): Op => ({ op: 'updateMany', args }),
      ),
    },
    generationOutput: {
      createMany: jest.fn(
        (args: Record<string, any>): Op => ({ op: 'createMany', args }),
      ),
    },
    generationInputImage: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscription: {
      findFirst: jest.fn().mockResolvedValue({
        plan: { galleryRetentionDays: RETENTION_DAYS },
      }),
    },
    $transaction: jest.fn(async (ops: Op[]) =>
      ops.map((item) =>
        item.op === 'update' ? { id: GEN_ID, userId: USER_ID } : { count: 1 },
      ),
    ),
  };
}

async function buildProcessor(prisma: ReturnType<typeof createPrisma>) {
  const events = { emit: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      GenerationProcessor,
      { provide: PrismaService, useValue: prisma },
      { provide: CreditsService, useValue: {} },
      {
        provide: UploadsService,
        useValue: { deleteByPrefix: jest.fn().mockResolvedValue(0) },
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
      { provide: SeedreamProvider, useValue: {} },
      { provide: GptImageProvider, useValue: {} },
      { provide: DeepDeepProvider, useValue: {} },
      { provide: WavespeedAudioProvider, useValue: {} },
      { provide: GenerationEventsService, useValue: events },
      { provide: PromptEnhancerService, useValue: {} },
      { provide: PlansService, useValue: { calculateGenerationCost: jest.fn(async () => 0) } },
      { provide: ConfigService, useValue: { get: jest.fn((_key: string, fallback?: string) => fallback) } },
      { provide: ContentSafetyService, useValue: {} },
    ],
  }).compile();
  return { processor: moduleRef.get(GenerationProcessor), events };
}

const complete = (processor: GenerationProcessor) =>
  (
    processor as unknown as {
      completeGeneration: (
        generationId: string,
        result: { outputUrls: string[]; modelUsed: string },
        startTime: number,
      ) => Promise<void>;
    }
  ).completeGeneration(
    GEN_ID,
    { outputUrls: ['https://cdn.test/voz.mp3'], modelUsed: 'voz-modelo' },
    Date.now(),
  );

describe('GenerationProcessor · prazo da galeria ao concluir', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('conta ativa: grava o prazo do plano por último na transação, conferindo a conta ativa na escrita', async () => {
    const prisma = createPrisma(true);
    const { processor, events } = await buildProcessor(prisma);
    const before = Date.now();

    await complete(processor);

    const [ops] = prisma.$transaction.mock.calls[0];
    expect(ops.map((item: Op) => item.op)).toEqual([
      'update',
      'createMany',
      'updateMany',
    ]);
    // o update da conclusão não leva o prazo: ele só vai no updateMany com a trava da conta
    expect(ops[0].args.data.expiresAt).toBeUndefined();
    expect(ops[0].args.data.status).toBe(GenerationStatus.COMPLETED);
    const expiry = ops[2].args;
    expect(expiry.where).toEqual({ id: GEN_ID, user: { isActive: true } });
    const expiresAt = expiry.data.expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    const days = (expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(RETENTION_DAYS - 1);
    expect(days).toBeLessThan(RETENTION_DAYS + 1);
    expect(prisma.subscription.findFirst).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: GEN_ID, status: 'completed' }),
    );
  });

  it('conta inativa (guarda legal): conclui sem prazo e nem consulta o plano', async () => {
    const prisma = createPrisma(false);
    const { processor, events } = await buildProcessor(prisma);

    await complete(processor);

    const [ops] = prisma.$transaction.mock.calls[0];
    expect(ops.map((item: Op) => item.op)).toEqual(['update', 'createMany']);
    expect(ops[0].args.data.expiresAt).toBeUndefined();
    expect(prisma.generation.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('owner account inactive'),
    );
    // a pessoa (ou o caso) ainda recebe o resultado normalmente
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: GEN_ID, status: 'completed' }),
    );
  });

  it('dona sem linha de conta lida (relação vazia): segue a regra antiga, com a trava da conta ativa na escrita', async () => {
    const prisma = createPrisma(null);
    const { processor } = await buildProcessor(prisma);

    await complete(processor);

    const [ops] = prisma.$transaction.mock.calls[0];
    expect(ops.map((item: Op) => item.op)).toEqual([
      'update',
      'createMany',
      'updateMany',
    ]);
    expect(ops[2].args.where).toEqual({ id: GEN_ID, user: { isActive: true } });
  });
});
