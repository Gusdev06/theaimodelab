import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

const RESOLUTION_MAP: Record<string, string> = {
  RES_1K: '1K',
  RES_2K: '2K',
  RES_4K: '4K',
};

/**
 * Família do GPT Image na KIE. Mesma API (createTask/recordInfo), só muda o
 * model id — 'gpt-image-2' (padrão, retrocompatível) ou 'gpt-image-2-5' (Flare).
 */
export type GptImageFamily = 'gpt-image-2' | 'gpt-image-2-5';

const GPT_IMAGE_MODELS: Record<
  GptImageFamily,
  { t2i: string; i2i: string; label: string; logTag: string }
> = {
  'gpt-image-2': {
    t2i: 'gpt-image-2-text-to-image',
    i2i: 'gpt-image-2-image-to-image',
    label: 'GPT Image 2',
    logTag: 'GPT_IMAGE_2',
  },
  'gpt-image-2-5': {
    t2i: 'gpt-image-2-5-flare-text-to-image',
    i2i: 'gpt-image-2-5-flare-image-to-image',
    label: 'GPT Image 2.5',
    logTag: 'GPT_IMAGE_2_5',
  },
};

export interface GptImageInput {
  id: string;
  prompt: string;
  resolution: string;
  aspectRatio?: string;
  imageUrls?: string[]; // se presente → usa endpoint image-to-image
  family?: GptImageFamily; // default 'gpt-image-2'
}

interface CreateTaskResponse {
  code: number;
  msg: string;
  data: { taskId: string };
}

interface RecordInfoResponse {
  code: number;
  msg: string;
  data: {
    taskId: string;
    model: string;
    state: 'waiting' | 'success' | 'fail';
    param: string;
    resultJson: string | null;
    failCode: string | null;
    failMsg: string | null;
    costTime: number | null;
    completeTime: number | null;
    createTime: number;
  };
}

@Injectable()
export class GptImageProvider {
  private readonly logger = new Logger(GptImageProvider.name);
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

  async generateImage(input: GptImageInput): Promise<GenerationResult> {
    const resolution = RESOLUTION_MAP[input.resolution] ?? '1K';
    const aspectRatio = input.aspectRatio ?? 'auto';
    const isImageToImage = !!input.imageUrls?.length;
    const family: GptImageFamily = input.family ?? 'gpt-image-2';
    const spec = GPT_IMAGE_MODELS[family];
    const model = isImageToImage ? spec.i2i : spec.t2i;

    const body: Record<string, unknown> = {
      model,
      input: {
        prompt: input.prompt,
        aspect_ratio: aspectRatio,
        resolution,
        ...(isImageToImage && { input_urls: input.imageUrls }),
      },
    };

    this.logger.log(
      `[${spec.logTag}] Creating task: model=${model} resolution=${resolution} aspectRatio=${aspectRatio} inputUrls=${input.imageUrls?.length ?? 0} prompt="${input.prompt}"`,
    );

    const createResponse = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/jobs/createTask`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      },
      60_000,
    );

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      const safetyError = ContentSafetyError.fromErrorMessage(errorText);
      if (safetyError) throw safetyError;
      throw new Error(
        `${spec.label} createTask error (${createResponse.status}): ${errorText}`,
      );
    }

    const createData = (await createResponse.json()) as CreateTaskResponse;

    if (createData.code !== 200) {
      const safetyError = ContentSafetyError.fromErrorMessage(createData.msg);
      if (safetyError) throw safetyError;
      throw new Error(
        `${spec.label} createTask failed: ${createData.msg} (code ${createData.code})`,
      );
    }

    const taskId = createData.data.taskId;
    this.logger.log(`[${spec.logTag}] Task created: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId, spec);

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(
        resultUrls[i],
        input.id,
        i,
        spec,
      );
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error(`${spec.label} returned no images.`);
    }

    this.logger.log(
      `[${spec.logTag}] ${outputUrls.length} image(s) uploaded to S3`,
    );
    return { outputUrls, modelUsed: family };
  }

  private async pollTaskStatus(
    taskId: string,
    spec: (typeof GPT_IMAGE_MODELS)[GptImageFamily],
    maxAttempts = 120,
    intervalMs = 5_000,
  ): Promise<string[]> {
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          `${this.baseUrl}/api/v1/jobs/recordInfo?taskId=${taskId}`,
          { headers: this.headers() },
          30_000,
        );
      } catch (error) {
        networkFailures++;
        this.logger.warn(
          `[${spec.logTag}] Poll fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
        );
        if (networkFailures >= maxNetworkRetries) throw error;
        continue;
      }

      if (!response.ok) {
        networkFailures++;
        const errorText = await response.text();
        this.logger.warn(
          `[${spec.logTag}] Poll HTTP ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `${spec.label} recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (data.data.state === 'waiting') {
        this.logger.debug(
          `[${spec.logTag}] Still processing... (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (data.data.state === 'fail') {
        const failMsg =
          data.data.failMsg ?? data.data.failCode ?? 'unknown error';
        const safetyError = ContentSafetyError.fromErrorMessage(failMsg);
        if (safetyError) throw safetyError;
        throw new Error(`${spec.label} generation failed: ${failMsg}`);
      }

      if (data.data.state === 'success') {
        if (!data.data.resultJson) {
          throw new Error(
            `${spec.label} succeeded but returned no resultJson.`,
          );
        }
        const result = JSON.parse(data.data.resultJson) as {
          resultUrls?: string[];
        };
        if (!result.resultUrls?.length) {
          throw new Error(
            `${spec.label} succeeded but returned no image URLs.`,
          );
        }
        return result.resultUrls;
      }
    }

    throw new Error(`${spec.label} generation timed out.`);
  }

  private async downloadAndUpload(
    sourceUrl: string,
    generationId: string,
    index: number,
    spec: (typeof GPT_IMAGE_MODELS)[GptImageFamily],
  ): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          this.logger.warn(
            `[${spec.logTag}] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download image from ${spec.label} (${response.status}): ${sourceUrl}`,
          );
        }
        const buffer = Buffer.from(await response.arrayBuffer());

        return await this.uploadsService.uploadBuffer(
          buffer,
          `generations/${generationId}`,
          `output_${index}.png`,
          'image/png',
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
