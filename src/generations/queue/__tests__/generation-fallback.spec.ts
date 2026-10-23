import { GenerationType } from '@prisma/client';
import {
  evaluateFallback,
  FallbackContext,
  FallbackKind,
  fallbackKindOf,
  hasUserMedia,
  isUncensoredFallbackModel,
  MOTION_CONTROL_FALLBACK_PROMPT,
  planFallback,
} from '../generation-fallback';
import {
  ComfyDeployImageToVideoJobData,
  GenerationJobData,
  GenerationJobName,
  ImageToVideoGrokJobData,
  ReferenceToVideoKieJobData,
  ImageJobData,
  ImageNanoBananaJobData,
  ImageToVideoKieJobData,
  KlingImageToVideoJobData,
  MinimaxH3ImageToVideoJobData,
  MinimaxH3ReferenceToVideoJobData,
  MinimaxH3TextToVideoJobData,
  MotionControlJobData,
  OmniVideoJobData,
  SeedanceVideoJobData,
  TextToVideoGrokJobData,
  TextToVideoKieJobData,
  WavespeedImageToVideoJobData,
  WavespeedSeedanceImageToVideoJobData,
} from '../generation-queue.constants';

const base = {
  generationId: 'gen-1',
  userId: 'user-1',
  creditsConsumed: 1920,
  usedFreeGeneration: false,
};

// Mapa de alternativas: a guarda de mídia fica liberada aqui para conferir o
// plano montado; ela tem o próprio bloco de testes (evaluateFallback) abaixo.
const ctx = (overrides: Partial<FallbackContext> = {}): FallbackContext => ({
  kind: 'provider',
  originalModel: 'veo3_fast',
  generationType: GenerationType.TEXT_TO_VIDEO,
  allowUncensoredWithMedia: true,
  ...overrides,
});

describe('planFallback', () => {
  // ── Veo (kie) ──────────────────────────────────────────────────────
  it('Veo Quality cai no Veo Fast (mesmo job, cobrança VEO_FAST)', () => {
    const data: TextToVideoKieJobData = {
      ...base,
      prompt: 'p',
      model: 'veo3',
      resolution: 'RES_1080P',
      aspectRatio: '9:16',
      generateAudio: true,
    };
    const plan = planFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, data, ctx());
    expect(plan).toMatchObject({
      jobName: GenerationJobName.TEXT_TO_VIDEO_KIE,
      model: 'veo3_fast',
      modelVariant: 'VEO_FAST',
      billing: { type: GenerationType.TEXT_TO_VIDEO, resolution: 'RES_1080P', hasAudio: true },
    });
    expect((plan!.data as TextToVideoKieJobData).model).toBe('veo3_fast');
    expect(plan!.data.generationId).toBe('gen-1');
  });

  it('Veo Fast texto cai no MiniMax H3 768p 8 s (outro provedor)', () => {
    const data: TextToVideoKieJobData = {
      ...base,
      prompt: 'p',
      model: 'veo3_fast',
      resolution: 'RES_1080P',
      aspectRatio: '9:16',
      generateAudio: true,
    };
    const plan = planFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, data, ctx());
    expect(plan).toMatchObject({
      jobName: GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO,
      model: 'wavespeed-minimax-h3',
      modelVariant: 'WAVESPEED_MINIMAX_H3',
      billing: { type: GenerationType.TEXT_TO_VIDEO, resolution: 'RES_720P', durationSeconds: 8, hasAudio: true },
    });
    const job = plan!.data as MinimaxH3TextToVideoJobData;
    expect(job).toMatchObject({ prompt: 'p', resolution: 'RES_720P', durationSeconds: 8, aspectRatio: '9:16', generateAudio: true });
  });

  it('Veo Fast bloqueado por conteúdo também cai no MiniMax (safety)', () => {
    const data: ImageToVideoKieJobData = {
      ...base,
      prompt: 'p',
      model: 'veo3_fast',
      resolution: 'RES_720P',
      generateAudio: true,
      imageUrls: ['https://cdn/first.jpg', 'https://cdn/last.jpg'],
    };
    const plan = planFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, data, ctx({ kind: 'safety' }));
    expect(plan).toMatchObject({ jobName: GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO, kind: 'safety' });
    expect(plan!.data as MinimaxH3ImageToVideoJobData).toMatchObject({
      imageUrl: 'https://cdn/first.jpg',
      lastImageUrl: 'https://cdn/last.jpg',
      resolution: 'RES_720P',
    });
  });

  it('Veo Quality bloqueado por conteúdo não cai no Fast (mesmo filtro): vai direto ao MiniMax', () => {
    const data: TextToVideoKieJobData = {
      ...base,
      prompt: 'p',
      model: 'veo3',
      resolution: 'RES_720P',
      generateAudio: true,
    };
    const plan = planFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, data, ctx({ kind: 'safety' }));
    expect(plan!.jobName).toBe(GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO);
  });

  // ── Omni / Seedance / Kling / Grok ─────────────────────────────────
  it('Omni com vídeo de referência vira MiniMax referência com os clipes', () => {
    const data: OmniVideoJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_4K',
      durationSeconds: 4,
      aspectRatio: '16:9',
      imageUrls: ['https://cdn/a.jpg'],
      videoList: [{ url: 'https://cdn/clip.mp4', start: 0, ends: 4 }],
      hasVideoInput: true,
    };
    const plan = planFallback(GenerationJobName.OMNI_VIDEO, data, ctx());
    expect(plan!.jobName).toBe(GenerationJobName.MINIMAX_H3_REFERENCE_TO_VIDEO);
    const job = plan!.data as MinimaxH3ReferenceToVideoJobData;
    expect(job).toMatchObject({
      referenceImageUrls: ['https://cdn/a.jpg'],
      referenceVideoUrls: ['https://cdn/clip.mp4'],
      resolution: 'RES_720P',
      durationSeconds: 5, // MiniMax mínimo
    });
    expect(plan!.billing.hasVideoInput).toBe(false);
  });

  it('Seedance 2.5 com first frame vira MiniMax imagem; duração 30 s cai para 15', () => {
    const data: SeedanceVideoJobData = {
      ...base,
      prompt: 'p',
      modelId: 'bytedance/seedance-2-5',
      resolution: 'RES_1080P',
      durationSeconds: 30,
      aspectRatio: 'adaptive',
      firstFrameUrl: 'https://cdn/f.jpg',
      generateAudio: true,
      hasVideoInput: false,
    };
    const plan = planFallback(GenerationJobName.SEEDANCE_VIDEO, data, ctx());
    expect(plan!.jobName).toBe(GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO);
    expect(plan!.billing).toMatchObject({ resolution: 'RES_720P', durationSeconds: 15 });
  });

  it('Kling V3 Turbo cai no MiniMax imagem', () => {
    const data: KlingImageToVideoJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_720P',
      durationSeconds: 5,
      imageUrls: ['https://cdn/k.jpg'],
      aspectRatio: '9:16',
      generateAudio: true,
    };
    const plan = planFallback(GenerationJobName.KLING_IMAGE_TO_VIDEO, data, ctx());
    expect(plan).toMatchObject({ jobName: GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO, model: 'wavespeed-minimax-h3' });
  });

  it('Grok texto 480p fica em 480p no MiniMax; proporção 2:3 (sem equivalente) é omitida', () => {
    const data: TextToVideoGrokJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_480P',
      durationSeconds: 6,
      aspectRatio: '2:3',
    };
    const plan = planFallback(GenerationJobName.TEXT_TO_VIDEO_GROK, data, ctx());
    expect(plan!.data as MinimaxH3TextToVideoJobData).toMatchObject({ resolution: 'RES_480P', durationSeconds: 6 });
    expect((plan!.data as MinimaxH3TextToVideoJobData).aspectRatio).toBeUndefined();
  });

  // ── Motion Control ─────────────────────────────────────────────────
  it('Motion Control usa a duração da geração e um prompt sintético', () => {
    const data: MotionControlJobData = {
      ...base,
      videoUrl: 'https://cdn/ref.mp4',
      imageUrl: 'https://cdn/ref.jpg',
      resolution: 'RES_720P',
    };
    const plan = planFallback(GenerationJobName.MOTION_CONTROL, data, ctx({ durationSeconds: 7 }));
    expect(plan!.jobName).toBe(GenerationJobName.MINIMAX_H3_REFERENCE_TO_VIDEO);
    expect(plan!.data as MinimaxH3ReferenceToVideoJobData).toMatchObject({
      prompt: MOTION_CONTROL_FALLBACK_PROMPT,
      referenceVideoUrls: ['https://cdn/ref.mp4'],
      referenceImageUrls: ['https://cdn/ref.jpg'],
      durationSeconds: 7,
      aspectRatio: '9:16',
    });
  });

  it('Motion Control acima de 15 s não tem alternativa', () => {
    const data: MotionControlJobData = {
      ...base,
      videoUrl: 'v',
      imageUrl: 'i',
      resolution: 'RES_720P',
    };
    expect(planFallback(GenerationJobName.MOTION_CONTROL, data, ctx({ durationSeconds: 22 }))).toBeNull();
    expect(planFallback(GenerationJobName.MOTION_CONTROL, data, ctx({ durationSeconds: null }))).toBeNull();
  });

  // ── WaveSpeed ↔ kie ────────────────────────────────────────────────
  it('LTX Spicy cai no MiniMax só em falha técnica; bloqueio não tem alternativa', () => {
    const data: WavespeedImageToVideoJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_480P',
      durationSeconds: 5,
      imageUrl: 'https://cdn/x.jpg',
    };
    expect(planFallback(GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO, data, ctx())!.jobName).toBe(
      GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO,
    );
    expect(planFallback(GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO, data, ctx({ kind: 'safety' }))).toBeNull();
  });

  it('Seedance Spicy cai no MiniMax imagem', () => {
    const data: WavespeedSeedanceImageToVideoJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_1080P',
      durationSeconds: 8,
      imageUrl: 'https://cdn/x.jpg',
      generateAudio: false,
    };
    const plan = planFallback(GenerationJobName.WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO, data, ctx());
    expect(plan!.billing).toMatchObject({ type: GenerationType.IMAGE_TO_VIDEO, resolution: 'RES_720P', durationSeconds: 8 });
  });

  it('MiniMax texto cai no Seedance 2.0 (kie); 9:21 vira 9:16', () => {
    const data: MinimaxH3TextToVideoJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_720P',
      durationSeconds: 5,
      aspectRatio: '9:21',
      generateAudio: true,
    };
    const plan = planFallback(GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, data, ctx());
    expect(plan).toMatchObject({
      jobName: GenerationJobName.SEEDANCE_VIDEO,
      model: 'bytedance-seedance-2',
      modelVariant: 'SEEDANCE_2',
      billing: { type: GenerationType.TEXT_TO_VIDEO, resolution: 'RES_720P', durationSeconds: 5, hasVideoInput: false },
    });
    expect(plan!.data as SeedanceVideoJobData).toMatchObject({
      modelId: 'bytedance/seedance-2',
      aspectRatio: '9:16',
      generateAudio: true,
    });
  });

  it('MiniMax imagem vira Seedance 2.0 com a imagem como referência (9:16 se a geração não tem proporção)', () => {
    const data: MinimaxH3ImageToVideoJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_480P',
      durationSeconds: 5,
      imageUrl: 'https://cdn/i.jpg',
      generateAudio: true,
    };
    const plan = planFallback(GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO, data, ctx({ aspectRatio: null }));
    expect(plan!.data as SeedanceVideoJobData).toMatchObject({
      referenceImageUrls: ['https://cdn/i.jpg'],
      aspectRatio: '9:16',
    });
    expect((plan!.data as SeedanceVideoJobData).firstFrameUrl).toBeUndefined();
    expect(plan!.billing.type).toBe(GenerationType.REFERENCE_VIDEO);
  });

  it('MiniMax bloqueado por conteúdo não tem alternativa', () => {
    const data: MinimaxH3TextToVideoJobData = {
      ...base,
      prompt: 'p',
      resolution: 'RES_720P',
      durationSeconds: 5,
      generateAudio: true,
    };
    expect(planFallback(GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, data, ctx({ kind: 'safety' }))).toBeNull();
  });

  // ── Imagem ─────────────────────────────────────────────────────────
  it('Nano Banana 2 no provedor próprio cai na kie (mesmo modelo, mesma variante → sem estorno)', () => {
    const data: ImageJobData = {
      ...base,
      creditsConsumed: 200,
      prompt: 'p',
      model: 'nano-banana-2',
      resolution: 'RES_2K',
      aspectRatio: '1:1',
      mimeType: 'image/jpeg',
      hasInputImages: true,
    };
    const plan = planFallback(GenerationJobName.IMAGE, data, ctx({ inputImageUrls: ['https://cdn/in.jpg'] }));
    expect(plan).toMatchObject({
      jobName: GenerationJobName.IMAGE_NANO_BANANA,
      model: 'nano-banana-2',
      modelVariant: 'NB2',
      billing: { type: GenerationType.IMAGE_TO_IMAGE, resolution: 'RES_2K' },
    });
    expect(plan!.data as ImageNanoBananaJobData).toMatchObject({
      imageUrls: ['https://cdn/in.jpg'],
      outputFormat: 'jpeg',
    });
  });

  it('imagem com input mas sem URL carregada não tem alternativa', () => {
    const data: ImageJobData = {
      ...base,
      prompt: 'p',
      model: 'gpt-image-2-5',
      resolution: 'RES_2K',
      hasInputImages: true,
    };
    expect(planFallback(GenerationJobName.IMAGE, data, ctx({ inputImageUrls: [] }))).toBeNull();
  });

  it('IMAGE_WITH_FALLBACK já tentou a kie por dentro: Nano Banana não repete; GPT cai na kie', () => {
    const nb: ImageJobData = { ...base, prompt: 'p', model: 'gemini-3.1-flash-image-preview', resolution: 'RES_2K', hasInputImages: false };
    expect(planFallback(GenerationJobName.IMAGE_WITH_FALLBACK, nb, ctx())).toBeNull();
    const gpt: ImageJobData = { ...base, prompt: 'p', model: 'gpt-image-2', resolution: 'RES_4K', hasInputImages: false };
    expect(planFallback(GenerationJobName.IMAGE_WITH_FALLBACK, gpt, ctx())).toMatchObject({
      jobName: GenerationJobName.IMAGE_NANO_BANANA,
      model: 'nano-banana-2',
    });
  });

  it('Seedream Lite 3K vira Nano Banana 2 em 2K', () => {
    const data: ImageJobData = { ...base, prompt: 'p', model: 'seedream-5-lite', resolution: 'RES_3K', hasInputImages: false };
    const plan = planFallback(GenerationJobName.IMAGE, data, ctx());
    expect(plan!.billing).toMatchObject({ type: GenerationType.TEXT_TO_IMAGE, resolution: 'RES_2K' });
  });

  it('Nano Banana na kie cai no provedor próprio (nome Gemini)', () => {
    const data: ImageNanoBananaJobData = {
      ...base,
      prompt: 'p',
      model: 'nano-banana-pro',
      resolution: 'RES_4K',
      outputFormat: 'png',
      imageUrls: [],
    };
    const plan = planFallback(GenerationJobName.IMAGE_NANO_BANANA, data, ctx());
    expect(plan).toMatchObject({ jobName: GenerationJobName.IMAGE, model: 'gemini-3-pro-image-preview', modelVariant: 'NBP' });
    expect(plan!.data as ImageJobData).toMatchObject({ hasInputImages: false, mimeType: 'image/png' });
  });

  it('Unlocked, Undress, bloqueio de imagem e jobs sem mapa não têm alternativa', () => {
    const unlocked: ImageJobData = { ...base, prompt: 'p', model: 'sem-censura', resolution: 'RES_2K', hasInputImages: false };
    expect(planFallback(GenerationJobName.IMAGE, unlocked, ctx())).toBeNull();
    const undress: ImageJobData = { ...base, prompt: 'p', model: 'deepdeep', resolution: 'RES_2K', hasInputImages: false };
    expect(planFallback(GenerationJobName.IMAGE_WITH_FALLBACK, undress, ctx())).toBeNull();
    const gpt: ImageJobData = { ...base, prompt: 'p', model: 'gpt-image-2', resolution: 'RES_2K', hasInputImages: false };
    expect(planFallback(GenerationJobName.IMAGE, gpt, ctx({ kind: 'safety' }))).toBeNull();
    expect(planFallback(GenerationJobName.VIRTUAL_TRY_ON, gpt, ctx())).toBeNull();
    expect(planFallback(GenerationJobName.TEXT_TO_VIDEO, gpt, ctx())).toBeNull();
  });
});

describe('evaluateFallback — guarda de mídia do usuário', () => {
  // Contexto de produção: a guarda vem LIGADA (allowUncensoredWithMedia omitido).
  const guardCtx = (overrides: Partial<FallbackContext> = {}): FallbackContext => ({
    kind: 'provider',
    originalModel: 'veo3_fast',
    generationType: GenerationType.IMAGE_TO_VIDEO,
    ...overrides,
  });

  const veoImage: ImageToVideoKieJobData = {
    ...base,
    prompt: 'p',
    model: 'veo3_fast',
    resolution: 'RES_720P',
    generateAudio: true,
    imageUrls: ['https://cdn/in.jpg'],
  };
  const veoText: TextToVideoKieJobData = {
    ...base,
    prompt: 'p',
    model: 'veo3_fast',
    resolution: 'RES_720P',
    aspectRatio: '9:16',
    generateAudio: true,
  };

  // Todos os jobs com mídia do usuário cujo desvio é o MiniMax H3 (sem censura).
  const withMediaToUncensored: Array<
    [string, GenerationJobName, GenerationJobData, FallbackKind[], Partial<FallbackContext>]
  > = [
    ['Veo Fast com foto (first/last frame)', GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImage, ['provider', 'safety'], {}],
    [
      'Veo referência com imagens',
      GenerationJobName.REFERENCE_TO_VIDEO_KIE,
      { ...base, prompt: 'p', model: 'veo3_fast', resolution: 'RES_720P', generateAudio: true, imageUrls: ['https://cdn/a.jpg', 'https://cdn/b.jpg'] } as ReferenceToVideoKieJobData,
      ['provider', 'safety'],
      {},
    ],
    [
      'Omni com vídeo de referência',
      GenerationJobName.OMNI_VIDEO,
      { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, videoList: [{ url: 'https://cdn/clip.mp4', start: 0, ends: 5 }], hasVideoInput: true } as OmniVideoJobData,
      ['provider', 'safety'],
      {},
    ],
    [
      'Seedance 2.5 com quadro inicial',
      GenerationJobName.SEEDANCE_VIDEO,
      { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, firstFrameUrl: 'https://cdn/f.jpg', generateAudio: true, hasVideoInput: false } as SeedanceVideoJobData,
      ['provider', 'safety'],
      {},
    ],
    [
      'Seedance só com áudio de referência',
      GenerationJobName.SEEDANCE_VIDEO,
      { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, referenceAudioUrls: ['https://cdn/voz.mp3'], generateAudio: true, hasVideoInput: false } as SeedanceVideoJobData,
      ['provider', 'safety'],
      {},
    ],
    [
      'Kling com foto',
      GenerationJobName.KLING_IMAGE_TO_VIDEO,
      { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, imageUrls: ['https://cdn/k.jpg'], aspectRatio: '9:16', generateAudio: true } as KlingImageToVideoJobData,
      ['provider', 'safety'],
      {},
    ],
    [
      'Grok com foto',
      GenerationJobName.IMAGE_TO_VIDEO_GROK,
      { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 6, imageUrls: ['https://cdn/g.jpg'] } as ImageToVideoGrokJobData,
      ['provider', 'safety'],
      {},
    ],
    [
      'ComfyDeploy com foto',
      GenerationJobName.COMFYDEPLOY_IMAGE_TO_VIDEO,
      { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, imageUrl: 'https://cdn/c.jpg' } as ComfyDeployImageToVideoJobData,
      ['provider', 'safety'],
      {},
    ],
    [
      'Motion Control (vídeo + foto)',
      GenerationJobName.MOTION_CONTROL,
      { ...base, videoUrl: 'https://cdn/ref.mp4', imageUrl: 'https://cdn/ref.jpg', resolution: 'RES_720P' } as MotionControlJobData,
      ['provider', 'safety'],
      { durationSeconds: 7 },
    ],
    [
      'LTX Spicy com foto (falha técnica)',
      GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO,
      { ...base, prompt: 'p', resolution: 'RES_480P', durationSeconds: 5, imageUrl: 'https://cdn/x.jpg' } as WavespeedImageToVideoJobData,
      ['provider'],
      {},
    ],
    [
      'Seedance Spicy com foto (falha técnica)',
      GenerationJobName.WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO,
      { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, imageUrl: 'https://cdn/x.jpg', generateAudio: false } as WavespeedSeedanceImageToVideoJobData,
      ['provider'],
      {},
    ],
  ];

  describe.each(withMediaToUncensored)('%s', (_label, jobName, data, kinds, extra) => {
    it.each(kinds)('motivo %s: barrado por padrão, sem plano', (kind) => {
      const decision = evaluateFallback(jobName, data, guardCtx({ kind, ...extra }));
      expect(decision.plan).toBeNull();
      expect(decision.blocked).toEqual({ reason: 'UNCENSORED_WITH_USER_MEDIA', model: 'wavespeed-minimax-h3' });
      expect(planFallback(jobName, data, guardCtx({ kind, ...extra }))).toBeNull();
    });

    it.each(kinds)('motivo %s: env explicitamente false também barra', (kind) => {
      const decision = evaluateFallback(jobName, data, guardCtx({ kind, allowUncensoredWithMedia: false, ...extra }));
      expect(decision.plan).toBeNull();
      expect(decision.blocked?.reason).toBe('UNCENSORED_WITH_USER_MEDIA');
    });

    it.each(kinds)('motivo %s: env liberado devolve o plano no MiniMax', (kind) => {
      const decision = evaluateFallback(jobName, data, guardCtx({ kind, allowUncensoredWithMedia: true, ...extra }));
      expect(decision.blocked).toBeUndefined();
      expect(decision.plan).toMatchObject({ model: 'wavespeed-minimax-h3', kind });
    });
  });

  it.each<FallbackKind>(['provider', 'safety'])('sem mídia, alvo sem censura (%s): segue para o MiniMax texto', (kind) => {
    const decision = evaluateFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, veoText, guardCtx({ kind }));
    expect(decision.blocked).toBeUndefined();
    expect(decision.plan).toMatchObject({ jobName: GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, model: 'wavespeed-minimax-h3', kind });

    const grok: TextToVideoGrokJobData = { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 6 };
    expect(evaluateFallback(GenerationJobName.TEXT_TO_VIDEO_GROK, grok, guardCtx({ kind })).plan?.model).toBe('wavespeed-minimax-h3');
  });

  it('com mídia, alvo com filtro (falha técnica): desvio liberado', () => {
    // Veo Quality → Veo Fast (mesmo filtro)
    const quality = { ...veoImage, model: 'veo3' };
    expect(evaluateFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, quality, guardCtx()).plan).toMatchObject({ model: 'veo3_fast' });

    // MiniMax com foto → Seedance 2.0 (kie, com filtro)
    const minimax: MinimaxH3ImageToVideoJobData = { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, imageUrl: 'https://cdn/i.jpg', generateAudio: true };
    expect(evaluateFallback(GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO, minimax, guardCtx()).plan).toMatchObject({ model: 'bytedance-seedance-2' });

    // Imagem com foto (provedor próprio → kie, e kie → provedor próprio)
    const image: ImageJobData = { ...base, prompt: 'p', model: 'gpt-image-2', resolution: 'RES_2K', hasInputImages: true };
    expect(
      evaluateFallback(GenerationJobName.IMAGE, image, guardCtx({ inputImageUrls: ['https://cdn/in.jpg'] })).plan,
    ).toMatchObject({ model: 'nano-banana-2' });
    const kie: ImageNanoBananaJobData = { ...base, prompt: 'p', model: 'nano-banana-2', resolution: 'RES_2K', outputFormat: 'png', imageUrls: ['https://cdn/in.jpg'] };
    expect(evaluateFallback(GenerationJobName.IMAGE_NANO_BANANA, kie, guardCtx()).plan).toMatchObject({ model: 'gemini-3.1-flash-image-preview' });
  });

  it('sem mídia, alvo com filtro: desvio liberado', () => {
    const quality = { ...veoText, model: 'veo3' };
    expect(evaluateFallback(GenerationJobName.TEXT_TO_VIDEO_KIE, quality, guardCtx()).plan).toMatchObject({ model: 'veo3_fast' });
    const minimax: MinimaxH3TextToVideoJobData = { ...base, prompt: 'p', resolution: 'RES_720P', durationSeconds: 5, generateAudio: true };
    expect(evaluateFallback(GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO, minimax, guardCtx()).plan).toMatchObject({ model: 'bytedance-seedance-2' });
  });

  it('entrada recusada vira segurança: imagem com foto fica sem desvio (antes caía na kie)', () => {
    const image: ImageJobData = { ...base, prompt: 'p', model: 'gpt-image-2', resolution: 'RES_2K', hasInputImages: true };
    const kind = fallbackKindOf('Generation failed: input was rejected, change your input files', false);
    expect(kind).toBe('safety');
    expect(evaluateFallback(GenerationJobName.IMAGE, image, guardCtx({ kind, inputImageUrls: ['https://cdn/in.jpg'] }))).toEqual({ plan: null });
  });

  it('entrada recusada em vídeo com foto: segurança e barrado antes do MiniMax', () => {
    const kind = fallbackKindOf('Veo failed: the image is not compliant', false);
    const decision = evaluateFallback(GenerationJobName.IMAGE_TO_VIDEO_KIE, veoImage, guardCtx({ kind }));
    expect(kind).toBe('safety');
    expect(decision.plan).toBeNull();
    expect(decision.blocked?.reason).toBe('UNCENSORED_WITH_USER_MEDIA');
  });

  describe('fallbackKindOf', () => {
    it.each([
      ['500', 'Veo generation failed: Internal Server Error (500)'],
      ['timeout', 'Veo generation timed out.'],
      ['cota', 'kie: credits insufficient for this request'],
      ['sobrecarga', 'Service Unavailable (503)'],
      ['sem saída', 'no video data returned'],
    ])('falha técnica (%s) = provider', (_label, message) => {
      expect(fallbackKindOf(message, false)).toBe('provider');
    });

    it.each([
      'the image is not compliant',
      'Your input was rejected',
      'Please change your input files and try again',
    ])('entrada recusada (%s) = safety', (message) => {
      expect(fallbackKindOf(message, false)).toBe('safety');
    });

    it('bloqueio já reconhecido = safety, mesmo com texto de 500', () => {
      expect(fallbackKindOf('Internal Server Error', true)).toBe('safety');
    });
  });

  describe('hasUserMedia', () => {
    it('reconhece foto, quadro, referência, vídeo, áudio e as flags', () => {
      const cases: Array<Record<string, unknown>> = [
        { imageUrl: 'https://cdn/a.jpg' },
        { imageUrls: ['https://cdn/a.jpg'] },
        { lastImageUrl: 'https://cdn/a.jpg' },
        { firstFrameUrl: 'https://cdn/a.jpg' },
        { lastFrameUrl: 'https://cdn/a.jpg' },
        { referenceImageUrls: ['https://cdn/a.jpg'] },
        { referenceVideoUrls: ['https://cdn/a.mp4'] },
        { referenceAudioUrls: ['https://cdn/a.mp3'] },
        { videoUrl: 'https://cdn/a.mp4' },
        { videoList: [{ url: 'https://cdn/a.mp4', start: 0, ends: 4 }] },
        { hasInputImages: true },
        { hasVideoInput: true },
      ];
      for (const media of cases) {
        expect(hasUserMedia({ ...base, prompt: 'p', ...media } as unknown as GenerationJobData, {})).toBe(true);
      }
    });

    it('lista vazia, texto vazio e flag false não contam; URLs carregadas do banco contam', () => {
      const empty = { ...base, prompt: 'p', imageUrls: [], imageUrl: '  ', hasInputImages: false, hasVideoInput: false } as unknown as GenerationJobData;
      expect(hasUserMedia(empty, {})).toBe(false);
      expect(hasUserMedia(empty, { inputImageUrls: [] })).toBe(false);
      expect(hasUserMedia(empty, { inputImageUrls: ['https://cdn/in.jpg'] })).toBe(true);
    });
  });

  it('isUncensoredFallbackModel: MiniMax e slugs sem filtro sim; alvos com filtro não', () => {
    for (const model of ['wavespeed-minimax-h3', 'sem-censura', 'wavespeed-ltx-spicy', 'Modelo-Uncensored-Novo']) {
      expect(isUncensoredFallbackModel(model)).toBe(true);
    }
    for (const model of ['veo3_fast', 'bytedance-seedance-2', 'nano-banana-2', 'gemini-3-pro-image-preview']) {
      expect(isUncensoredFallbackModel(model)).toBe(false);
    }
  });
});
