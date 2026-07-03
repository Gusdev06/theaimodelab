import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { ModelsService } from '../../models/models.service';
import { ContentSafetyError } from '../errors/content-safety.error';

/** Maps internal resolution enum to image size values */
const IMAGE_SIZE_MAP: Record<string, string> = {
  RES_1K: '1K',
  RES_2K: '2K',
  RES_4K: '4K',
};

/** Maps internal resolution enum to video resolution values */
const VIDEO_RESOLUTION_MAP: Record<string, string> = {
  RES_720P: '720p',
  RES_1080P: '1080p',
  RES_4K: '4K',
};

// ─── Input interfaces ───────────────────────────────────────

export interface TextToVideoInput {
  id: string;
  prompt: string;
  model: string;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution: string; // Prisma Resolution enum value (e.g. RES_1080P)
  generateAudio: boolean;
  sampleCount?: number;
  negativePrompt?: string;
}

export interface ImageToVideoInput extends TextToVideoInput {
  firstFrame: string; // base64
  firstFrameMimeType: string;
  lastFrame?: string; // base64
  lastFrameMimeType?: string;
}

export interface ReferenceVideoInput extends TextToVideoInput {
  referenceImages: Array<{
    base64: string;
    mimeType: string;
    referenceType: 'asset' | 'style';
  }>;
}

export interface ImageGenerationInput {
  id: string;
  prompt: string;
  model: string;
  resolution: string; // Prisma Resolution enum value (e.g. RES_1K)
  aspectRatio?: string;
  mimeType?: string;
  images?: Array<{
    base64: string;
    mimeType: string;
  }>;
}

export interface GenerationResult {
  outputUrls: string[];
  modelUsed: string;
}

// ─── Response types ─────────────────────────────────────────

interface GeminiImageResponse {
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; base64: string; mimeType: string }
  >;
}

interface VideoStatusResponse {
  done: boolean;
  operationName: string;
  videos?: Array<{ base64?: string; gcsUri?: string; mimeType: string }>;
  error?: unknown;
}

// ─── Provider ───────────────────────────────────────────────

@Injectable()
export class TheaimodelabProvider {
  private readonly logger = new Logger(TheaimodelabProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
    private readonly modelsService: ModelsService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'THEAIMODELAB_PROVIDER_URL',
      'http://localhost:3001',
    );
    this.apiKey = this.configService.get<string>('THEAIMODELAB_API_KEY', '');
  }

  // ─── Route 4: POST /api/image/generate-gemini ─────────────

  async generateImage(input: ImageGenerationInput): Promise<GenerationResult> {
    this.logger.log(`Generating image — resolution ${input.resolution}`);

    const imageSize = IMAGE_SIZE_MAP[input.resolution] ?? '1K';

    const body: Record<string, unknown> = {
      prompt: input.prompt,
      model: input.model,
      aspect_ratio: input.aspectRatio ?? '1:1',
      image_size: imageSize,
      mime_type: input.mimeType ?? 'image/png',
    };

    if (input.images?.length) {
      body.images = input.images.map((img) => ({
        base64: img.base64,
        mime_type: img.mimeType,
      }));
    }

    const url = `${this.baseUrl}/api/image/generate-gemini`;
    this.logger.log(`[IMAGE] POST ${url}`);
    this.logger.log(`[IMAGE] Body: ${JSON.stringify({ ...body, images: body.images ? `[${(body.images as unknown[]).length} image(s)]` : undefined })}`);

    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      }, 600_000); // 10 min
    } catch (error) {
      this.logger.error(`[IMAGE] Fetch failed to ${url}: ${error.message}`, error.cause ? JSON.stringify(error.cause) : undefined);
      throw error;
    }

    this.logger.log(`[IMAGE] Response status: ${response.status}`);
    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error(`[IMAGE] Error response: ${errorText}`);
      const safetyError = ContentSafetyError.fromErrorMessage(errorText);
      if (safetyError) {
        throw safetyError;
      }
      throw new Error(`Image API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as GeminiImageResponse;

    const textParts = data.parts?.filter((p) => p.type === 'text') ?? [];
    const textJoined = textParts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join(' ');

    const imageParts = data.parts?.filter((p) => p.type === 'image') ?? [];
    if (!imageParts.length) {
      const safetyError = textJoined
        ? ContentSafetyError.fromErrorMessage(textJoined)
        : null;
      if (safetyError) {
        throw safetyError;
      }
      throw new Error('No image returned in response. Try a different prompt.');
    }

    const outputUrls: string[] = [];
    for (let i = 0; i < imageParts.length; i++) {
      const imagePart = imageParts[i];
      if (imagePart.type !== 'image') continue;
      const buffer = Buffer.from(imagePart.base64, 'base64');
      const ext = imagePart.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      const outputUrl = await this.uploadsService.uploadBuffer(
        buffer,
        `generations/${input.id}`,
        `output_${i}.${ext}`,
        imagePart.mimeType,
      );
      outputUrls.push(outputUrl);
    }

    this.logger.log(`${outputUrls.length} image(s) uploaded to S3`);

    return { outputUrls, modelUsed: input.model };
  }

  // ─── Route 1: POST /api/video/generate-text-to-video ──────

  async generateTextToVideo(
    input: TextToVideoInput,
  ): Promise<GenerationResult> {
    this.logger.log(
      `Generating text-to-video — resolution ${input.resolution}`,
    );

    const body = this.buildVideoBody(input);

    return this.startAndPollVideo(
      '/api/video/generate-text-to-video',
      body,
      input.id,
      input.model,
    );
  }

  // ─── Route 2: POST /api/video/generate-image-to-video ─────

  async generateImageToVideo(
    input: ImageToVideoInput,
  ): Promise<GenerationResult> {
    this.logger.log(
      `Generating image-to-video — resolution ${input.resolution}`,
    );

    const body: Record<string, unknown> = {
      ...this.buildVideoBody(input),
      first_frame: input.firstFrame,
      first_frame_mime_type: input.firstFrameMimeType,
    };

    if (input.lastFrame) {
      body.last_frame = input.lastFrame;
      body.last_frame_mime_type = input.lastFrameMimeType;
    }

    return this.startAndPollVideo(
      '/api/video/generate-image-to-video',
      body,
      input.id,
      input.model,
    );
  }

  // ─── Route 3: POST /api/video/generate-references ─────────

  async generateVideoWithReferences(
    input: ReferenceVideoInput,
  ): Promise<GenerationResult> {
    this.logger.log(
      `Generating video with references — resolution ${input.resolution}`,
    );

    const body: Record<string, unknown> = {
      ...this.buildVideoBody(input),
      reference_images: input.referenceImages.map((ref) => ({
        base64: ref.base64,
        mime_type: ref.mimeType,
        reference_type: ref.referenceType,
      })),
    };

    return this.startAndPollVideo(
      '/api/video/generate-references',
      body,
      input.id,
      input.model,
    );
  }

  // ─── Shared helpers ───────────────────────────────────────

  /** Maps frontend model IDs to actual theaimodelab-provider API model names */
  private resolveModel(model: string): string {
    const MAP: Record<string, string> = {
      'theaimodelab-fast': 'veo-3.1-fast-generate-001',
      'theaimodelab-quality': 'veo-3.1-generate-001',
    };
    return MAP[model] ?? model;
  }

  private buildVideoBody(input: TextToVideoInput): Record<string, unknown> {
    const resolution = VIDEO_RESOLUTION_MAP[input.resolution] ?? '1080p';

    return {
      prompt: input.prompt,
      model: this.resolveModel(input.model),
      duration_seconds: input.durationSeconds,
      aspect_ratio: input.aspectRatio,
      resolution,
      generate_audio: input.generateAudio,
      sample_count: input.sampleCount,
      negative_prompt: input.negativePrompt,
    };
  }

  private async startAndPollVideo(
    route: string,
    body: Record<string, unknown>,
    generationId: string,
    model: string,
  ): Promise<GenerationResult> {
    const url = `${this.baseUrl}${route}`;
    this.logger.log(`[VIDEO] POST ${url}`);
    this.logger.log(`[VIDEO] Body: ${JSON.stringify(this.sanitizeBodyForLog(body))}`);

    let startResponse: Response;
    try {
      startResponse = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      }, 60_000);
    } catch (error) {
      this.logger.error(`[VIDEO] Fetch failed to ${url}: ${error.message}`, error.cause ? JSON.stringify(error.cause) : undefined);
      throw error;
    }

    this.logger.log(`[VIDEO] Response status: ${startResponse.status}`);
    if (!startResponse.ok) {
      const errorText = await startResponse.text();
      this.logger.error(`[VIDEO] Error response: ${errorText}`);
      await this.handleInfraFailure(startResponse.status, errorText);
      const safetyError = ContentSafetyError.fromErrorMessage(errorText);
      if (safetyError) {
        throw safetyError;
      }
      throw new Error(
        `Video API error (${startResponse.status}): ${errorText}`,
      );
    }

    const { operationName } = (await startResponse.json()) as {
      operationName: string;
    };
    this.logger.log(`[VIDEO] Generation started: ${operationName}`);

    const videos = await this.pollVideoStatus(operationName);

    const outputUrls: string[] = [];
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      let videoBuffer: Buffer;
      if (video.base64) {
        videoBuffer = Buffer.from(video.base64, 'base64');
      } else if (video.gcsUri) {
        videoBuffer = await this.downloadFromGcs(video.gcsUri);
      } else {
        continue;
      }
      const mimeType = video.mimeType ?? 'video/mp4';
      const outputUrl = await this.uploadsService.uploadBuffer(
        videoBuffer,
        `generations/${generationId}`,
        `output_${i}.mp4`,
        mimeType,
      );
      outputUrls.push(outputUrl);
    }

    if (!outputUrls.length) {
      throw new Error('No video data returned in response.');
    }

    this.logger.log(`${outputUrls.length} video(s) uploaded to S3`);

    return { outputUrls, modelUsed: model };
  }

  private async pollVideoStatus(
    operationName: string,
    maxAttempts = 60,
    intervalMs = 10_000,
  ): Promise<Array<{ base64?: string; gcsUri?: string; mimeType: string }>> {
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      const statusUrl = `${this.baseUrl}/api/video/status`;
      let response: Response;
      try {
        response = await this.fetchWithTimeout(statusUrl, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ operationName }),
        }, 30_000);
        networkFailures = 0; // reset on success
      } catch (error) {
        networkFailures++;
        this.logger.warn(
          `[VIDEO POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}) to ${statusUrl}: ${error.message}`,
          error.cause ? JSON.stringify(error.cause) : undefined,
        );
        if (networkFailures >= maxNetworkRetries) {
          this.logger.error(`[VIDEO POLL] Max network retries exceeded`);
          throw error;
        }
        continue; // retry on next attempt
      }

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`[VIDEO POLL] Error response (${response.status}): ${errorText}`);
        const safetyError = ContentSafetyError.fromErrorMessage(errorText);
        if (safetyError) {
          throw safetyError;
        }
        throw new Error(
          `Video status check error (${response.status}): ${errorText}`,
        );
      }

      const data = (await response.json()) as VideoStatusResponse;

      if (!data.done) {
        this.logger.debug(
          `Video still processing... (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (data.error) {
        const errorStr = JSON.stringify(data.error);
        const safetyError = ContentSafetyError.fromErrorMessage(errorStr);
        if (safetyError) {
          throw safetyError;
        }
        throw new Error(`Video generation failed: ${errorStr}`);
      }

      if (data.videos?.length) {
        return data.videos;
      }

      throw new Error(
        'Video generation completed but no video data returned.',
      );
    }

    throw new Error('Video generation timed out.');
  }

  private async downloadFromGcs(gcsUri: string): Promise<Buffer> {
    const httpsUrl = gcsUri.replace(
      'gs://',
      'https://storage.googleapis.com/',
    );
    const response = await this.fetchWithTimeout(httpsUrl, {}, 120_000);
    if (!response.ok) {
      throw new Error(
        `Failed to download video from GCS (${response.status}): ${httpsUrl}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private async handleInfraFailure(
    status: number,
    errorText: string,
  ): Promise<void> {
    if (status !== 503) return;
    if (!errorText.includes('No GCP accounts configured')) return;

    try {
      await this.modelsService.deactivateTheaimodelabVideoModels(
        'Modelos de vídeo temporariamente indisponíveis. Tente novamente em instantes.',
      );
    } catch (err) {
      this.logger.error(
        `Failed to auto-disable The AI Model Lab video models: ${(err as Error).message}`,
      );
    }
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

  private sanitizeBodyForLog(body: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'first_frame' || key === 'last_frame') {
        sanitized[key] = `[base64 ${typeof value === 'string' ? `${Math.round(value.length / 1024)}KB` : 'omitted'}]`;
      } else if (key === 'reference_images' && Array.isArray(value)) {
        sanitized[key] = value.map((ref: Record<string, unknown>) => ({
          ...ref,
          base64: `[base64 ${typeof ref.base64 === 'string' ? `${Math.round((ref.base64 as string).length / 1024)}KB` : 'omitted'}]`,
        }));
      } else if (key === 'images' && Array.isArray(value)) {
        sanitized[key] = `[${value.length} image(s)]`;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };
  }
}
