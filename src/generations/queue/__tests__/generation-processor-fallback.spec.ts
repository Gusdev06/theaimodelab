import { UnrecoverableError } from 'bullmq';
import { GenerationProcessor } from '../generation.processor';
import { GenerationJobName } from '../generation-queue.constants';
import { GenerationUnrecoverableError } from '../unrecoverable.error';
import { ContentSafetyError } from '../../errors/content-safety.error';

/**
 * Orquestração do fallback (dispatchWithFallback): provedores e banco
 * simulados. `dispatch` é substituído para decidir quem falha e quem entrega;
 * a entrega simula o completeGeneration marcando a geração como COMPLETED.
 */

type GenerationRecord = {
  id: string;
  userId: string;
  status: string;
  type: string;
  modelUsed: string;
  durationSeconds: number | null;
  aspectRatio: string | null;
  createdAt: Date;
  creditsConsumed: number;
  usedFreeGeneration: boolean;
  parameters: Record<string, unknown> | null;
};

const makeRecord = (overrides: Partial<GenerationRecord> = {}): GenerationRecord => ({
  id: 'gen-1',
  userId: 'user-1',
  status: 'PROCESSING',
  type: 'TEXT_TO_VIDEO',
  modelUsed: 'veo3_fast',
  durationSeconds: null,
  aspectRatio: '9:16',
  createdAt: new Date(),
  creditsConsumed: 1920,
  usedFreeGeneration: false,
  parameters: { provider: 'kie' },
  ...overrides,
});

const veoJob = (model: 'veo3' | 'veo3_fast' = 'veo3_fast', creditsConsumed = 1920) => ({
  generationId: 'gen-1',
  userId: 'user-1',
  creditsConsumed,
  usedFreeGeneration: false,
  prompt: 'woman on a yacht at golden hour',
  model,
  resolution: 'RES_1080P',
  aspectRatio: '9:16',
  generateAudio: true,
});

function setup(record: GenerationRecord | null, config: Record<string, string> = {}) {
  const prisma = {
    generation: {
      findUnique: jest.fn(async () => (record ? { ...record, parameters: record.parameters ? { ...record.parameters } : null } : null)),
      update: jest.fn(async ({ data }: { data: Partial<GenerationRecord> }) => {
        if (record) Object.assign(record, data);
        return record;
      }),
    },
    generationInputImage: { findMany: jest.fn(async () => []) },
  };
  const creditsService = {
    adjustGenerationCost: jest.fn(async () => undefined),
    refund: jest.fn(async () => undefined),
    refundFreeGeneration: jest.fn(async () => undefined),
  };
  const plansService = { calculateGenerationCost: jest.fn(async () => 0) };
  const configService = {
    get: jest.fn((key: string, fallback?: string) => config[key] ?? fallback),
  };
  // uploads + 16 provedores: só a orquestração é testada aqui (dispatch é simulado).
  const middle = Array.from({ length: 17 }, () => ({}));
  const ProcessorCtor = GenerationProcessor as unknown as new (...args: unknown[]) => GenerationProcessor;
  const processor = new ProcessorCtor(
    prisma,
    creditsService,
    ...middle,
    { emit: jest.fn() }, // generationEvents
    {}, // promptEnhancer
    plansService,
    configService,
  );
  return { processor, prisma, creditsService, plansService, configService };
}

/** primário falha com `primaryError`; alternativa entrega (ou falha com `fallbackError`). */
function scriptDispatch(
  processor: GenerationProcessor,
  record: GenerationRecord | null,
  primaryJob: string,
  primaryError: Error,
  fallbackError?: Error,
) {
  const calls: string[] = [];
  const spy = jest.spyOn(processor, 'dispatch').mockImplementation(async (jobName: string) => {
    calls.push(jobName);
    if (calls.length === 1 && jobName === primaryJob) throw primaryError;
    if (fallbackError) throw fallbackError;
    if (record) {
      record.status = 'COMPLETED';
      record.modelUsed = 'wavespeed-ai/minimax-h3/text-to-video';
    }
  });
  return { calls, spy };
}

describe('GenerationProcessor — fallback automático de modelo', () => {
  afterEach(() => jest.restoreAllMocks());

  it('Veo Fast falha no provedor → MiniMax entrega; alternativa mais cara: plataforma absorve, cliente não paga a mais', async () => {
    const record = makeRecord();
    const { processor, creditsService, plansService } = setup(record);
    plansService.calculateGenerationCost.mockResolvedValue(2160); // MiniMax 768p 8 s
    const { calls } = scriptDispatch(
      processor,
      record,
      GenerationJobName.TEXT_TO_VIDEO_KIE,
      new Error('Veo generation failed: internal error, please try again later.'),
    );

    await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true });

    expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_KIE, GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO]);
    expect(creditsService.adjustGenerationCost).not.toHaveBeenCalled();
    expect(record.creditsConsumed).toBe(1920);
    expect(record.parameters).toMatchObject({
      provider: 'kie',
      fallbackFrom: 'veo3_fast',
      fallbackTo: 'wavespeed-minimax-h3',
      fallbackKind: 'provider',
      fallbackReason: 'PROVIDER_ERROR',
      fallbackCreditsOriginal: 1920,
      fallbackCreditsCharged: 1920,
      fallbackCreditsAbsorbed: 240,
    });
    expect(record.parameters).not.toHaveProperty('fallbackAttempt');
  });

  it('Veo Quality falha → Veo Fast entrega; estorna a diferença e grava o preço real', async () => {
    const record = makeRecord({ modelUsed: 'veo3', creditsConsumed: 6700 });
    const { processor, creditsService, plansService } = setup(record);
    plansService.calculateGenerationCost.mockResolvedValue(1920);
    const { calls } = scriptDispatch(
      processor,
      record,
      GenerationJobName.TEXT_TO_VIDEO_KIE,
      new Error('Veo generation timed out.'),
    );

    await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob('veo3', 6700) as any, { queued: true });

    expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_KIE, GenerationJobName.TEXT_TO_VIDEO_KIE]);
    expect(plansService.calculateGenerationCost).toHaveBeenCalledWith('TEXT_TO_VIDEO', 'RES_1080P', undefined, true, 1, 'VEO_FAST', false);
    expect(creditsService.adjustGenerationCost).toHaveBeenCalledWith('user-1', 'gen-1', 4780, expect.stringContaining('veo3_fast'));
    expect(record.creditsConsumed).toBe(1920);
    expect(record.parameters).toMatchObject({ fallbackCreditsRefunded: 4780, fallbackReason: 'GENERATION_TIMEOUT' });
  });

  it('alternativa também falha em erro passageiro: sobe o erro ORIGINAL com retry; no retry não tenta a alternativa de novo', async () => {
    const record = makeRecord();
    const { processor } = setup(record);
    const original = new Error('Veo generation failed: internal error, please try again later.');
    scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, original, new Error('MiniMax H3 failed'));

    await expect(
      processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true }),
    ).rejects.toBe(original);
    expect(record.parameters).toMatchObject({
      fallbackAttempt: { from: 'veo3_fast', to: 'wavespeed-minimax-h3', failed: 'MiniMax H3 failed' },
    });
    expect(record.parameters).not.toHaveProperty('fallbackFrom');

    // retry do BullMQ: só o modelo original roda
    const retry = jest.spyOn(processor, 'dispatch').mockRejectedValue(original);
    retry.mockClear();
    await expect(
      processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true }),
    ).rejects.toBe(original);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith(GenerationJobName.TEXT_TO_VIDEO_KIE, expect.anything());
  });

  it('bloqueio de conteúdo no Veo cai no MiniMax; se a alternativa falhar, é irrecuperável (sem retry) e guarda o erro original', async () => {
    const record = makeRecord();
    const { processor } = setup(record);
    const blocked = new ContentSafetyError('Veo generation failed: public error unsafe image upload.');
    const { calls } = scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, blocked, new Error('MiniMax H3 failed'));

    const error = await processor
      .dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true })
      .catch((e: Error) => e);

    expect(calls[1]).toBe(GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO);
    expect(error).toBeInstanceOf(GenerationUnrecoverableError);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as GenerationUnrecoverableError).original).toBe(blocked);
    expect(record.parameters).toMatchObject({ fallbackAttempt: { kind: 'safety', reason: 'CONTENT_SAFETY_BLOCKED' } });
  });

  it('sem alternativa e erro determinístico (prompt longo): irrecuperável, sem retry', async () => {
    const record = makeRecord({ type: 'TEXT_TO_IMAGE', modelUsed: 'sem-censura', creditsConsumed: 200 });
    const { processor } = setup(record);
    jest.spyOn(processor, 'dispatch').mockRejectedValue(new Error('Seedream failed: prompt is too long'));

    await expect(
      processor.dispatchWithFallback(
        GenerationJobName.IMAGE,
        { generationId: 'gen-1', userId: 'user-1', creditsConsumed: 200, prompt: 'p', model: 'sem-censura', resolution: 'RES_2K', hasInputImages: false } as any,
        { queued: true },
      ),
    ).rejects.toBeInstanceOf(GenerationUnrecoverableError);
  });

  it('sem alternativa e erro passageiro: sobe o original para o BullMQ repetir', async () => {
    const record = makeRecord({ type: 'TEXT_TO_IMAGE', modelUsed: 'sem-censura', creditsConsumed: 200 });
    const { processor } = setup(record);
    const transient = new Error('Seedream request failed: fetch failed');
    jest.spyOn(processor, 'dispatch').mockRejectedValue(transient);

    await expect(
      processor.dispatchWithFallback(
        GenerationJobName.IMAGE,
        { generationId: 'gen-1', userId: 'user-1', creditsConsumed: 200, prompt: 'p', model: 'sem-censura', resolution: 'RES_2K', hasInputImages: false } as any,
        { queued: true },
      ),
    ).rejects.toBe(transient);
  });

  it('geração que não está mais PROCESSING (cron, retry atrasado) não chama o provedor', async () => {
    const record = makeRecord({ status: 'FAILED' });
    const { processor } = setup(record);
    const dispatch = jest.spyOn(processor, 'dispatch');

    await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('perto da janela do cron (criada há mais de 20 min) não começa alternativa', async () => {
    const record = makeRecord({ createdAt: new Date(Date.now() - 21 * 60_000) });
    const { processor } = setup(record);
    const original = new Error('Veo generation failed: internal error');
    const { calls } = scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, original);

    await expect(
      processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true }),
    ).rejects.toBe(original);
    expect(calls).toHaveLength(1);
  });

  it('desligado por env (GENERATION_FALLBACK_ENABLED=false) não roda alternativa', async () => {
    const record = makeRecord();
    const { processor } = setup(record, { GENERATION_FALLBACK_ENABLED: 'false' });
    const original = new Error('Veo generation failed: internal error');
    const { calls } = scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, original);

    await expect(
      processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true }),
    ).rejects.toBe(original);
    expect(calls).toHaveLength(1);
  });

  it('geração grátis e ilimitada: entrega pela alternativa sem mexer em créditos', async () => {
    for (const overrides of [{ usedFreeGeneration: true, creditsConsumed: 0 }, { parameters: { unlimited: true } }]) {
      const record = makeRecord({ modelUsed: 'veo3', creditsConsumed: 6700, ...overrides });
      const { processor, creditsService, plansService } = setup(record);
      plansService.calculateGenerationCost.mockResolvedValue(1920);
      scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, new Error('Veo generation timed out.'));

      await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob('veo3', 6700) as any, { queued: true });

      expect(record.status).toBe('COMPLETED');
      expect(creditsService.adjustGenerationCost).not.toHaveBeenCalled();
    }
  });

  it('cron finalizou enquanto a alternativa rodava: não estorna de novo nem marca como fallback entregue', async () => {
    const record = makeRecord({ modelUsed: 'veo3', creditsConsumed: 6700 });
    const { processor, creditsService, plansService } = setup(record);
    plansService.calculateGenerationCost.mockResolvedValue(1920);
    let n = 0;
    jest.spyOn(processor, 'dispatch').mockImplementation(async () => {
      n += 1;
      if (n === 1) throw new Error('Veo generation timed out.');
      record.status = 'FAILED'; // cron chegou antes do completeGeneration
    });

    await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob('veo3', 6700) as any, { queued: true });

    expect(creditsService.adjustGenerationCost).not.toHaveBeenCalled();
    expect(record.parameters).not.toHaveProperty('fallbackFrom');
  });

  it('erro na reconciliação não derruba o job (senão o retry chamaria o provedor original de novo)', async () => {
    const record = makeRecord({ modelUsed: 'veo3', creditsConsumed: 6700 });
    const { processor, creditsService, plansService } = setup(record);
    plansService.calculateGenerationCost.mockResolvedValue(1920);
    creditsService.adjustGenerationCost.mockRejectedValue(new Error('deadlock'));
    scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, new Error('Veo generation timed out.'));

    await expect(
      processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob('veo3', 6700) as any, { queued: true }),
    ).resolves.toBeUndefined();
    expect(record.status).toBe('COMPLETED');
  });

  it('runner direto (Unlocked): sem alternativa, a falha chega ao handleFailure com o erro original', async () => {
    const record = makeRecord({ type: 'TEXT_TO_IMAGE', modelUsed: 'sem-censura', creditsConsumed: 200 });
    const { processor } = setup(record);
    const original = new Error('Seedream request failed: fetch failed');
    jest.spyOn(processor, 'dispatch').mockRejectedValue(original);
    const handleFailure = jest.spyOn(processor as any, 'handleFailure').mockResolvedValue(undefined);

    await processor.runImageJobDirectly({
      generationId: 'gen-1', userId: 'user-1', creditsConsumed: 200, usedFreeGeneration: false,
      prompt: 'p', model: 'sem-censura', resolution: 'RES_2K', hasInputImages: false,
    });

    expect(handleFailure).toHaveBeenCalledWith('gen-1', 'user-1', 200, original, false);
  });

  describe('onFailed', () => {
    const job = (attemptsMade: number) => ({
      id: 'job-1',
      name: GenerationJobName.TEXT_TO_VIDEO_KIE,
      data: { generationId: 'gen-1', userId: 'user-1', creditsConsumed: 1920, usedFreeGeneration: false },
      attemptsMade,
      opts: { attempts: 2 },
    });

    it('erro irrecuperável na 1ª tentativa: finaliza na hora com o erro original', async () => {
      const { processor } = setup(makeRecord());
      const handleFailure = jest.spyOn(processor as any, 'handleFailure').mockResolvedValue(undefined);
      const blocked = new ContentSafetyError('blocked');

      await processor.onFailed(job(1) as any, new GenerationUnrecoverableError(blocked));

      expect(handleFailure).toHaveBeenCalledWith('gen-1', 'user-1', 1920, blocked, false);
    });

    it('erro passageiro na 1ª tentativa: espera o retry', async () => {
      const { processor } = setup(makeRecord());
      const handleFailure = jest.spyOn(processor as any, 'handleFailure').mockResolvedValue(undefined);

      await processor.onFailed(job(1) as any, new Error('fetch failed'));

      expect(handleFailure).not.toHaveBeenCalled();
    });

    it('erro passageiro na última tentativa: finaliza', async () => {
      const { processor } = setup(makeRecord());
      const handleFailure = jest.spyOn(processor as any, 'handleFailure').mockResolvedValue(undefined);
      const transient = new Error('fetch failed');

      await processor.onFailed(job(2) as any, transient);

      expect(handleFailure).toHaveBeenCalledWith('gen-1', 'user-1', 1920, transient, false);
    });
  });
});
