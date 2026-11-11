import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ProviderFailureError } from '../errors/failure-reason';
import { adultSafePrompt } from '../../content-safety/adult-anchor';

/**
 * Teto do prompt que vai à WaveSpeed (o mesmo dos DTOs de vídeo): a âncora de adulto entra no fim sem passar dele.
 * Todo vídeo daqui sai num modelo sem filtro ou que aceita cena adulta (LTX Spicy, Seedance Spicy, MiniMax H3, Wan):
 * a âncora vai em todos.
 */
const PROMPT_MAX_WITH_ANCHOR = 2500;

/**
 * WaveSpeed — LTX 2.3 Spicy (image-to-video, NSFW).
 *
 * Mesma API assíncrona do provider de áudio (wavespeed-audio.provider.ts):
 *   POST /api/v3/{model}                     -> { data: { id } }
 *   GET  /api/v3/predictions/{id}/result     -> { data: { status, outputs } }
 *
 * A geração leva minutos, então criamos a prediction e fazemos polling até
 * `completed`. Diferente do WAN (ComfyDeploy), o LTX aceita a duração em
 * SEGUNDOS direto (3–20) — o WaveSpeed fatura no MÍNIMO 5s, então travamos o
 * piso em 5s. Resolução: 480p / 720p / 1080p. Preset `tuned` (recomendado).
 */

const LTX_MODEL = 'wavespeed-ai/ltx-2.3-spicy/image-to-video';
const SEEDANCE_MODEL = 'bytedance/seedance-2.0-fast/image-to-video-spicy';

// MiniMax H3 — modelo geral (não-NSFW), áudio nativo sempre incluso, 5–15s.
// Resoluções 480p / 768p (768p é o canvas nativo). Três modos:
const MINIMAX_H3_T2V_MODEL = 'wavespeed-ai/minimax-h3/text-to-video';
const MINIMAX_H3_I2V_MODEL = 'wavespeed-ai/minimax-h3/image-to-video';
const MINIMAX_H3_REF_MODEL = 'wavespeed-ai/minimax-h3/reference-to-video';
/** Avatar falante: foto + áudio → vídeo com boca sincronizada (docs: image e audio, URL ou base64; US$ 0,10 por segundo cobrado, mínimo 4 s, máximo 300 s) */
const OMNIHUMAN_MODEL = 'bytedance/omni-human-2.0';
const WAN_ANIMATE_MODEL = 'wavespeed-ai/wan-2.2/animate';
/** Ângulos da mesma foto (imagem, não vídeo): docs `images` (até 3), horizontal_angle, vertical_angle, distance; US$ 0,025 por foto */
const MULTIPLE_ANGLES_MODEL = 'wavespeed-ai/qwen-image/edit-multiple-angles';
const WAN3_REFERENCE_MODEL = 'alibaba/wan-3.0/reference-to-video';

const POLL_MAX_ATTEMPTS = 180; // ~9 min a 3s
const POLL_INTERVAL_MS = 3_000;
/**
 * Consulta que falha por instante (429, 5xx, rede, tempo esgotado): a tarefa já foi aceita e cobrada na WaveSpeed,
 * então a consulta espera e tenta de novo (3 s, 6 s, depois 10 s) em vez de perder o resultado. A 6ª falha seguida
 * encerra; cada resposta boa zera a conta.
 */
const POLL_TRANSIENT_MAX = 6;
const POLL_BACKOFF_MIN_MS = 3_000;
const POLL_BACKOFF_MAX_MS = 10_000;
/** Teto da espera pedida por um Retry-After. */
const POLL_RETRY_AFTER_MAX_MS = 60_000;

/** O que a geração entrega, para a mensagem de erro falar de foto ou de vídeo. */
export type WavespeedMedia = 'foto' | 'vídeo';

const FAILURE_MESSAGES: Record<
  WavespeedMedia,
  { unavailable: string; unexpected: string; missingOutput: string; failed: string; tooSlow: string }
> = {
  vídeo: {
    unavailable: 'Não foi possível gerar o vídeo agora. Tente novamente em alguns instantes.',
    unexpected: 'O serviço de vídeo não respondeu como esperado. Tente novamente em alguns instantes.',
    missingOutput: 'A geração foi concluída mas o vídeo não pôde ser recuperado. Tente novamente.',
    failed: 'A geração de vídeo falhou. Tente novamente.',
    tooSlow: 'A geração de vídeo demorou mais que o esperado. Tente novamente em alguns instantes.',
  },
  foto: {
    unavailable: 'Não foi possível gerar a foto agora. Tente novamente em alguns instantes.',
    unexpected: 'O serviço de imagem não respondeu como esperado. Tente novamente em alguns instantes.',
    missingOutput: 'A foto ficou pronta, mas não conseguimos buscá-la. Tente novamente.',
    failed: 'A geração da foto falhou. Tente novamente.',
    tooSlow: 'A foto demorou mais que o esperado. Tente novamente em alguns instantes.',
  },
};

/** Estados em que a WaveSpeed não vai mais entregar nada (docs: completed, failed, cancelled, timeout, deleted). */
const FINAL_FAILURE_STATUSES: ReadonlySet<string> = new Set(['failed', 'cancelled', 'timeout', 'deleted']);

/** Status HTTP de consulta que vale esperar e repetir. */
export function isTransientPollStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Espera antes de repetir a consulta depois da N-ª falha passageira seguida: 3 s, 6 s, 10 s… O Retry-After (segundos
 * ou data HTTP) vale quando pede mais que isso, até 60 s.
 */
export function transientPollDelayMs(streak: number, retryAfter: string | null, now: number = Date.now()): number {
  const backoff = Math.min(POLL_BACKOFF_MIN_MS * 2 ** Math.max(streak - 1, 0), POLL_BACKOFF_MAX_MS);
  if (!retryAfter) return backoff;
  const trimmed = retryAfter.trim();
  let requested: number | null = null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    requested = Number(trimmed) * 1000;
  } else {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) requested = date - now;
  }
  if (requested === null || !Number.isFinite(requested)) return backoff;
  return Math.min(Math.max(backoff, requested), POLL_RETRY_AFTER_MAX_MS);
}

export type WavespeedVideoResolution = '480p' | '720p' | '768p' | '1080p';
export type SeedanceVideoResolution = '480p' | '720p' | '1080p' | '4k';
export type WavespeedVideoPreset = 'tuned' | 'original';
export type SeedanceAspectRatio = '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9';

/** MiniMax H3 — só expõe 480p (mais barato/rápido) e 768p (nativo). */
export type MinimaxH3Resolution = '480p' | '768p';
/** MiniMax H3 aspect ratios suportados (text/reference; image segue a imagem). */
export type MinimaxH3AspectRatio =
  | '16:9'
  | '9:16'
  | '1:1'
  | '4:3'
  | '3:4'
  | '21:9'
  | '9:21';

export interface WavespeedImageToVideoInput {
  id: string;
  prompt: string;
  /** URL pública da imagem de entrada (primeiro frame). */
  imageUrl: string;
  durationSeconds: number;
  resolution: WavespeedVideoResolution;
  preset?: WavespeedVideoPreset;
}

export interface SeedanceSpicyImageToVideoInput {
  id: string;
  prompt: string;
  imageUrl: string;
  durationSeconds: number;
  resolution: SeedanceVideoResolution;
  aspectRatio?: SeedanceAspectRatio;
  generateAudio: boolean;
}

export interface MinimaxH3TextToVideoInput {
  id: string;
  prompt: string;
  durationSeconds: number;
  resolution: MinimaxH3Resolution;
  aspectRatio?: MinimaxH3AspectRatio;
}

export interface MinimaxH3ImageToVideoInput {
  id: string;
  prompt: string;
  /** URL pública da imagem de entrada (primeiro frame). */
  imageUrl: string;
  /** URL pública do último frame (opcional — interpola do primeiro para este). */
  lastImageUrl?: string;
  durationSeconds: number;
  resolution: MinimaxH3Resolution;
}

/** Wan 3.0 reference-to-video: "Image 1" = a foto (quem), "Video 1" = o vídeo (movimento e cena); gera a cena de novo. */
export interface Wan3ReferenceInput {
  id: string;
  prompt: string;
  imageUrls: string[];
  videoUrls: string[];
  resolution: '480p' | '720p' | '1080p';
  aspectRatio: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
  durationSeconds: number;
  generateAudio?: boolean;
}

/** Wan 2.2 Animate: URLs públicas da foto (quem entra) e do vídeo (movimento/cena). */
export interface WanAnimateInput {
  id: string;
  imageUrl: string;
  videoUrl: string;
  mode: 'replace' | 'animate';
  resolution: '480p' | '720p';
  /** orientação curta opcional */
  prompt?: string;
}

export interface MinimaxH3ReferenceToVideoInput {
  id: string;
  prompt: string;
  durationSeconds: number;
  resolution: MinimaxH3Resolution;
  aspectRatio?: MinimaxH3AspectRatio;
  /** URLs públicas — citadas no prompt como <Picture 1>..<Picture 9>. Máx 9. */
  referenceImageUrls?: string[];
  /** URLs públicas — <Video 1>..<Video 3>. Máx 3, 480p, total ≤15s. */
  referenceVideoUrls?: string[];
  /** URLs públicas — <Audio 1>..<Audio 3>. Máx 3, ≤15s cada. */
  referenceAudioUrls?: string[];
}

interface CreatePredictionResponse {
  data?: { id?: string };
  id?: string;
  code?: number;
  message?: string;
}

interface PredictionResultResponse {
  code?: number;
  message?: string;
  data?: {
    id: string;
    status: 'created' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'deleted';
    outputs?: string[];
    error?: string;
  };
}

export interface WavespeedMultipleAnglesInput {
  id: string;
  /** URL pública da foto (a nossa cópia guardada da geração de origem) */
  imageUrl: string;
  horizontalAngle: number;
  verticalAngle: number;
  distance: number;
}

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface WavespeedTalkingAvatarInput {
  id: string;
  imageUrl: string;
  audioUrl: string;
}

@Injectable()
export class WavespeedVideoProvider {
  private readonly logger = new Logger(WavespeedVideoProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'WAVESPEED_BASE_URL',
      'https://api.wavespeed.ai',
    );
    this.apiKey = (
      this.configService.get<string>('WAVESPEED_API_KEY', '') ?? ''
    ).trim();
    if (!this.apiKey) {
      this.logger.warn(
        'WAVESPEED_API_KEY is not set. LTX Spicy video generation will fail with a 401 from the provider.',
      );
    }
  }

  /**
   * Avatar falante (OmniHuman 2.0): a pessoa da foto fala o áudio. A foto e o áudio já estão no nosso armazenamento
   * (URLs públicas: a foto subida no pedido e o áudio do TTS da própria plataforma). O vídeo sai no formato do retrato.
   */
  async generateTalkingAvatar(input: WavespeedTalkingAvatarInput): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error('Não foi possível gerar o vídeo agora. Entre em contato com o suporte.');
    }
    if (!input.imageUrl) throw new Error('WaveSpeed OmniHuman: foto ausente.');
    if (!input.audioUrl) throw new Error('WaveSpeed OmniHuman: áudio ausente.');

    this.logger.log(`[WAVESPEED_OMNIHUMAN] gen=${input.id} image=${input.imageUrl.slice(0, 60)} audio=${input.audioUrl.slice(0, 60)}`);

    const predictionId = await this.createPrediction(OMNIHUMAN_MODEL, {
      image: input.imageUrl,
      audio: input.audioUrl,
      enable_base64_output: false,
    });
    const videoUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(videoUrl, input.id, 0);
    return { outputUrls: [outputUrl], modelUsed: OMNIHUMAN_MODEL };
  }

  /**
   * Ângulos (Qwen Image Edit Multiple Angles): a mesma foto vista de outro ângulo de câmera. Imagem, não vídeo: mora
   * aqui porque usa a mesma conta e o mesmo ciclo (criar → consultar → guardar). Sem prompt: o modelo monta o dele
   * pelo ângulo. A saída vai para generations/<id>/ no nosso armazenamento.
   */
  async generateMultipleAngles(input: WavespeedMultipleAnglesInput): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error('Não foi possível gerar a foto agora. Entre em contato com o suporte.');
    }
    if (!/^https:\/\//i.test(input.imageUrl)) throw new Error('WaveSpeed Multiple Angles: foto de origem ausente.');

    this.logger.log(
      `[WAVESPEED_ANGLES] gen=${input.id} h=${input.horizontalAngle} v=${input.verticalAngle} d=${input.distance} image=${input.imageUrl.slice(0, 60)}`,
    );

    const predictionId = await this.createPrediction(
      MULTIPLE_ANGLES_MODEL,
      {
        images: [input.imageUrl],
        horizontal_angle: input.horizontalAngle,
        vertical_angle: input.verticalAngle,
        distance: input.distance,
        output_format: 'jpeg',
        enable_base64_output: false,
        enable_sync_mode: false,
      },
      'foto',
    );
    const resultUrl = await this.pollPrediction(predictionId, 'foto');
    const outputUrl = await this.downloadAndUploadImage(resultUrl, input.id, 0);
    return { outputUrls: [outputUrl], modelUsed: MULTIPLE_ANGLES_MODEL };
  }

  async generateImageToVideo(
    input: WavespeedImageToVideoInput,
  ): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o vídeo agora. Entre em contato com o suporte.',
      );
    }
    if (!input.imageUrl) {
      throw new Error('WaveSpeed LTX: imagem de entrada ausente.');
    }

    // WaveSpeed fatura no mínimo 5s; o LTX aceita até 20s.
    const duration = Math.min(20, Math.max(5, Math.round(input.durationSeconds)));

    this.logger.log(
      `[WAVESPEED_LTX] gen=${input.id} resolution=${input.resolution} duration=${duration}s preset=${input.preset ?? 'tuned'} prompt="${input.prompt.slice(0, 80)}"`,
    );

    const predictionId = await this.createPrediction(LTX_MODEL, {
      image: input.imageUrl,
      prompt: adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR),
      preset: input.preset ?? 'tuned',
      resolution: input.resolution,
      duration,
      seed: -1,
    });
    this.logger.log(`[WAVESPEED_LTX] prediction created: ${predictionId}`);

    const resultUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: LTX_MODEL };
  }

  async generateSeedanceImageToVideo(
    input: SeedanceSpicyImageToVideoInput,
  ): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o vídeo agora. Entre em contato com o suporte.',
      );
    }
    if (!input.imageUrl) {
      throw new Error('WaveSpeed Seedance: imagem de entrada ausente.');
    }

    // Seedance 2.0 Fast aceita 4–15s.
    const duration = Math.min(15, Math.max(4, Math.round(input.durationSeconds)));

    this.logger.log(
      `[WAVESPEED_SEEDANCE] gen=${input.id} resolution=${input.resolution} duration=${duration}s aspect=${input.aspectRatio ?? 'auto'} audio=${input.generateAudio} prompt="${input.prompt.slice(0, 80)}"`,
    );

    const body: Record<string, unknown> = {
      image: input.imageUrl,
      prompt: adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR),
      resolution: input.resolution,
      duration,
      generate_audio: input.generateAudio,
      seed: -1,
    };
    // aspect_ratio é opcional — omitido, o Seedance adapta à imagem de entrada.
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;

    const predictionId = await this.createPrediction(SEEDANCE_MODEL, body);
    this.logger.log(`[WAVESPEED_SEEDANCE] prediction created: ${predictionId}`);

    const resultUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: SEEDANCE_MODEL };
  }

  // ─── MiniMax H3 — text-to-video ──────────────────────────────
  async generateMinimaxH3TextToVideo(
    input: MinimaxH3TextToVideoInput,
  ): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o vídeo agora. Entre em contato com o suporte.',
      );
    }

    const duration = Math.min(15, Math.max(5, Math.round(input.durationSeconds)));

    this.logger.log(
      `[MINIMAX_H3_T2V] gen=${input.id} resolution=${input.resolution} duration=${duration}s aspect=${input.aspectRatio ?? '16:9'} prompt="${input.prompt.slice(0, 80)}"`,
    );

    const body: Record<string, unknown> = {
      prompt: adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR),
      resolution: input.resolution,
      duration,
      seed: -1,
    };
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;

    const predictionId = await this.createPrediction(MINIMAX_H3_T2V_MODEL, body);
    this.logger.log(`[MINIMAX_H3_T2V] prediction created: ${predictionId}`);

    const resultUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: MINIMAX_H3_T2V_MODEL };
  }

  // ─── MiniMax H3 — image-to-video (aspect segue a imagem) ─────
  async generateMinimaxH3ImageToVideo(
    input: MinimaxH3ImageToVideoInput,
  ): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o vídeo agora. Entre em contato com o suporte.',
      );
    }
    if (!input.imageUrl) {
      throw new Error('MiniMax H3: imagem de entrada ausente.');
    }

    const duration = Math.min(15, Math.max(5, Math.round(input.durationSeconds)));

    this.logger.log(
      `[MINIMAX_H3_I2V] gen=${input.id} resolution=${input.resolution} duration=${duration}s lastFrame=${input.lastImageUrl ? 'yes' : 'no'} prompt="${input.prompt.slice(0, 80)}"`,
    );

    const body: Record<string, unknown> = {
      prompt: adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR),
      image: input.imageUrl,
      resolution: input.resolution,
      duration,
      seed: -1,
    };
    if (input.lastImageUrl) body.last_image = input.lastImageUrl;

    const predictionId = await this.createPrediction(MINIMAX_H3_I2V_MODEL, body);
    this.logger.log(`[MINIMAX_H3_I2V] prediction created: ${predictionId}`);

    const resultUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: MINIMAX_H3_I2V_MODEL };
  }

  // ─── Wan 2.2 Animate — troca de pessoa (replace) ou movimento (animate) ────────────
  /**
   * `replace`: a pessoa do vídeo vira a da foto, com o movimento, o cenário e a câmera do vídeo.
   * `animate`: a foto faz o movimento e as expressões do vídeo.
   * A WaveSpeed cobra por segundo do vídeo de entrada (mínimo 3 s): o submit não é repetido (um 2º envio cobraria de
   * novo); só a consulta do resultado é refeita.
   */
  async generateWanAnimate(input: WanAnimateInput): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o vídeo agora. Entre em contato com o suporte.',
      );
    }

    this.logger.log(
      `[WAN_ANIMATE] gen=${input.id} mode=${input.mode} resolution=${input.resolution} prompt="${(input.prompt ?? '').slice(0, 80)}"`,
    );

    const body: Record<string, unknown> = {
      image: input.imageUrl,
      video: input.videoUrl,
      mode: input.mode,
      resolution: input.resolution,
      seed: -1,
    };
    if (input.prompt) body.prompt = adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR);

    const predictionId = await this.createPrediction(WAN_ANIMATE_MODEL, body);
    this.logger.log(`[WAN_ANIMATE] prediction created: ${predictionId}`);

    const resultUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: WAN_ANIMATE_MODEL };
  }

  // ─── Wan 3.0 — reference-to-video (o motor dos templates do Genspicy) ────────────
  async generateWan3Reference(input: Wan3ReferenceInput): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o vídeo agora. Entre em contato com o suporte.',
      );
    }
    const duration = Math.min(30, Math.max(2, Math.round(input.durationSeconds)));
    this.logger.log(
      `[WAN3_REF] gen=${input.id} resolution=${input.resolution} aspect=${input.aspectRatio} duration=${duration}s images=${input.imageUrls.length} videos=${input.videoUrls.length} prompt="${input.prompt.slice(0, 80)}"`,
    );
    const body: Record<string, unknown> = {
      prompt: adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR),
      resolution: input.resolution,
      aspect_ratio: input.aspectRatio,
      duration,
      generate_audio: input.generateAudio ?? true,
      enable_prompt_expansion: false,
      seed: -1,
    };
    if (input.imageUrls.length) body.reference_images = input.imageUrls.slice(0, 10);
    if (input.videoUrls.length) body.reference_videos = input.videoUrls.slice(0, 5);

    const predictionId = await this.createPrediction(WAN3_REFERENCE_MODEL, body);
    this.logger.log(`[WAN3_REF] prediction created: ${predictionId}`);
    const resultUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);
    return { outputUrls: [outputUrl], modelUsed: WAN3_REFERENCE_MODEL };
  }

  // ─── MiniMax H3 — reference-to-video (multimodal) ────────────
  async generateMinimaxH3ReferenceToVideo(
    input: MinimaxH3ReferenceToVideoInput,
  ): Promise<GenerationResult> {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o vídeo agora. Entre em contato com o suporte.',
      );
    }

    const duration = Math.min(15, Math.max(5, Math.round(input.durationSeconds)));

    this.logger.log(
      `[MINIMAX_H3_REF] gen=${input.id} resolution=${input.resolution} duration=${duration}s aspect=${input.aspectRatio ?? '16:9'} refImages=${input.referenceImageUrls?.length ?? 0} refVideos=${input.referenceVideoUrls?.length ?? 0} refAudios=${input.referenceAudioUrls?.length ?? 0} prompt="${input.prompt.slice(0, 80)}"`,
    );

    const body: Record<string, unknown> = {
      prompt: adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR),
      resolution: input.resolution,
      duration,
      seed: -1,
    };
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
    if (input.referenceImageUrls?.length)
      body.reference_images = input.referenceImageUrls.slice(0, 9);
    if (input.referenceVideoUrls?.length)
      body.reference_videos = input.referenceVideoUrls.slice(0, 3);
    if (input.referenceAudioUrls?.length)
      body.reference_audios = input.referenceAudioUrls.slice(0, 3);

    const predictionId = await this.createPrediction(MINIMAX_H3_REF_MODEL, body);
    this.logger.log(`[MINIMAX_H3_REF] prediction created: ${predictionId}`);

    const resultUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: MINIMAX_H3_REF_MODEL };
  }

  private async createPrediction(
    model: string,
    body: Record<string, unknown>,
    media: WavespeedMedia = 'vídeo',
  ): Promise<string> {
    const messages = FAILURE_MESSAGES[media];
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v3/${model}`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      60_000,
    );

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(
        `WaveSpeed ${model} createPrediction failed status=${response.status} body=${errorText.slice(0, 300)}`,
      );
      throw new ProviderFailureError(
        messages.unavailable,
        `${response.status} ${errorText.slice(0, 300)}`,
      );
    }

    const data = (await response.json()) as CreatePredictionResponse;
    const predictionId = data.data?.id ?? data.id;
    if (!predictionId) {
      this.logger.error(
        `WaveSpeed ${model} createPrediction missing id: ${JSON.stringify(data).slice(0, 300)}`,
      );
      throw new Error(messages.unexpected);
    }
    return predictionId;
  }

  private async pollPrediction(predictionId: string, media: WavespeedMedia = 'vídeo'): Promise<string> {
    const messages = FAILURE_MESSAGES[media];
    let transientStreak = 0;
    let nextDelayMs = POLL_INTERVAL_MS;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.wait(nextDelayMs);
      nextDelayMs = POLL_INTERVAL_MS;

      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          `${this.baseUrl}/api/v3/predictions/${predictionId}/result`,
          { headers: this.headers() },
          30_000,
        );
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        transientStreak++;
        if (transientStreak >= POLL_TRANSIENT_MAX) {
          this.logger.error(`WaveSpeed result unreachable predictionId=${predictionId} after ${transientStreak} tries: ${detail}`);
          throw new ProviderFailureError(messages.unavailable, `network ${detail.slice(0, 200)}`);
        }
        nextDelayMs = transientPollDelayMs(transientStreak, null);
        this.logger.warn(
          `WaveSpeed result network error predictionId=${predictionId} (${transientStreak}/${POLL_TRANSIENT_MAX}), retry in ${nextDelayMs} ms: ${detail.slice(0, 120)}`,
        );
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        if (isTransientPollStatus(response.status)) {
          transientStreak++;
          if (transientStreak < POLL_TRANSIENT_MAX) {
            nextDelayMs = transientPollDelayMs(transientStreak, response.headers.get('retry-after'));
            this.logger.warn(
              `WaveSpeed result status=${response.status} predictionId=${predictionId} (${transientStreak}/${POLL_TRANSIENT_MAX}), retry in ${nextDelayMs} ms`,
            );
            continue;
          }
        }
        this.logger.error(
          `WaveSpeed result failed status=${response.status} predictionId=${predictionId} body=${errorText.slice(0, 200)}`,
        );
        throw new ProviderFailureError(
          messages.unavailable,
          `${response.status} ${errorText.slice(0, 200)}`,
        );
      }
      transientStreak = 0;

      const payload = (await response.json()) as PredictionResultResponse;
      const data = payload.data;
      if (!data) {
        throw new Error(messages.unexpected);
      }

      if (data.status === 'completed') {
        const resultUrl = data.outputs?.[0];
        if (!resultUrl) {
          throw new Error(messages.missingOutput);
        }
        return resultUrl;
      }

      if (data.status === 'failed') {
        this.logger.error(
          `WaveSpeed prediction failed predictionId=${predictionId} error=${data.error ?? 'unknown'}`,
        );
        throw new Error(data.error ?? messages.failed);
      }

      if (FINAL_FAILURE_STATUSES.has(data.status)) {
        this.logger.error(
          `WaveSpeed prediction ended status=${data.status} predictionId=${predictionId} error=${data.error ?? 'none'}`,
        );
        throw new ProviderFailureError(
          messages.failed,
          `status=${data.status}${data.error ? ` ${data.error.slice(0, 200)}` : ''}`,
        );
      }

      this.logger.debug(
        `WaveSpeed prediction ${predictionId} ${data.status} (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})`,
      );
    }

    throw new Error(messages.tooSlow);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async downloadAndUpload(
    sourceUrl: string,
    generationId: string,
    index: number,
  ): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download video from WaveSpeed (${response.status}): ${sourceUrl}`,
          );
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        return await this.uploadsService.uploadBuffer(
          buffer,
          `generations/${generationId}`,
          `output_${index}.mp4`,
          'video/mp4',
        );
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw lastError!;
  }

  /** Como o downloadAndUpload, mas para foto: o tipo vem da resposta (a WaveSpeed devolve jpeg, png ou webp). */
  private async downloadAndUploadImage(sourceUrl: string, generationId: string, index: number): Promise<string> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) throw new Error(`Failed to download image from WaveSpeed (${response.status})`);
        const declared = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const mimeType = IMAGE_EXTENSIONS[declared] ? declared : 'image/jpeg';
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) throw new Error('WaveSpeed devolveu uma foto vazia');
        return await this.uploadsService.uploadBuffer(
          buffer,
          `generations/${generationId}`,
          `output_${index}.${IMAGE_EXTENSIONS[mimeType]}`,
          mimeType,
        );
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw lastError!;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}
