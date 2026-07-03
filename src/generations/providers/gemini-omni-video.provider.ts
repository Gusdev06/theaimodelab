import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

// Códigos de fail retornados pela KIE que indicam moderação de conteúdo.
const OMNI_SAFETY_FAIL_CODES = new Set(['430']);

const RESOLUTION_MAP: Record<string, string> = {
  RES_720P: '720p',
  RES_1080P: '1080p',
  RES_4K: '4k',
};

export interface OmniVideoClip {
  url: string;
  start: number;
  ends: number;
}

export interface GeminiOmniVideoInput {
  id: string;
  prompt: string;
  imageUrls?: string[];
  videoList?: OmniVideoClip[];
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
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
export class GeminiOmniVideoProvider {
  private readonly logger = new Logger(GeminiOmniVideoProvider.name);
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

  async generateOmniVideo(
    input: GeminiOmniVideoInput,
  ): Promise<GenerationResult> {
    const resolution = RESOLUTION_MAP[input.resolution] ?? '720p';
    const hasVideo = (input.videoList?.length ?? 0) > 0;

    this.logger.log(
      `[GEMINI_OMNI] resolution=${resolution} duration=${input.durationSeconds}s images=${input.imageUrls?.length ?? 0} videos=${input.videoList?.length ?? 0} aspectRatio=${input.aspectRatio ?? '16:9'}`,
    );

    const omniInput: Record<string, unknown> = {
      prompt: input.prompt,
      aspect_ratio: input.aspectRatio ?? '16:9',
      resolution,
    };

    // Quando há vídeo de input, a duração é determinada pelo modelo — não envia.
    if (!hasVideo) {
      omniInput.duration = String(input.durationSeconds);
    }
    if (input.imageUrls?.length) {
      omniInput.image_urls = input.imageUrls;
    }
    if (input.videoList?.length) {
      omniInput.video_list = input.videoList;
    }

    const body = {
      model: 'gemini-omni-video',
      input: omniInput,
    };

    const taskId = await this.submitTask(body);
    this.logger.log(`[GEMINI_OMNI] Task submitted: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);
    this.logger.log(
      `[GEMINI_OMNI] Task ${taskId} completed — resultUrls=${resultUrls.length}`,
    );

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Gemini Omni Video returned no video results.');
    }

    return { outputUrls, modelUsed: 'gemini-omni-video' };
  }

  private async submitTask(body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/v1/jobs/createTask`;
    this.logger.log(`[GEMINI_OMNI] POST ${url}`);

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
        `[GEMINI_OMNI] createTask error (${response.status}): ${errorText}`,
      );
      throw new Error(
        `Gemini Omni createTask error (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as CreateTaskResponse;

    if (data.code !== 200 || !data.data?.taskId) {
      throw new Error(
        `Gemini Omni createTask failed: ${data.msg} (code ${data.code})`,
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
          `[GEMINI_OMNI POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `[GEMINI_OMNI POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Gemini Omni recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (!data.data) {
        this.logger.debug(
          `[GEMINI_OMNI POLL] No data in response (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      const { state } = data.data;

      if (state === 'waiting' || state === 'queuing' || state === 'generating') {
        this.logger.debug(
          `[GEMINI_OMNI POLL] state=${state} (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (state === 'fail') {
        const failMsg = data.data.failMsg ?? data.msg ?? 'unknown error';
        const failCode = data.data.failCode ?? '';
        const fullMessage = `${failMsg}${failCode ? ` (${failCode})` : ''}`;

        if (
          OMNI_SAFETY_FAIL_CODES.has(failCode) ||
          ContentSafetyError.fromErrorMessage(failMsg)
        ) {
          throw new ContentSafetyError(fullMessage, failCode || undefined);
        }

        throw new Error(`Gemini Omni generation failed: ${fullMessage}`);
      }

      if (state === 'success') {
        if (!data.data.resultJson) {
          throw new Error(
            'Gemini Omni succeeded but resultJson is empty.',
          );
        }

        let payload: ResultJsonPayload;
        try {
          payload = JSON.parse(data.data.resultJson) as ResultJsonPayload;
        } catch (err) {
          throw new Error(
            `Failed to parse Gemini Omni resultJson: ${(err as Error).message}`,
          );
        }

        const urls = payload.resultUrls ?? [];
        if (!urls.length) {
          throw new Error('Gemini Omni returned empty resultUrls.');
        }
        return urls;
      }
    }

    throw new Error('Gemini Omni generation timed out.');
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
            `[GEMINI_OMNI] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download video from Gemini Omni (${response.status}): ${sourceUrl}`,
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
