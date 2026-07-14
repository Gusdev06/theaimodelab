import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';

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

const POLL_MAX_ATTEMPTS = 180; // ~9 min a 3s
const POLL_INTERVAL_MS = 3_000;

export type WavespeedVideoResolution = '480p' | '720p' | '1080p';
export type SeedanceVideoResolution = '480p' | '720p' | '1080p' | '4k';
export type WavespeedVideoPreset = 'tuned' | 'original';
export type SeedanceAspectRatio = '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9';

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
    status: 'created' | 'processing' | 'completed' | 'failed';
    outputs?: string[];
    error?: string;
  };
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
      prompt: input.prompt,
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
      prompt: input.prompt,
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

  private async createPrediction(
    model: string,
    body: Record<string, unknown>,
  ): Promise<string> {
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
      throw new Error(
        'Não foi possível gerar o vídeo agora. Tente novamente em alguns instantes.',
      );
    }

    const data = (await response.json()) as CreatePredictionResponse;
    const predictionId = data.data?.id ?? data.id;
    if (!predictionId) {
      this.logger.error(
        `WaveSpeed ${model} createPrediction missing id: ${JSON.stringify(data).slice(0, 300)}`,
      );
      throw new Error(
        'O serviço de vídeo não respondeu como esperado. Tente novamente em alguns instantes.',
      );
    }
    return predictionId;
  }

  private async pollPrediction(predictionId: string): Promise<string> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/v3/predictions/${predictionId}/result`,
        { headers: this.headers() },
        30_000,
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `WaveSpeed LTX result failed status=${response.status} predictionId=${predictionId} body=${errorText.slice(0, 200)}`,
        );
        throw new Error(
          'Não foi possível gerar o vídeo agora. Tente novamente em alguns instantes.',
        );
      }

      const payload = (await response.json()) as PredictionResultResponse;
      const data = payload.data;
      if (!data) {
        throw new Error(
          'Resposta inesperada do serviço de vídeo. Tente gerar de novo.',
        );
      }

      if (data.status === 'completed') {
        const videoUrl = data.outputs?.[0];
        if (!videoUrl) {
          throw new Error(
            'A geração foi concluída mas o vídeo não pôde ser recuperado. Tente novamente.',
          );
        }
        return videoUrl;
      }

      if (data.status === 'failed') {
        this.logger.error(
          `WaveSpeed LTX prediction failed predictionId=${predictionId} error=${data.error ?? 'unknown'}`,
        );
        throw new Error(data.error ?? 'A geração de vídeo falhou. Tente novamente.');
      }

      this.logger.debug(
        `WaveSpeed LTX prediction ${predictionId} ${data.status} (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})`,
      );
    }

    throw new Error(
      'A geração de vídeo demorou mais que o esperado. Tente novamente em alguns instantes.',
    );
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
