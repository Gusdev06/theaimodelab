import { GenerationType } from '@prisma/client';
import {
  ComfyDeployImageToVideoJobData,
  GenerationJobData,
  GenerationJobName,
  ImageJobData,
  ImageNanoBananaJobData,
  ImageToVideoGrokJobData,
  ImageToVideoKieJobData,
  KlingImageToVideoJobData,
  MinimaxH3ImageToVideoJobData,
  MinimaxH3ReferenceToVideoJobData,
  MinimaxH3TextToVideoJobData,
  MotionControlJobData,
  OmniVideoJobData,
  ReferenceToVideoKieJobData,
  SeedanceVideoJobData,
  TextToVideoGrokJobData,
  TextToVideoKieJobData,
  WavespeedImageToVideoJobData,
  WavespeedSeedanceImageToVideoJobData,
} from './generation-queue.constants';
import {
  classifyGenerationFailure,
  GenerationFailureCode,
} from '../errors/failure-reason';

/**
 * Plano de fallback: quando o provedor de um modelo falha, qual modelo
 * alternativo roda a MESMA geração (mesmo id, mesmos créditos já debitados).
 *
 * Regras:
 *  - Uma alternativa por modelo, de preferência em OUTRO provedor (queda da
 *    kie não derruba a WaveSpeed e vice-versa).
 *  - `provider` = falha técnica (500, timeout, cota).
 *    `safety` = bloqueio de conteúdo depois do refinamento de prompt, e também
 *    entrada recusada pelo provedor (a mídia enviada foi o motivo; ver
 *    `fallbackKindOf`). Só vale para os modelos de vídeo da kie, que caem no
 *    MiniMax H3 (tolerante a +18, como a plataforma vende). Imagem já tem o
 *    próprio caminho (Unlocked).
 *  - Guarda de mídia: nenhum desvio para modelo sem censura leva a mídia do
 *    usuário (foto, quadro, referência, vídeo, áudio), qualquer que seja o
 *    motivo, salvo `allowUncensoredWithMedia` (env, padrão desligado). Ver
 *    `evaluateFallback`.
 *  - Recusa por menor (`isMinorRefusal`) nunca chega aqui: o processador
 *    encerra a geração antes do plano, sem desvio nenhum e sem retry.
 *  - O cliente nunca paga mais do que foi cobrado: se a alternativa custa
 *    menos, o processador estorna a diferença (`billing`); se custa mais, a
 *    plataforma absorve. As escolhas abaixo foram conferidas contra o custo
 *    real de cada provedor (auditoria de créditos de 14/10/2026).
 *  - Fallback de fallback não existe: a alternativa roda uma vez e, se falhar,
 *    o erro ORIGINAL é o que chega ao usuário.
 */
export type FallbackKind = 'provider' | 'safety';

export interface FallbackBilling {
  type: GenerationType;
  resolution: string;
  durationSeconds?: number;
  hasAudio: boolean;
  hasVideoInput: boolean;
}

export interface FallbackPlan {
  jobName: GenerationJobName;
  data: GenerationJobData;
  /** Slug do modelo alternativo (como aparece em `modelUsed`). */
  model: string;
  /** Variante de cobrança do alternativo (credit_costs). */
  modelVariant: string;
  /** Parâmetros para recalcular o preço do que rodou de fato. */
  billing: FallbackBilling;
  kind: FallbackKind;
}

export interface FallbackContext {
  kind: FallbackKind;
  /** `generation.modelUsed` no momento da falha. */
  originalModel: string;
  generationType: GenerationType;
  /** Duração gravada na geração (Motion Control não leva no job). */
  durationSeconds?: number | null;
  /** Proporção gravada na geração (para alternativas que exigem uma). */
  aspectRatio?: string | null;
  /** URLs públicas das imagens de input (jobs de imagem que só têm `hasInputImages`). */
  inputImageUrls?: string[];
  /**
   * Libera desvio para modelo sem censura em geração com mídia do usuário
   * (env `GENERATION_FALLBACK_UNCENSORED_WITH_MEDIA`). Omitido = bloqueado.
   */
  allowUncensoredWithMedia?: boolean;
}

/**
 * Por que o desvio não roda. `MINOR_REFUSAL` = o provedor recusou por menor
 * (o processador barra antes do plano).
 */
export type FallbackBlockReason =
  | 'UNCENSORED_WITH_USER_MEDIA'
  | 'MINOR_REFUSAL';

export interface FallbackDecision {
  /** Plano que pode rodar; null = sem alternativa (ou bloqueada). */
  plan: FallbackPlan | null;
  /** Preenchido quando havia alternativa, mas a guarda barrou. */
  blocked?: { reason: FallbackBlockReason; model: string };
}

/**
 * Alvos sem filtro de conteúdo. Mesma lista de `isUncensoredModel`
 * (src/content-safety/content-safety.interceptor.ts, PR #4): no merge, trocar
 * por ela e apagar esta cópia.
 */
const UNCENSORED_MODELS: ReadonlySet<string> = new Set([
  'sem-censura',
  'sem-censura-fallback',
  'deepdeep',
  'wavespeed-ltx-spicy',
  'wavespeed-seedance-spicy',
  'comfydeploy-wan',
  // MiniMax H3 (WaveSpeed): sem filtro na prática, alvo universal dos vídeos.
  'wavespeed-minimax-h3',
]);
/** Slug que se apresenta como sem filtro entra na regra antes de entrar na lista. */
const UNCENSORED_SLUG = /sem-censura|unlocked|uncensored|spicy|nsfw/;

export function isUncensoredFallbackModel(model: string): boolean {
  const slug = model.trim().toLowerCase();
  return UNCENSORED_MODELS.has(slug) || UNCENSORED_SLUG.test(slug);
}

/** Campos de job que carregam mídia enviada pelo usuário (URL, lista ou flag). */
const USER_MEDIA_FIELDS = [
  'imageUrl',
  'imageUrls',
  'lastImageUrl',
  'firstFrameUrl',
  'lastFrameUrl',
  'referenceImageUrls',
  'referenceVideoUrls',
  'referenceAudioUrls',
  'videoUrl',
  'videoList',
  'sourceImageUrl',
  'targetImageUrl',
  'audioUrl',
  'hasInputImages',
  'hasVideoInput',
] as const;

function carriesUserMedia(data: GenerationJobData): boolean {
  const fields = data as unknown as Record<string, unknown>;
  return USER_MEDIA_FIELDS.some((field) => {
    const value = fields[field];
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return value === true;
  });
}

/** A geração (ou o plano montado a partir dela) leva mídia do usuário ao provedor? */
export function hasUserMedia(
  data: GenerationJobData,
  ctx: Pick<FallbackContext, 'inputImageUrls'>,
): boolean {
  return carriesUserMedia(data) || (ctx.inputImageUrls?.length ?? 0) > 0;
}

/**
 * Motivo do desvio a partir do erro do provedor. "Entrada recusada" (a mídia
 * enviada foi rejeitada, sem código de segurança) conta como segurança, não
 * como falha técnica: o motivo pode ser justamente o que a trava quer barrar.
 */
export function fallbackKindOf(
  rawErrorText: string,
  safetyError: boolean,
): FallbackKind {
  if (safetyError) return 'safety';
  return classifyGenerationFailure(rawErrorText, false) ===
    GenerationFailureCode.INPUT_IMAGE_REJECTED
    ? 'safety'
    : 'provider';
}

const MINIMAX_MODEL = 'wavespeed-minimax-h3';
const MINIMAX_VARIANT = 'WAVESPEED_MINIMAX_H3';
const MINIMAX_ASPECTS = new Set([
  '16:9',
  '9:16',
  '1:1',
  '4:3',
  '3:4',
  '21:9',
  '9:21',
]);
const SEEDANCE_MODEL = 'bytedance-seedance-2';
const SEEDANCE_VARIANT = 'SEEDANCE_2';
const SEEDANCE_KIE_ID = 'bytedance/seedance-2' as const;
const SEEDANCE_ASPECTS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9']);

/** Prompt sintético para o Motion Control cair no MiniMax (o job não tem prompt). */
export const MOTION_CONTROL_FALLBACK_PROMPT =
  'Use the reference video for the body motion and camera movement, and the reference image for the character identity, outfit and body. Keep the same framing and pacing. Photorealistic, natural lighting.';

const GEMINI_BY_NANO_BANANA: Record<string, string> = {
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  'nano-banana-pro': 'gemini-3-pro-image-preview',
};

function base(data: GenerationJobData) {
  return {
    generationId: data.generationId,
    userId: data.userId,
    creditsConsumed: data.creditsConsumed,
    usedFreeGeneration: data.usedFreeGeneration,
  };
}

/** MiniMax só tem 480p e 768p (RES_720P no banco). */
function minimaxResolution(resolution: string): 'RES_480P' | 'RES_720P' {
  return resolution === 'RES_480P' ? 'RES_480P' : 'RES_720P';
}

function clamp(
  seconds: number | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!seconds || !Number.isFinite(seconds)) return fallback;
  return Math.min(max, Math.max(min, Math.round(seconds)));
}

function pickAspect(
  aspect: string | null | undefined,
  allowed: Set<string>,
): string | undefined {
  if (!aspect) return undefined;
  if (allowed.has(aspect)) return aspect;
  if (aspect === '9:21') return allowed.has('9:16') ? '9:16' : undefined;
  return undefined;
}

function minimaxText(
  data: GenerationJobData,
  prompt: string,
  resolution: string,
  durationSeconds: number | null | undefined,
  aspectRatio: string | null | undefined,
  kind: FallbackKind,
): FallbackPlan {
  const res = minimaxResolution(resolution);
  const duration = clamp(durationSeconds, 5, 15, 5);
  const job: MinimaxH3TextToVideoJobData = {
    ...base(data),
    prompt,
    resolution: res,
    durationSeconds: duration,
    aspectRatio: pickAspect(aspectRatio, MINIMAX_ASPECTS),
    generateAudio: true,
  };
  return {
    jobName: GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO,
    data: job,
    model: MINIMAX_MODEL,
    modelVariant: MINIMAX_VARIANT,
    billing: {
      type: GenerationType.TEXT_TO_VIDEO,
      resolution: res,
      durationSeconds: duration,
      hasAudio: true,
      hasVideoInput: false,
    },
    kind,
  };
}

function minimaxImage(
  data: GenerationJobData,
  prompt: string,
  imageUrl: string,
  lastImageUrl: string | undefined,
  resolution: string,
  durationSeconds: number | null | undefined,
  kind: FallbackKind,
): FallbackPlan {
  const res = minimaxResolution(resolution);
  const duration = clamp(durationSeconds, 5, 15, 5);
  const job: MinimaxH3ImageToVideoJobData = {
    ...base(data),
    prompt,
    resolution: res,
    durationSeconds: duration,
    imageUrl,
    lastImageUrl,
    generateAudio: true,
  };
  return {
    jobName: GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO,
    data: job,
    model: MINIMAX_MODEL,
    modelVariant: MINIMAX_VARIANT,
    billing: {
      type: GenerationType.IMAGE_TO_VIDEO,
      resolution: res,
      durationSeconds: duration,
      hasAudio: true,
      hasVideoInput: false,
    },
    kind,
  };
}

function minimaxReference(
  data: GenerationJobData,
  prompt: string,
  refs: { images?: string[]; videos?: string[]; audios?: string[] },
  resolution: string,
  durationSeconds: number | null | undefined,
  aspectRatio: string | null | undefined,
  kind: FallbackKind,
): FallbackPlan {
  const res = minimaxResolution(resolution);
  const duration = clamp(durationSeconds, 5, 15, 5);
  const job: MinimaxH3ReferenceToVideoJobData = {
    ...base(data),
    prompt,
    resolution: res,
    durationSeconds: duration,
    aspectRatio: pickAspect(aspectRatio, MINIMAX_ASPECTS),
    referenceImageUrls: refs.images?.length ? refs.images : undefined,
    referenceVideoUrls: refs.videos?.length ? refs.videos : undefined,
    referenceAudioUrls: refs.audios?.length ? refs.audios : undefined,
    generateAudio: true,
  };
  return {
    jobName: GenerationJobName.MINIMAX_H3_REFERENCE_TO_VIDEO,
    data: job,
    model: MINIMAX_MODEL,
    modelVariant: MINIMAX_VARIANT,
    billing: {
      type: GenerationType.REFERENCE_VIDEO,
      resolution: res,
      durationSeconds: duration,
      hasAudio: true,
      hasVideoInput: false,
    },
    kind,
  };
}

/** Qualquer entrada do MiniMax (texto, imagem ou referências) vira o modo certo. */
function minimaxAuto(
  data: GenerationJobData,
  prompt: string,
  inputs: {
    firstImageUrl?: string;
    lastImageUrl?: string;
    images?: string[];
    videos?: string[];
    audios?: string[];
  },
  resolution: string,
  durationSeconds: number | null | undefined,
  aspectRatio: string | null | undefined,
  kind: FallbackKind,
): FallbackPlan {
  const hasRefs =
    (inputs.videos?.length ?? 0) > 0 ||
    (inputs.audios?.length ?? 0) > 0 ||
    (inputs.images?.length ?? 0) > 1;
  if (hasRefs) {
    return minimaxReference(
      data,
      prompt,
      {
        images:
          inputs.images ??
          (inputs.firstImageUrl ? [inputs.firstImageUrl] : undefined),
        videos: inputs.videos,
        audios: inputs.audios,
      },
      resolution,
      durationSeconds,
      aspectRatio,
      kind,
    );
  }
  const single = inputs.firstImageUrl ?? inputs.images?.[0];
  if (single) {
    return minimaxImage(
      data,
      prompt,
      single,
      inputs.lastImageUrl,
      resolution,
      durationSeconds,
      kind,
    );
  }
  return minimaxText(
    data,
    prompt,
    resolution,
    durationSeconds,
    aspectRatio,
    kind,
  );
}

function kieNanoBanana(
  data: ImageJobData,
  model: 'nano-banana-2' | 'nano-banana-pro',
  inputImageUrls: string[] | undefined,
  kind: FallbackKind,
): FallbackPlan {
  // NB2/NBP só têm 1K/2K/4K na tabela; 3K (Seedream Lite) vira 2K.
  const resolution = data.resolution === 'RES_3K' ? 'RES_2K' : data.resolution;
  const job: ImageNanoBananaJobData = {
    ...base(data),
    prompt: data.prompt,
    model,
    resolution,
    aspectRatio: data.aspectRatio,
    outputFormat: data.mimeType === 'image/jpeg' ? 'jpeg' : 'png',
    imageUrls: inputImageUrls?.length ? inputImageUrls : undefined,
  };
  return {
    jobName: GenerationJobName.IMAGE_NANO_BANANA,
    data: job,
    model,
    modelVariant: model === 'nano-banana-pro' ? 'NBP' : 'NB2',
    billing: {
      type: inputImageUrls?.length
        ? GenerationType.IMAGE_TO_IMAGE
        : GenerationType.TEXT_TO_IMAGE,
      resolution,
      hasAudio: false,
      hasVideoInput: false,
    },
    kind,
  };
}

function ownProviderImage(
  data: ImageNanoBananaJobData,
  kind: FallbackKind,
): FallbackPlan | null {
  const geminiModel = GEMINI_BY_NANO_BANANA[data.model];
  if (!geminiModel) return null;
  const hasInputImages = (data.imageUrls?.length ?? 0) > 0;
  const job: ImageJobData = {
    ...base(data),
    prompt: data.prompt,
    model: geminiModel,
    resolution: data.resolution,
    aspectRatio: data.aspectRatio,
    mimeType: data.outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
    hasInputImages,
  };
  return {
    jobName: GenerationJobName.IMAGE,
    data: job,
    model: geminiModel,
    modelVariant: data.model === 'nano-banana-pro' ? 'NBP' : 'NB2',
    billing: {
      type: hasInputImages
        ? GenerationType.IMAGE_TO_IMAGE
        : GenerationType.TEXT_TO_IMAGE,
      resolution: data.resolution,
      hasAudio: false,
      hasVideoInput: false,
    },
    kind,
  };
}

function veoFast(
  data: TextToVideoKieJobData | ImageToVideoKieJobData,
  jobName: GenerationJobName,
  type: GenerationType,
  kind: FallbackKind,
): FallbackPlan {
  return {
    jobName,
    data: { ...data, model: 'veo3_fast' },
    model: 'veo3_fast',
    modelVariant: 'VEO_FAST',
    billing: {
      type,
      resolution: data.resolution,
      hasAudio: true,
      hasVideoInput: false,
    },
    kind,
  };
}

function seedance2(
  data: GenerationJobData,
  input: Omit<
    SeedanceVideoJobData,
    | keyof ReturnType<typeof base>
    | 'modelId'
    | 'generateAudio'
    | 'hasVideoInput'
  >,
  type: GenerationType,
  kind: FallbackKind,
): FallbackPlan {
  const hasVideoInput = (input.referenceVideoUrls?.length ?? 0) > 0;
  const duration = clamp(input.durationSeconds, 4, 15, 5);
  const job: SeedanceVideoJobData = {
    ...base(data),
    ...input,
    durationSeconds: duration,
    modelId: SEEDANCE_KIE_ID,
    generateAudio: true,
    hasVideoInput,
  };
  return {
    jobName: GenerationJobName.SEEDANCE_VIDEO,
    data: job,
    model: SEEDANCE_MODEL,
    modelVariant: SEEDANCE_VARIANT,
    billing: {
      type,
      resolution: input.resolution,
      durationSeconds: duration,
      hasAudio: true,
      hasVideoInput,
    },
    kind,
  };
}

/**
 * Decide o desvio: monta a alternativa e aplica a guarda de mídia. Desvio
 * para modelo sem censura com mídia do usuário não roda, qualquer que seja o
 * motivo (`provider` ou `safety`), salvo `allowUncensoredWithMedia`.
 * Quando a trava de conteúdo (PR #4) e o porteiro da foto entrarem, a
 * liberação deixa de ser o env e passa a ser "só com preflight limpo".
 */
export function evaluateFallback(
  jobName: string,
  data: GenerationJobData,
  ctx: FallbackContext,
): FallbackDecision {
  const plan = planAlternative(jobName, data, ctx);
  if (!plan) return { plan: null };
  if (
    !ctx.allowUncensoredWithMedia &&
    isUncensoredFallbackModel(plan.model) &&
    (hasUserMedia(data, ctx) || carriesUserMedia(plan.data))
  ) {
    return {
      plan: null,
      blocked: { reason: 'UNCENSORED_WITH_USER_MEDIA', model: plan.model },
    };
  }
  return { plan };
}

/** Atalho de `evaluateFallback` para quem só precisa do plano. */
export function planFallback(
  jobName: string,
  data: GenerationJobData,
  ctx: FallbackContext,
): FallbackPlan | null {
  return evaluateFallback(jobName, data, ctx).plan;
}

/** Mapa de alternativas, sem a guarda de mídia. */
function planAlternative(
  jobName: string,
  data: GenerationJobData,
  ctx: FallbackContext,
): FallbackPlan | null {
  const { kind } = ctx;
  const name = jobName as GenerationJobName;

  switch (name) {
    // ── Imagem: só falha técnica (bloqueio já cai no Unlocked dentro do processador)
    case GenerationJobName.IMAGE:
    case GenerationJobName.IMAGE_WITH_FALLBACK: {
      if (kind === 'safety') return null;
      const d = data as ImageJobData;
      const urls = d.hasInputImages ? ctx.inputImageUrls : undefined;
      if (d.hasInputImages && !urls?.length) return null;
      switch (d.model) {
        case 'nano-banana-2':
        case 'gemini-3.1-flash-image-preview':
          // IMAGE_WITH_FALLBACK já tentou a kie por dentro — não repete.
          return name === GenerationJobName.IMAGE
            ? kieNanoBanana(d, 'nano-banana-2', urls, kind)
            : null;
        case 'nano-banana-pro':
        case 'gemini-3-pro-image-preview':
          return name === GenerationJobName.IMAGE
            ? kieNanoBanana(d, 'nano-banana-pro', urls, kind)
            : null;
        case 'gpt-image-2':
        case 'gpt-image-2-5':
        case 'seedream-5-lite':
          return kieNanoBanana(d, 'nano-banana-2', urls, kind);
        default:
          // sem-censura e deepdeep rodam no motor sem censura: não há alternativa.
          return null;
      }
    }

    case GenerationJobName.IMAGE_NANO_BANANA: {
      if (kind === 'safety') return null;
      return ownProviderImage(data as ImageNanoBananaJobData, kind);
    }

    // ── Veo (kie): Quality cai no Fast; Fast cai no MiniMax (outro provedor)
    case GenerationJobName.TEXT_TO_VIDEO_KIE: {
      const d = data as TextToVideoKieJobData;
      if (d.model === 'veo3' && kind === 'provider') {
        return veoFast(
          d,
          GenerationJobName.TEXT_TO_VIDEO_KIE,
          GenerationType.TEXT_TO_VIDEO,
          kind,
        );
      }
      return minimaxText(d, d.prompt, d.resolution, 8, d.aspectRatio, kind);
    }

    case GenerationJobName.IMAGE_TO_VIDEO_KIE: {
      const d = data as ImageToVideoKieJobData;
      if (d.model === 'veo3' && kind === 'provider') {
        return veoFast(
          d,
          GenerationJobName.IMAGE_TO_VIDEO_KIE,
          GenerationType.IMAGE_TO_VIDEO,
          kind,
        );
      }
      if (!d.imageUrls?.[0]) return null;
      return minimaxImage(
        d,
        d.prompt,
        d.imageUrls[0],
        d.imageUrls[1],
        d.resolution,
        8,
        kind,
      );
    }

    case GenerationJobName.REFERENCE_TO_VIDEO_KIE: {
      const d = data as ReferenceToVideoKieJobData;
      return minimaxAuto(
        d,
        d.prompt,
        { images: d.imageUrls },
        d.resolution,
        8,
        d.aspectRatio,
        kind,
      );
    }

    case GenerationJobName.OMNI_VIDEO: {
      const d = data as OmniVideoJobData;
      return minimaxAuto(
        d,
        d.prompt,
        {
          images: d.imageUrls,
          videos: d.videoList?.map((clip) => clip.url),
        },
        d.resolution,
        d.durationSeconds,
        d.aspectRatio,
        kind,
      );
    }

    case GenerationJobName.SEEDANCE_VIDEO: {
      const d = data as SeedanceVideoJobData;
      return minimaxAuto(
        d,
        d.prompt,
        {
          firstImageUrl: d.firstFrameUrl,
          lastImageUrl: d.lastFrameUrl,
          images: d.referenceImageUrls,
          videos: d.referenceVideoUrls,
          audios: d.referenceAudioUrls,
        },
        d.resolution,
        d.durationSeconds,
        d.aspectRatio === 'adaptive' ? undefined : d.aspectRatio,
        kind,
      );
    }

    case GenerationJobName.KLING_IMAGE_TO_VIDEO: {
      const d = data as KlingImageToVideoJobData;
      if (!d.imageUrls?.[0]) return null;
      return minimaxImage(
        d,
        d.prompt ?? '',
        d.imageUrls[0],
        undefined,
        d.resolution,
        d.durationSeconds,
        kind,
      );
    }

    case GenerationJobName.MOTION_CONTROL: {
      const d = data as MotionControlJobData;
      // MiniMax aceita até 15 s; vídeo de referência mais longo não tem alternativa.
      if (!ctx.durationSeconds || ctx.durationSeconds > 15) return null;
      return minimaxReference(
        d,
        MOTION_CONTROL_FALLBACK_PROMPT,
        { images: [d.imageUrl], videos: [d.videoUrl] },
        d.resolution,
        ctx.durationSeconds,
        // Sem proporção o MiniMax devolve 16:9; Motion Control é dança/Reels
        // (testado em produção 14/10: vídeo vertical virava horizontal).
        pickAspect(ctx.aspectRatio, MINIMAX_ASPECTS) ?? '9:16',
        kind,
      );
    }

    case GenerationJobName.IMAGE_TO_VIDEO_GROK: {
      const d = data as ImageToVideoGrokJobData;
      if (!d.imageUrls?.[0]) return null;
      return minimaxImage(
        d,
        d.prompt ?? '',
        d.imageUrls[0],
        undefined,
        d.resolution,
        d.durationSeconds,
        kind,
      );
    }

    case GenerationJobName.TEXT_TO_VIDEO_GROK: {
      const d = data as TextToVideoGrokJobData;
      return minimaxText(
        d,
        d.prompt,
        d.resolution,
        d.durationSeconds,
        d.aspectRatio,
        kind,
      );
    }

    case GenerationJobName.COMFYDEPLOY_IMAGE_TO_VIDEO: {
      const d = data as ComfyDeployImageToVideoJobData;
      return minimaxImage(
        d,
        d.prompt,
        d.imageUrl,
        undefined,
        d.resolution,
        d.durationSeconds,
        kind,
      );
    }

    // ── WaveSpeed +18: só falha técnica; bloqueio neles não tem alternativa
    case GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO: {
      if (kind === 'safety') return null;
      const d = data as WavespeedImageToVideoJobData;
      return minimaxImage(
        d,
        d.prompt,
        d.imageUrl,
        undefined,
        d.resolution,
        d.durationSeconds,
        kind,
      );
    }

    case GenerationJobName.WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO: {
      if (kind === 'safety') return null;
      const d = data as WavespeedSeedanceImageToVideoJobData;
      return minimaxImage(
        d,
        d.prompt,
        d.imageUrl,
        undefined,
        d.resolution,
        d.durationSeconds,
        kind,
      );
    }

    // ── MiniMax (WaveSpeed) cai no Seedance 2.0 (kie): outro provedor, custo baixo
    case GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO: {
      if (kind === 'safety') return null;
      const d = data as MinimaxH3TextToVideoJobData;
      return seedance2(
        d,
        {
          prompt: d.prompt,
          resolution: d.resolution,
          durationSeconds: d.durationSeconds,
          aspectRatio: pickAspect(d.aspectRatio, SEEDANCE_ASPECTS),
        },
        GenerationType.TEXT_TO_VIDEO,
        kind,
      );
    }

    case GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO: {
      if (kind === 'safety') return null;
      const d = data as MinimaxH3ImageToVideoJobData;
      // Seedance 2.0 não tem first frame: a imagem vira referência. Sem proporção
      // conhecida, 9:16 (formato dominante da plataforma).
      return seedance2(
        d,
        {
          prompt: d.prompt,
          resolution: d.resolution,
          durationSeconds: d.durationSeconds,
          aspectRatio: pickAspect(ctx.aspectRatio, SEEDANCE_ASPECTS) ?? '9:16',
          referenceImageUrls: d.lastImageUrl
            ? [d.imageUrl, d.lastImageUrl]
            : [d.imageUrl],
        },
        GenerationType.REFERENCE_VIDEO,
        kind,
      );
    }

    case GenerationJobName.MINIMAX_H3_REFERENCE_TO_VIDEO: {
      if (kind === 'safety') return null;
      const d = data as MinimaxH3ReferenceToVideoJobData;
      return seedance2(
        d,
        {
          prompt: d.prompt,
          resolution: d.resolution,
          durationSeconds: d.durationSeconds,
          aspectRatio: pickAspect(d.aspectRatio, SEEDANCE_ASPECTS),
          referenceImageUrls: d.referenceImageUrls,
          referenceVideoUrls: d.referenceVideoUrls,
          referenceAudioUrls: d.referenceAudioUrls,
        },
        GenerationType.REFERENCE_VIDEO,
        kind,
      );
    }

    // Vertex (theaimodelab-fast/quality, desligados), try-on, face swap, áudio:
    // sem alternativa automática.
    default:
      return null;
  }
}
