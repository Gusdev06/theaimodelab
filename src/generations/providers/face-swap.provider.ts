import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

const FACE_SWAP_PROMPT =
  "Recreate the scene in Image 2 (clothing, body pose, and setting) replacing the person with the woman in Image 1. The skin tone in Image 1 must be applied evenly across the entire body—face, neck, arms, hands, legs, and any visible skin areas—ensuring absolute consistency in coloring. Facial features, face shape, hair, and expression must be preserved with complete fidelity to Image 1. The integration between face and body must be perfect in lighting, shadows, skin texture, and anatomical proportions, resulting in a photorealistic image indistinguishable from an authentic photo.";

export interface FaceSwapInput {
  id: string;
  sourceImageUrl: string;
  targetImageUrl: string;
  resolution: string;
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
    resultJson: string | null;
    failCode: string | null;
    failMsg: string | null;
  };
}

@Injectable()
export class FaceSwapProvider {
  private readonly logger = new Logger(FaceSwapProvider.name);
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

  async generateFaceSwap(input: FaceSwapInput): Promise<GenerationResult> {
    const model = 'nano-banana-2';

    this.logger.log(
      `Creating Face Swap task — resolution ${input.resolution}`,
    );

    const body: Record<string, unknown> = {
      model,
      input: {
        prompt: FACE_SWAP_PROMPT,
        resolution: input.resolution,
        aspect_ratio: 'auto',
        output_format: 'png',
        google_search: false,
        image_input: [input.sourceImageUrl, input.targetImageUrl],
      },
    };

    this.logger.log(
      `[FACE_SWAP] Creating task: resolution=${input.resolution} sourceImage=${input.sourceImageUrl} targetImage=${input.targetImageUrl}`,
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
        `Face Swap createTask error (${createResponse.status}): ${errorText}`,
      );
    }

    const createData = (await createResponse.json()) as CreateTaskResponse;

    if (createData.code !== 200) {
      const safetyError = ContentSafetyError.fromErrorMessage(createData.msg);
      if (safetyError) {
        throw safetyError;
      }
      throw new Error(
        `Face Swap createTask failed: ${createData.msg} (code ${createData.code})`,
      );
    }

    const taskId = createData.data.taskId;
    this.logger.log(`Face Swap task created: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Face Swap returned no images.');
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
          `Face Swap poll fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `Face Swap poll HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Face Swap recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (data.data.state === 'waiting') {
        this.logger.debug(
          `Face Swap task still processing... (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (data.data.state === 'fail') {
        const failMsg = data.data.failMsg ?? data.data.failCode ?? 'unknown error';
        const safetyError = ContentSafetyError.fromErrorMessage(failMsg);
        if (safetyError) {
          throw safetyError;
        }
        throw new Error(`Face Swap generation failed: ${failMsg}`);
      }

      if (data.data.state === 'success') {
        if (!data.data.resultJson) {
          throw new Error('Face Swap succeeded but returned no resultJson.');
        }
        const result = JSON.parse(data.data.resultJson) as {
          resultUrls?: string[];
        };
        if (!result.resultUrls?.length) {
          throw new Error('Face Swap succeeded but returned no image URLs.');
        }
        return result.resultUrls;
      }
    }

    throw new Error('Face Swap generation timed out.');
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
            `Retrying downloadAndUpload (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download image from Face Swap (${response.status}): ${sourceUrl}`,
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
