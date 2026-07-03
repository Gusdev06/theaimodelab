import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

// Códigos de fail retornados pela KIE que indicam moderação de conteúdo.
const GROK_SAFETY_FAIL_CODES = new Set(['430']);

const RESOLUTION_MAP: Record<string, string> = {
  RES_480P: '480p',
  RES_720P: '720p',
};

export interface GrokImagineImageToVideoInput {
  id: string;
  prompt?: string;
  imageUrls: string[];
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
  mode?: 'fun' | 'normal' | 'spicy';
  nsfwChecker?: boolean;
}

export interface GrokImagineTextToVideoInput {
  id: string;
  prompt: string;
  resolution: string;
  durationSeconds: number;
  aspectRatio?: string;
  mode?: 'fun' | 'normal' | 'spicy';
  nsfwChecker?: boolean;
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
export class GrokImagineProvider {
  private readonly logger = new Logger(GrokImagineProvider.name);
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

  async generateImageToVideo(
    input: GrokImagineImageToVideoInput,
  ): Promise<GenerationResult> {
    const resolution = RESOLUTION_MAP[input.resolution] ?? '720p';

    this.logger.log(
      `[GROK_IMAGINE] Image-to-video — resolution=${resolution} duration=${input.durationSeconds}s images=${input.imageUrls.length} mode=${input.mode ?? 'normal'}`,
    );

    const body = {
      model: 'grok-imagine/image-to-video',
      input: {
        image_urls: input.imageUrls,
        prompt: input.prompt,
        mode: input.mode ?? 'normal',
        duration: String(input.durationSeconds),
        resolution,
        aspect_ratio: input.aspectRatio ?? '16:9',
        nsfw_checker: input.nsfwChecker ?? false,
      },
    };

    return this.runTask(body, input.id, 'grok-imagine/image-to-video');
  }

  async generateTextToVideo(
    input: GrokImagineTextToVideoInput,
  ): Promise<GenerationResult> {
    const resolution = RESOLUTION_MAP[input.resolution] ?? '480p';

    this.logger.log(
      `[GROK_IMAGINE] Text-to-video — resolution=${resolution} duration=${input.durationSeconds}s mode=${input.mode ?? 'normal'}`,
    );

    const body = {
      model: 'grok-imagine/text-to-video',
      input: {
        prompt: input.prompt,
        mode: input.mode ?? 'normal',
        duration: String(input.durationSeconds),
        resolution,
        aspect_ratio: input.aspectRatio ?? '2:3',
        nsfw_checker: input.nsfwChecker ?? false,
      },
    };

    return this.runTask(body, input.id, 'grok-imagine/text-to-video');
  }

  private async runTask(
    body: Record<string, unknown>,
    generationId: string,
    modelUsed: string,
  ): Promise<GenerationResult> {
    const taskId = await this.submitTask(body);
    this.logger.log(`[GROK_IMAGINE] Task submitted: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);
    this.logger.log(
      `[GROK_IMAGINE] Task ${taskId} completed — resultUrls=${resultUrls.length}`,
    );

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], generationId, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Grok Imagine returned no video results.');
    }

    return { outputUrls, modelUsed };
  }

  private async submitTask(body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/v1/jobs/createTask`;
    this.logger.log(`[GROK_IMAGINE] POST ${url}`);

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
        `[GROK_IMAGINE] createTask error (${response.status}): ${errorText}`,
      );
      throw new Error(
        `Grok Imagine createTask error (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as CreateTaskResponse;

    if (data.code !== 200 || !data.data?.taskId) {
      throw new Error(
        `Grok Imagine createTask failed: ${data.msg} (code ${data.code})`,
      );
    }

    return data.data.taskId;
  }

  private async pollTaskStatus(
    taskId: string,
    maxAttempts = 180,
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
          `[GROK_IMAGINE POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `[GROK_IMAGINE POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Grok Imagine recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (!data.data) {
        this.logger.debug(
          `[GROK_IMAGINE POLL] No data in response (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      const { state } = data.data;

      if (state === 'waiting' || state === 'queuing' || state === 'generating') {
        this.logger.debug(
          `[GROK_IMAGINE POLL] state=${state} (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (state === 'fail') {
        const failMsg =
          data.data.failMsg ?? data.msg ?? 'unknown error';
        const failCode = data.data.failCode ?? '';
        const fullMessage = `${failMsg}${failCode ? ` (${failCode})` : ''}`;

        // Erros de moderação de conteúdo: jogar ContentSafetyError pra
        // que o processor exiba mensagem amigável e estorne créditos.
        if (
          GROK_SAFETY_FAIL_CODES.has(failCode) ||
          ContentSafetyError.fromErrorMessage(failMsg)
        ) {
          throw new ContentSafetyError(fullMessage, failCode || undefined);
        }

        throw new Error(`Grok Imagine generation failed: ${fullMessage}`);
      }

      if (state === 'success') {
        if (!data.data.resultJson) {
          throw new Error(
            'Grok Imagine succeeded but resultJson is empty.',
          );
        }

        let payload: ResultJsonPayload;
        try {
          payload = JSON.parse(data.data.resultJson) as ResultJsonPayload;
        } catch (err) {
          throw new Error(
            `Failed to parse Grok Imagine resultJson: ${(err as Error).message}`,
          );
        }

        const urls = payload.resultUrls ?? [];
        if (!urls.length) {
          throw new Error('Grok Imagine returned empty resultUrls.');
        }
        return urls;
      }
    }

    throw new Error('Grok Imagine generation timed out.');
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
            `[GROK_IMAGINE] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download video from Grok Imagine (${response.status}): ${sourceUrl}`,
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
