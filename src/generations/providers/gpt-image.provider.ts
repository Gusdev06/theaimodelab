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

const GPT_IMAGE_MODEL_T2I = 'gpt-image-2-text-to-image';
const GPT_IMAGE_MODEL_I2I = 'gpt-image-2-image-to-image';

export interface GptImageInput {
  id: string;
  prompt: string;
  resolution: string;
  aspectRatio?: string;
  imageUrls?: string[]; // se presente → usa endpoint image-to-image
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
    const model = isImageToImage ? GPT_IMAGE_MODEL_I2I : GPT_IMAGE_MODEL_T2I;

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
      `[GPT_IMAGE_2] Creating task: model=${model} resolution=${resolution} aspectRatio=${aspectRatio} inputUrls=${input.imageUrls?.length ?? 0} prompt="${input.prompt}"`,
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
        `GPT Image 2 createTask error (${createResponse.status}): ${errorText}`,
      );
    }

    const createData = (await createResponse.json()) as CreateTaskResponse;

    if (createData.code !== 200) {
      const safetyError = ContentSafetyError.fromErrorMessage(createData.msg);
      if (safetyError) throw safetyError;
      throw new Error(
        `GPT Image 2 createTask failed: ${createData.msg} (code ${createData.code})`,
      );
    }

    const taskId = createData.data.taskId;
    this.logger.log(`[GPT_IMAGE_2] Task created: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('GPT Image 2 returned no images.');
    }

    this.logger.log(`[GPT_IMAGE_2] ${outputUrls.length} image(s) uploaded to S3`);
    return { outputUrls, modelUsed: 'gpt-image-2' };
  }

  private async pollTaskStatus(
    taskId: string,
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
          `[GPT_IMAGE_2] Poll fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
        );
        if (networkFailures >= maxNetworkRetries) throw error;
        continue;
      }

      if (!response.ok) {
        networkFailures++;
        const errorText = await response.text();
        this.logger.warn(
          `[GPT_IMAGE_2] Poll HTTP ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `GPT Image 2 recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (data.data.state === 'waiting') {
        this.logger.debug(
          `[GPT_IMAGE_2] Still processing... (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (data.data.state === 'fail') {
        const failMsg =
          data.data.failMsg ?? data.data.failCode ?? 'unknown error';
        const safetyError = ContentSafetyError.fromErrorMessage(failMsg);
        if (safetyError) throw safetyError;
        throw new Error(`GPT Image 2 generation failed: ${failMsg}`);
      }

      if (data.data.state === 'success') {
        if (!data.data.resultJson) {
          throw new Error('GPT Image 2 succeeded but returned no resultJson.');
        }
        const result = JSON.parse(data.data.resultJson) as {
          resultUrls?: string[];
        };
        if (!result.resultUrls?.length) {
          throw new Error('GPT Image 2 succeeded but returned no image URLs.');
        }
        return result.resultUrls;
      }
    }

    throw new Error('GPT Image 2 generation timed out.');
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
            `[GPT_IMAGE_2] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download image from GPT Image 2 (${response.status}): ${sourceUrl}`,
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
