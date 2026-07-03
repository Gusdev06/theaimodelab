import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

// Códigos de fail retornados pela KIE que indicam moderação de conteúdo.
const SEEDREAM_SAFETY_FAIL_CODES = new Set(['430']);

// Nosso RES_2K → "basic" no KIE / RES_3K → "high" no KIE.
// (KIE doc fala em 4K para "high", mas o modelo Lite sai até 3K.)
const QUALITY_MAP: Record<string, 'basic' | 'high'> = {
  RES_2K: 'basic',
  RES_3K: 'high',
};

export interface SeedreamLiteImageInput {
  id: string;
  prompt: string;
  resolution: string; // RES_2K | RES_3K
  aspectRatio?: string;
  imageUrls?: string[]; // se presente → image-to-image
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
export class SeedreamLiteProvider {
  private readonly logger = new Logger(SeedreamLiteProvider.name);
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

  async generateImage(
    input: SeedreamLiteImageInput,
  ): Promise<GenerationResult> {
    const quality = QUALITY_MAP[input.resolution] ?? 'basic';
    const hasImages = (input.imageUrls?.length ?? 0) > 0;
    const modelName = hasImages
      ? 'seedream/5-lite-image-to-image'
      : 'seedream/5-lite-text-to-image';

    this.logger.log(
      `[SEEDREAM_LITE] mode=${hasImages ? 'image-to-image' : 'text-to-image'} quality=${quality} aspectRatio=${input.aspectRatio ?? '1:1'} images=${input.imageUrls?.length ?? 0}`,
    );

    const body = {
      model: modelName,
      input: {
        prompt: input.prompt,
        aspect_ratio: input.aspectRatio ?? '1:1',
        quality,
        nsfw_checker: false,
        ...(hasImages ? { image_urls: input.imageUrls } : {}),
      },
    };

    const taskId = await this.submitTask(body);
    this.logger.log(`[SEEDREAM_LITE] Task submitted: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);
    this.logger.log(
      `[SEEDREAM_LITE] Task ${taskId} completed — resultUrls=${resultUrls.length}`,
    );

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Seedream Lite returned no image results.');
    }

    return { outputUrls, modelUsed: modelName };
  }

  private async submitTask(body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/v1/jobs/createTask`;
    this.logger.log(`[SEEDREAM_LITE] POST ${url}`);

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
        `[SEEDREAM_LITE] createTask error (${response.status}): ${errorText}`,
      );
      throw new Error(
        `Seedream Lite createTask error (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as CreateTaskResponse;

    if (data.code !== 200 || !data.data?.taskId) {
      throw new Error(
        `Seedream Lite createTask failed: ${data.msg} (code ${data.code})`,
      );
    }

    return data.data.taskId;
  }

  private async pollTaskStatus(
    taskId: string,
    maxAttempts = 120,
    intervalMs = 4_000,
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
          `[SEEDREAM_LITE POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `[SEEDREAM_LITE POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Seedream Lite recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (!data.data) {
        this.logger.debug(
          `[SEEDREAM_LITE POLL] No data in response (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      const { state } = data.data;

      if (state === 'waiting' || state === 'queuing' || state === 'generating') {
        this.logger.debug(
          `[SEEDREAM_LITE POLL] state=${state} (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (state === 'fail') {
        const failMsg = data.data.failMsg ?? data.msg ?? 'unknown error';
        const failCode = data.data.failCode ?? '';
        const fullMessage = `${failMsg}${failCode ? ` (${failCode})` : ''}`;

        if (
          SEEDREAM_SAFETY_FAIL_CODES.has(failCode) ||
          ContentSafetyError.fromErrorMessage(failMsg)
        ) {
          throw new ContentSafetyError(fullMessage, failCode || undefined);
        }

        throw new Error(`Seedream Lite generation failed: ${fullMessage}`);
      }

      if (state === 'success') {
        if (!data.data.resultJson) {
          throw new Error(
            'Seedream Lite succeeded but resultJson is empty.',
          );
        }

        let payload: ResultJsonPayload;
        try {
          payload = JSON.parse(data.data.resultJson) as ResultJsonPayload;
        } catch (err) {
          throw new Error(
            `Failed to parse Seedream Lite resultJson: ${(err as Error).message}`,
          );
        }

        const urls = payload.resultUrls ?? [];
        if (!urls.length) {
          throw new Error('Seedream Lite returned empty resultUrls.');
        }
        return urls;
      }
    }

    throw new Error('Seedream Lite generation timed out.');
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
            `[SEEDREAM_LITE] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download image from Seedream Lite (${response.status}): ${sourceUrl}`,
          );
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') ?? 'image/png';
        const ext = contentType.split('/')[1]?.split(';')[0] ?? 'png';

        return await this.uploadsService.uploadBuffer(
          buffer,
          `generations/${generationId}`,
          `output_${index}.${ext}`,
          contentType,
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
