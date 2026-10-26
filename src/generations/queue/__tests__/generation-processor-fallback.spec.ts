import { UnrecoverableError } from 'bullmq';
import { GenerationProcessor } from '../generation.processor';
import { GenerationJobName } from '../generation-queue.constants';
import { GenerationUnrecoverableError } from '../unrecoverable.error';
import { ConsentRequiredSafetyError, ContentSafetyError, MinorSafetyBlockError } from '../../errors/content-safety.error';

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
    generationInputImage: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
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
  // guarda da PR #4: atestado de imagem da geração (padrão: sem atestado)
  const contentSafety = { hasConsentForGeneration: jest.fn(async () => false) };
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
    contentSafety,
  );
  // conferência "foto = geração limpa da própria conta" (own-media): padrão = não reconhecida, sem rede
  const ownMedia = {
    matchOwnClean: jest.fn(async (): Promise<unknown> => null),
    recordGeneration: jest.fn(async () => undefined),
  };
  (processor as unknown as { ownMediaInstance: unknown }).ownMediaInstance = ownMedia;
  return { processor, prisma, creditsService, plansService, configService, contentSafety, ownMedia };
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

  describe('guarda de mídia do usuário (desvio para sem censura)', () => {
    const veoImageJob = () => ({
      ...veoJob(),
      imageUrls: ['https://cdn/in.jpg'],
    });

    it('falha técnica com foto: não desvia para o MiniMax, registra o bloqueio e mantém o retry do original', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor } = setup(record);
      const original = new Error('Veo generation failed: internal error, please try again later.');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, original);

      await expect(
        processor.dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true }),
      ).rejects.toBe(original);

      expect(calls).toEqual([GenerationJobName.IMAGE_TO_VIDEO_KIE]);
      expect(record.parameters).toMatchObject({
        fallbackBlocked: {
          from: 'veo3_fast',
          to: 'wavespeed-minimax-h3',
          kind: 'provider',
          reason: 'UNCENSORED_WITH_USER_MEDIA',
          errorCode: 'PROVIDER_ERROR',
        },
      });
      expect(record.parameters).not.toHaveProperty('fallbackAttempt');
    });

    it('bloqueio de conteúdo com foto: sem desvio e irrecuperável', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor } = setup(record);
      const blocked = new ContentSafetyError('Veo generation failed: public error unsafe image upload.');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, blocked);

      const error = await processor
        .dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true })
        .catch((e: Error) => e);

      expect(calls).toHaveLength(1);
      expect(error).toBeInstanceOf(GenerationUnrecoverableError);
      expect((error as GenerationUnrecoverableError).original).toBe(blocked);
      expect(record.parameters).toMatchObject({ fallbackBlocked: { kind: 'safety', reason: 'UNCENSORED_WITH_USER_MEDIA' } });
    });

    it('entrada recusada vira segurança: sem desvio com foto, irrecuperável, código INPUT_IMAGE_REJECTED', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor } = setup(record);
      const rejected = new Error('Veo generation failed: the image is not compliant, change your input files.');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, rejected);

      const error = await processor
        .dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true })
        .catch((e: Error) => e);

      expect(calls).toHaveLength(1);
      expect(error).toBeInstanceOf(GenerationUnrecoverableError);
      expect(record.parameters).toMatchObject({
        fallbackBlocked: { kind: 'safety', reason: 'UNCENSORED_WITH_USER_MEDIA', errorCode: 'INPUT_IMAGE_REJECTED' },
      });
    });

    it('entrada recusada em imagem com foto: não cai mais na kie como falha técnica', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_IMAGE', modelUsed: 'gpt-image-2', creditsConsumed: 200 });
      const { processor, prisma } = setup(record);
      prisma.generationInputImage.findMany.mockResolvedValue([{ url: 'https://cdn/in.jpg', order: 0 }] as never);
      const rejected = new Error('GPT image failed: input was rejected');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE, rejected);

      await expect(
        processor.dispatchWithFallback(
          GenerationJobName.IMAGE,
          { generationId: 'gen-1', userId: 'user-1', creditsConsumed: 200, prompt: 'p', model: 'gpt-image-2', resolution: 'RES_2K', hasInputImages: true } as any,
          { queued: true },
        ),
      ).rejects.toBeInstanceOf(GenerationUnrecoverableError);
      expect(calls).toEqual([GenerationJobName.IMAGE]);
      expect(record.parameters).not.toHaveProperty('fallbackAttempt');
    });

    it('sem foto, falha técnica: o desvio para o MiniMax continua', async () => {
      const record = makeRecord();
      const { processor } = setup(record);
      const { calls } = scriptDispatch(
        processor,
        record,
        GenerationJobName.TEXT_TO_VIDEO_KIE,
        new Error('Veo generation failed: internal error'),
      );

      await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true });

      expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_KIE, GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO]);
      expect(record.parameters).not.toHaveProperty('fallbackBlocked');
    });

    it.each([
      ['falha técnica', new Error('Veo generation failed: internal error'), 'provider'],
      ['entrada recusada', new Error('Veo generation failed: the image is not compliant'), 'safety'],
    ])('GENERATION_FALLBACK_UNCENSORED_WITH_MEDIA=true libera o desvio com foto (%s)', async (_label, original, kind) => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor, contentSafety } = setup(record, { GENERATION_FALLBACK_UNCENSORED_WITH_MEDIA: 'true' });
      // bloqueio de conteúdo com foto só desvia com atestado de imagem (guarda da PR #4)
      contentSafety.hasConsentForGeneration.mockResolvedValue(true);
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, original);

      await processor.dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true });

      expect(calls).toEqual([GenerationJobName.IMAGE_TO_VIDEO_KIE, GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO]);
      expect(record.parameters).toMatchObject({ fallbackTo: 'wavespeed-minimax-h3', fallbackKind: kind });
    });

    it('bloqueio de conteúdo com foto que é geração limpa da própria conta: desvia para o MiniMax com a foto, sem atestado', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor, ownMedia } = setup(record);
      ownMedia.matchOwnClean.mockResolvedValue([
        {
          inputUrl: 'https://cdn/in.jpg',
          generationId: 'gen-modelo',
          outputOrder: 0,
          outputUrl: 'https://s3/gen-modelo/0.png',
          distance: 2,
          thumbDiff: 3,
        },
      ]);
      const blocked = new ContentSafetyError('Veo generation failed: public error unsafe image upload.');
      const { calls, spy } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, blocked);

      await processor.dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true });

      expect(ownMedia.matchOwnClean).toHaveBeenCalledWith('user-1', ['https://cdn/in.jpg']);
      expect(calls).toEqual([GenerationJobName.IMAGE_TO_VIDEO_KIE, GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO]);
      // ao MiniMax vai a NOSSA cópia da geração que bateu, nunca a foto do pedido
      const sent = JSON.stringify(spy.mock.calls[1][1]);
      expect(sent).toContain('https://s3/gen-modelo/0.png');
      expect(sent).not.toContain('https://cdn/in.jpg');
      expect(record.parameters).toMatchObject({
        fallbackTo: 'wavespeed-minimax-h3',
        fallbackKind: 'safety',
        fallbackMedia: { source: 'own_generation', matches: [{ generationId: 'gen-modelo', outputOrder: 0, distance: 2 }] },
      });
      expect(record.parameters).not.toHaveProperty('fallbackBlocked');
    });

    it('falha técnica com foto própria: desvia, mas a guarda de menor roda (recusa por menor sem vocabulário de segurança)', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor, ownMedia } = setup(record);
      ownMedia.matchOwnClean.mockResolvedValue([
        {
          inputUrl: 'https://cdn/in.jpg',
          generationId: 'gen-modelo',
          outputOrder: 0,
          outputUrl: 'https://s3/gen-modelo/0.png',
          distance: 2,
          thumbDiff: 3,
        },
      ]);
      const childError = new Error('Veo generation failed: the photo contains a child');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, childError);

      const error = await processor
        .dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true })
        .catch((e: Error) => e);

      expect(calls).toHaveLength(1);
      expect(error).toBeInstanceOf(Error);
      expect(record.parameters).not.toHaveProperty('fallbackTo');
    });

    it('foto não reconhecida como geração da própria conta: segue barrado (e confere a origem só uma vez)', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor, ownMedia } = setup(record);
      const blocked = new ContentSafetyError('Veo generation failed: public error unsafe image upload.');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, blocked);

      await expect(
        processor.dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true }),
      ).rejects.toBeInstanceOf(GenerationUnrecoverableError);

      expect(ownMedia.matchOwnClean).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
      expect(record.parameters).toMatchObject({ fallbackBlocked: { kind: 'safety', reason: 'UNCENSORED_WITH_USER_MEDIA' } });
    });

    it('vídeo de referência no pedido: nem confere a origem como foto (vídeo nunca é liberado)', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor, ownMedia } = setup(record);
      const blocked = new ContentSafetyError('Veo generation failed: public error unsafe image upload.');
      scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, blocked);

      await expect(
        processor.dispatchWithFallback(
          GenerationJobName.IMAGE_TO_VIDEO_KIE,
          { ...veoImageJob(), referenceVideoUrls: ['https://cdn/ref.mp4'] } as any,
          { queued: true },
        ),
      ).rejects.toBeInstanceOf(GenerationUnrecoverableError);

      expect(ownMedia.matchOwnClean).toHaveBeenCalledWith('user-1', null);
    });

    it('env liberado, bloqueio de conteúdo, sem atestado e foto de fora: a guarda de atestado confere a mídia do pedido e barra', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor, ownMedia } = setup(record, { GENERATION_FALLBACK_UNCENSORED_WITH_MEDIA: 'true' });
      const blocked = new ContentSafetyError('Veo generation failed: public error unsafe image upload.');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, blocked);

      const error = await processor
        .dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true })
        .catch((e: Error) => e);

      expect(ownMedia.matchOwnClean).toHaveBeenCalledWith('user-1', ['https://cdn/in.jpg']);
      expect(calls).toHaveLength(1);
      // o fallback embrulha o bloqueio terminal; o process() desembrulha antes de encerrar
      expect(error).toBeInstanceOf(GenerationUnrecoverableError);
      expect((error as GenerationUnrecoverableError).original).toBeInstanceOf(ConsentRequiredSafetyError);
    });

    it('valor diferente de "true" no env mantém a guarda', async () => {
      const record = makeRecord({ type: 'IMAGE_TO_VIDEO' });
      const { processor } = setup(record, { GENERATION_FALLBACK_UNCENSORED_WITH_MEDIA: '1' });
      const original = new Error('Veo generation failed: internal error');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE_TO_VIDEO_KIE, original);

      await expect(
        processor.dispatchWithFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImageJob() as any, { queued: true }),
      ).rejects.toBe(original);
      expect(calls).toHaveLength(1);
    });
  });

  describe('recusa por menor (sem desvio, sem retry)', () => {
    const grokJob = () => ({
      generationId: 'gen-1',
      userId: 'user-1',
      creditsConsumed: 1920,
      usedFreeGeneration: false,
      prompt: 'woman walking on the beach at sunset',
      resolution: 'RES_720P',
      durationSeconds: 6,
      aspectRatio: '9:16',
    });
    const minimaxJob = () => ({ ...grokJob(), durationSeconds: 5, generateAudio: true });
    const imageJob = () => ({
      generationId: 'gen-1',
      userId: 'user-1',
      creditsConsumed: 200,
      usedFreeGeneration: false,
      prompt: 'p',
      model: 'gpt-image-2',
      resolution: 'RES_2K',
      hasInputImages: false,
    });
    const childCodeVeo = () =>
      new Error('Veo generation failed: The prompt could not be submitted. Support codes: 58061214');

    it.each([
      ['Veo kie T2V, código de criança', GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob(), 'veo3_fast', childCodeVeo(), 'safety', 'CONTENT_POLICY_MINOR'],
      [
        'Veo kie T2V, "child" em bloqueio de política',
        GenerationJobName.TEXT_TO_VIDEO_KIE,
        veoJob(),
        'veo3_fast',
        new Error('Veo generation failed: request violates content policy, it depicts a child.'),
        'safety',
        'CONTENT_POLICY_MINOR',
      ],
      [
        'Veo kie T2V, "child" que o classificador lia como falha técnica',
        GenerationJobName.TEXT_TO_VIDEO_KIE,
        veoJob(),
        'veo3_fast',
        new Error('Veo generation failed: prompt blocked, it depicts a child.'),
        'provider',
        'GENERATION_FAILED',
      ],
      [
        'Grok T2V, código de criança',
        GenerationJobName.TEXT_TO_VIDEO_GROK,
        grokJob(),
        'grok-imagine',
        new ContentSafetyError('Grok Imagine blocked the request (430)', '17301594'),
        'safety',
        'CONTENT_SAFETY_BLOCKED',
      ],
      [
        'Grok T2V, "minor"',
        GenerationJobName.TEXT_TO_VIDEO_GROK,
        grokJob(),
        'grok-imagine',
        new ContentSafetyError('Content flagged: involving a minor (430)', '430'),
        'safety',
        'CONTENT_POLICY_MINOR',
      ],
    ])('%s: MiniMax nunca roda, irrecuperável, fallbackBlocked MINOR_REFUSAL', async (_label, jobName, job, model, refusal, kind, errorCode) => {
      const record = makeRecord({ modelUsed: model });
      const { processor } = setup(record);
      const { calls } = scriptDispatch(processor, record, jobName, refusal);

      const error = await processor
        .dispatchWithFallback(jobName, job as any, { queued: true })
        .catch((e: Error) => e);

      expect(calls).toEqual([jobName]);
      expect(error).toBeInstanceOf(GenerationUnrecoverableError);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as GenerationUnrecoverableError).original).toBe(refusal);
      expect(record.parameters).toMatchObject({
        fallbackBlocked: { from: model, to: 'wavespeed-minimax-h3', kind, reason: 'MINOR_REFUSAL', errorCode },
      });
      expect(record.parameters).not.toHaveProperty('fallbackAttempt');
    });

    it.each([
      [
        'imagem GPT → Nano Banana na kie',
        GenerationJobName.IMAGE,
        imageJob(),
        'gpt-image-2',
        new Error('GPT image failed: request rejected, the prompt involves children'),
        'nano-banana-2',
      ],
      [
        'Veo Quality → Veo Fast',
        GenerationJobName.TEXT_TO_VIDEO_KIE,
        veoJob('veo3', 6700),
        'veo3',
        new Error('Veo generation failed: prompt blocked, it depicts a child.'),
        'veo3_fast',
      ],
    ])('nem para modelo com filtro (%s)', async (_label, jobName, job, model, refusal, filteredTarget) => {
      const record = makeRecord({ modelUsed: model });
      const { processor } = setup(record);
      const { calls } = scriptDispatch(processor, record, jobName, refusal);

      const error = await processor
        .dispatchWithFallback(jobName, job as any, { queued: true })
        .catch((e: Error) => e);

      expect(calls).toEqual([jobName]);
      expect(error).toBeInstanceOf(GenerationUnrecoverableError);
      expect(record.parameters).toMatchObject({
        fallbackBlocked: { from: model, to: filteredTarget, kind: 'provider', reason: 'MINOR_REFUSAL' },
      });
    });

    it.each([
      [
        'Veo kie T2V, código de conteúdo sexual',
        GenerationJobName.TEXT_TO_VIDEO_KIE,
        veoJob(),
        'veo3_fast',
        new Error('Veo generation failed: The prompt could not be submitted. Support codes: 90789179'),
      ],
      [
        'Grok T2V, bloqueio adulto',
        GenerationJobName.TEXT_TO_VIDEO_GROK,
        grokJob(),
        'grok-imagine',
        new ContentSafetyError('Content flagged as sexually explicit (430)', '430'),
      ],
    ])('bloqueio adulto comum (%s) continua desviando para o MiniMax', async (_label, jobName, job, model, refusal) => {
      const record = makeRecord({ modelUsed: model });
      const { processor } = setup(record);
      const { calls } = scriptDispatch(processor, record, jobName, refusal);

      await processor.dispatchWithFallback(jobName, job as any, { queued: true });

      expect(calls).toEqual([jobName, GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO]);
      expect(record.parameters).toMatchObject({ fallbackTo: 'wavespeed-minimax-h3', fallbackKind: 'safety' });
      expect(record.parameters).not.toHaveProperty('fallbackBlocked');
    });

    it.each([
      ['"minor version"', new Error('Veo generation failed: minor version mismatch, internal error')],
      ['"child process"', new Error('Veo generation failed: child process exited unexpectedly (500)')],
    ])('%s fora de bloqueio não conta: a falha técnica segue para a alternativa', async (_label, failure) => {
      const record = makeRecord();
      const { processor } = setup(record);
      const { calls } = scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, failure);

      await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true });

      expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_KIE, GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO]);
      expect(record.parameters).toMatchObject({ fallbackKind: 'provider', fallbackReason: 'PROVIDER_ERROR' });
      expect(record.parameters).not.toHaveProperty('fallbackBlocked');
    });

    it('runner direto: o handleFailure recebe o erro original, sem alternativa', async () => {
      const record = makeRecord({ type: 'TEXT_TO_IMAGE', modelUsed: 'gpt-image-2', creditsConsumed: 200 });
      const { processor } = setup(record);
      const refusal = new ContentSafetyError('Request blocked: sexual/minors');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.IMAGE, refusal);
      const handleFailure = jest.spyOn(processor as any, 'handleFailure').mockResolvedValue(undefined);

      await processor.runImageJobDirectly(imageJob() as any);

      expect(calls).toEqual([GenerationJobName.IMAGE]);
      expect(handleFailure).toHaveBeenCalledWith('gen-1', 'user-1', 200, refusal, false);
      expect(record.parameters).toMatchObject({ fallbackBlocked: { reason: 'MINOR_REFUSAL' } });
    });

    it('falha ao gravar a métrica não troca o erro; log sem prompt nem mensagem do banco', async () => {
      const record = makeRecord();
      const { processor, prisma } = setup(record);
      prisma.generation.update.mockRejectedValue(new Error('db down'));
      const refusal = childCodeVeo();
      const { calls } = scriptDispatch(processor, record, GenerationJobName.TEXT_TO_VIDEO_KIE, refusal);
      const logger = (processor as any).logger;
      const warn = jest.spyOn(logger, 'warn');
      const errorLog = jest.spyOn(logger, 'error');

      const error = await processor
        .dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoJob() as any, { queued: true })
        .catch((e: Error) => e);

      expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_KIE]);
      expect(error).toBeInstanceOf(GenerationUnrecoverableError);
      expect((error as GenerationUnrecoverableError).original).toBe(refusal);
      const lines = [...warn.mock.calls, ...errorLog.mock.calls].map((args) => args.join(' '));
      expect(lines.some((line) => line.includes('recusa por menor'))).toBe(true);
      expect(lines.some((line) => line.includes(veoJob().prompt) || line.includes('db down'))).toBe(false);
    });

    it('alternativa recusa por menor: irrecuperável (o retry levaria o pedido de novo ao modelo original)', async () => {
      const record = makeRecord({ modelUsed: 'wavespeed-minimax-h3' });
      const { processor } = setup(record);
      const original = new Error('MiniMax H3 failed: internal error');
      const minor = new ContentSafetyError('Content flagged: involving a minor (430)', '430');
      const { calls } = scriptDispatch(processor, record, GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, original, minor);

      const error = await processor
        .dispatchWithFallback(GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, minimaxJob() as any, { queued: true })
        .catch((e: Error) => e);

      expect(calls).toEqual([GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, GenerationJobName.SEEDANCE_VIDEO]);
      expect(error).toBeInstanceOf(GenerationUnrecoverableError);
      expect((error as GenerationUnrecoverableError).original).toBe(original);
      expect(record.parameters).toMatchObject({
        fallbackAttempt: { to: 'bytedance-seedance-2', minorRefusal: true },
      });
    });

    describe('reescrita do prompt (Grok com o processo real)', () => {
      /** Grok recusa na ordem de `refusals`; a alternativa (se rodar) entrega. */
      function runGrok(record: GenerationRecord, refusals: Error[]) {
        const { processor } = setup(record);
        const grok = { generateTextToVideo: jest.fn() };
        for (const refusal of refusals) grok.generateTextToVideo.mockRejectedValueOnce(refusal);
        const promptEnhancer = { refinePromptForSafety: jest.fn(async () => 'woman walking on the beach, golden hour') };
        Object.assign(processor as any, { grokImagineProvider: grok, promptEnhancer });
        const realDispatch = processor.dispatch.bind(processor);
        const calls: string[] = [];
        jest.spyOn(processor, 'dispatch').mockImplementation(async (jobName: string, data: unknown) => {
          calls.push(jobName);
          if (jobName === GenerationJobName.TEXT_TO_VIDEO_GROK) return realDispatch(jobName, data);
          record.status = 'COMPLETED';
        });
        return { processor, grok, promptEnhancer, calls };
      }

      const adult = () => new ContentSafetyError('Content flagged as sexually explicit (430)', '430');
      const minor = () => new ContentSafetyError('Content flagged: involving a minor (430)', '430');

      it('recusa por menor não vai para a reescrita: sobe crua e o MiniMax nunca roda', async () => {
        const record = makeRecord({ modelUsed: 'grok-imagine' });
        const refusal = minor();
        const { processor, grok, promptEnhancer, calls } = runGrok(record, [refusal]);

        const error = await processor
          .dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_GROK, grokJob() as any, { queued: true })
          .catch((e: Error) => e);

        expect(promptEnhancer.refinePromptForSafety).not.toHaveBeenCalled();
        expect(grok.generateTextToVideo).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_GROK]);
        expect(error).toBeInstanceOf(GenerationUnrecoverableError);
        // a guarda da PR #4 converte a recusa por menor em bloqueio terminal (MinorSafetyBlockError)
        expect((error as GenerationUnrecoverableError).original).toBeInstanceOf(MinorSafetyBlockError);
        expect(record.parameters).toMatchObject({ fallbackBlocked: { reason: 'MINOR_REFUSAL' } });
      });

      it('prompt reescrito recusado por menor: a marca não some no erro genérico e o MiniMax nunca roda', async () => {
        const record = makeRecord({ modelUsed: 'grok-imagine' });
        const refusal = minor();
        const { processor, promptEnhancer, calls } = runGrok(record, [adult(), refusal]);

        const error = await processor
          .dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_GROK, grokJob() as any, { queued: true })
          .catch((e: Error) => e);

        expect(promptEnhancer.refinePromptForSafety).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_GROK]);
        expect(error).toBeInstanceOf(GenerationUnrecoverableError);
        expect((error as GenerationUnrecoverableError).original).toBe(refusal);
        expect(record.parameters).toMatchObject({ fallbackBlocked: { reason: 'MINOR_REFUSAL' } });
      });

      it('reescrita recusada por motivo adulto: o desvio de sempre para o MiniMax continua', async () => {
        const record = makeRecord({ modelUsed: 'grok-imagine' });
        const { processor, promptEnhancer, calls } = runGrok(record, [adult(), adult()]);

        await processor.dispatchWithFallback(GenerationJobName.TEXT_TO_VIDEO_GROK, grokJob() as any, { queued: true });

        expect(promptEnhancer.refinePromptForSafety).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([GenerationJobName.TEXT_TO_VIDEO_GROK, GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO]);
        expect(record.parameters).toMatchObject({ fallbackKind: 'safety', fallbackTo: 'wavespeed-minimax-h3' });
      });
    });
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
