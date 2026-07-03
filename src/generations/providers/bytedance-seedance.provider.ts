import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

const SEEDANCE_SAFETY_FAIL_CODES = new Set(['430']);

const RESOLUTION_MAP: Record<string, string> = {
  RES_480P: '480p',
  RES_720P: '720p',
  RES_1080P: '1080p',
};

export interface SeedanceVideoInput {
  id: string;
  prompt: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
  generateAudio?: boolean;
}

interface CreateTaskResponse {
  code: number;
  msg: string;
  data: { taskId: string } | null;
}

interface RecordInfoResponse {
  code: number;
  msg: string;
  data: {
    taskId: string;
    model: string;
    state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';
    param?: string;
    resultJson?: string;
    failCode?: string;
    failMsg?: string;
    costTime?: number;
    completeTime?: number;
    createTime?: number;
    updateTime?: number;
  } | null;
}

interface ResultJsonPayload {
  resultUrls?: string[];
}

@Injectable()
export class BytedanceSeedanceProvider {
  private readonly logger = new Logger(BytedanceSeedanceProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'NANO_BANANA_BASE_URL',
      'https://api.kie.ai',
    );
    this.apiKey = this.configService.get<string>('NANO_BANANA_API_KEY', '');
  }

  async generateVideo(input: SeedanceVideoInput): Promise<GenerationResult> {
    const resolution = RESOLUTION_MAP[input.resolution] ?? '720p';
    const hasReferenceImages = (input.referenceImageUrls?.length ?? 0) > 0;
    const hasReferenceVideos = (input.referenceVideoUrls?.length ?? 0) > 0;
    const hasReferenceAudios = (input.referenceAudioUrls?.length ?? 0) > 0;

    this.logger.log(
      `[SEEDANCE] resolution=${resolution} duration=${input.durationSeconds}s aspectRatio=${input.aspectRatio ?? '16:9'} refImages=${input.referenceImageUrls?.length ?? 0} refVideos=${input.referenceVideoUrls?.length ?? 0} refAudios=${input.referenceAudioUrls?.length ?? 0} audio=${input.generateAudio ?? false}`,
    );

    const seedanceInput: Record<string, unknown> = {
      prompt: input.prompt,
      resolution,
      aspect_ratio: input.aspectRatio ?? '16:9',
      duration: input.durationSeconds,
      generate_audio: input.generateAudio ?? false,
      nsfw_checker: false,
    };

    if (hasReferenceImages) {
      seedanceInput.reference_image_urls = input.referenceImageUrls;
    }
    if (hasReferenceVideos) {
      // Note: KIE doc tem trailing space na chave 'reference_video_urls '.
      // Enviar a versão sem espaço (alguns endpoints aceitam ambas; ajustar se KIE rejeitar).
      seedanceInput.reference_video_urls = input.referenceVideoUrls;
    }
    if (hasReferenceAudios) {
      seedanceInput.reference_audio_urls = input.referenceAudioUrls;
    }

    const body = {
      model: 'bytedance/seedance-2',
      input: seedanceInput,
    };

    const taskId = await this.submitTask(body);
    this.logger.log(`[SEEDANCE] Task submitted: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);
    this.logger.log(
      `[SEEDANCE] Task ${taskId} completed — resultUrls=${resultUrls.length}`,
    );

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Seedance returned no video results.');
    }

    return { outputUrls, modelUsed: 'bytedance/seedance-2' };
  }

  private async submitTask(body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/v1/jobs/createTask`;
    this.logger.log(`[SEEDANCE] POST ${url}`);

    const response = await this.fetchWithTimeout(
      url,
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
        `[SEEDANCE] createTask error (${response.status}): ${errorText}`,
      );
      throw new Error(
        `Seedance createTask error (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as CreateTaskResponse;

    if (data.code !== 200 || !data.data?.taskId) {
      throw new Error(
        `Seedance createTask failed: ${data.msg} (code ${data.code})`,
      );
    }

    return data.data.taskId;
  }

  private async pollTaskStatus(
    taskId: string,
    maxAttempts = 240,
    intervalMs = 5_000,
  ): Promise<string[]> {
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      const url = `${this.baseUrl}/api/v1/jobs/recordInfo?taskId=${taskId}`;
      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          url,
          { headers: this.headers() },
          30_000,
        );
        networkFailures = 0;
      } catch (error) {
        networkFailures++;
        this.logger.warn(
          `[SEEDANCE POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw error;
        }
        continue;
      }

      if (!response.ok) {
        networkFailures++;
        const errorText = await response.text();
        this.logger.warn(
          `[SEEDANCE POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Seedance recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (!data.data) {
        this.logger.debug(
          `[SEEDANCE POLL] No data in response (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      const { state } = data.data;

      if (state === 'waiting' || state === 'queuing' || state === 'generating') {
        this.logger.debug(
          `[SEEDANCE POLL] state=${state} (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (state === 'fail') {
        const failMsg = data.data.failMsg ?? data.msg ?? 'unknown error';
        const failCode = data.data.failCode ?? '';
        const fullMessage = `${failMsg}${failCode ? ` (${failCode})` : ''}`;

        if (
          SEEDANCE_SAFETY_FAIL_CODES.has(failCode) ||
          ContentSafetyError.fromErrorMessage(failMsg)
        ) {
          throw new ContentSafetyError(fullMessage, failCode || undefined);
        }

        throw new Error(`Seedance generation failed: ${fullMessage}`);
      }

      if (state === 'success') {
        if (!data.data.resultJson) {
          throw new Error('Seedance succeeded but resultJson is empty.');
        }

        let payload: ResultJsonPayload;
        try {
          payload = JSON.parse(data.data.resultJson) as ResultJsonPayload;
        } catch (err) {
          throw new Error(
            `Failed to parse Seedance resultJson: ${(err as Error).message}`,
          );
        }

        const urls = payload.resultUrls ?? [];
        if (!urls.length) {
          throw new Error('Seedance returned empty resultUrls.');
        }
        return urls;
      }
    }

    throw new Error('Seedance generation timed out.');
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
          this.logger.warn(
            `[SEEDANCE] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download video from Seedance (${response.status}): ${sourceUrl}`,
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
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
