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

const GEMINI_TO_NANO_BANANA: Record<string, string> = {
  'gemini-3-pro-image-preview': 'nano-banana-pro',
  'gemini-3.1-flash-image-preview': 'nano-banana-2',
};

export function mapGeminiToNanoBanana(geminiModel: string): string {
  return GEMINI_TO_NANO_BANANA[geminiModel] ?? 'nano-banana-2';
}

export interface NanoBananaImageInput {
  id: string;
  model?: string;
  prompt: string;
  resolution: string;
  aspectRatio?: string;
  outputFormat?: string;
  googleSearch?: boolean;
  imageUrls?: string[];
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
export class NanoBananaProvider {
  private readonly logger = new Logger(NanoBananaProvider.name);
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

  async generateImage(input: NanoBananaImageInput): Promise<GenerationResult> {
    const model = input.model ?? 'nano-banana-2';

    this.logger.log(
      `Creating ${model} task — resolution ${input.resolution}`,
    );

    const resolution = RESOLUTION_MAP[input.resolution] ?? '1K';

    const body: Record<string, unknown> = {
      model,
      input: {
        prompt: input.prompt,
        resolution,
        aspect_ratio: input.aspectRatio ?? 'auto',
        output_format: input.outputFormat ?? 'png',
        google_search: input.googleSearch ?? false,
        ...(input.imageUrls?.length && { image_input: input.imageUrls }),
      },
    };

    this.logger.log(
      `[NANO_BANANA] Creating task: model=${model} resolution=${resolution} aspectRatio=${input.aspectRatio ?? 'auto'} outputFormat=${input.outputFormat ?? 'png'} googleSearch=${input.googleSearch ?? false} imageUrls=${input.imageUrls?.length ?? 0} prompt="${input.prompt}"`,
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
      if (safetyError) {
        throw safetyError;
      }
      throw new Error(
        `Nano Banana createTask error (${createResponse.status}): ${errorText}`,
      );
    }

    const createData = (await createResponse.json()) as CreateTaskResponse;

    if (createData.code !== 200) {
      const safetyError = ContentSafetyError.fromErrorMessage(createData.msg);
      if (safetyError) {
        throw safetyError;
      }
      throw new Error(
        `Nano Banana createTask failed: ${createData.msg} (code ${createData.code})`,
      );
    }

    const taskId = createData.data.taskId;
    this.logger.log(`Nano Banana task created: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(
        resultUrls[i],
        input.id,
        i,
        input.outputFormat ?? 'png',
      );
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Nano Banana returned no images.');
    }

    this.logger.log(`${outputUrls.length} image(s) uploaded to S3`);
    return { outputUrls, modelUsed: model };
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
          `Nano Banana poll fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `Nano Banana poll HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Nano Banana recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (data.data.state === 'waiting') {
        this.logger.debug(
          `Nano Banana task still processing... (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (data.data.state === 'fail') {
        const failMsg = data.data.failMsg ?? data.data.failCode ?? 'unknown error';
        const safetyError = ContentSafetyError.fromErrorMessage(failMsg);
        if (safetyError) {
          throw safetyError;
        }
        throw new Error(`Nano Banana generation failed: ${failMsg}`);
      }

      if (data.data.state === 'success') {
        if (!data.data.resultJson) {
          throw new Error('Nano Banana succeeded but returned no resultJson.');
        }
        const result = JSON.parse(data.data.resultJson) as {
          resultUrls?: string[];
        };
        if (!result.resultUrls?.length) {
          throw new Error('Nano Banana succeeded but returned no image URLs.');
        }
        return result.resultUrls;
      }
    }

    throw new Error('Nano Banana generation timed out.');
  }

  private async downloadAndUpload(
    sourceUrl: string,
    generationId: string,
    index: number,
    format: string,
  ): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          this.logger.warn(
            `Retrying downloadAndUpload (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download image from Nano Banana (${response.status}): ${sourceUrl}`,
          );
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const ext = format === 'jpg' ? 'jpg' : 'png';
        const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';

        return await this.uploadsService.uploadBuffer(
          buffer,
          `generations/${generationId}`,
          `output_${index}.${ext}`,
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
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
