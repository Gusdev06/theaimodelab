import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';

export interface WanAnimateReplaceInput {
  id: string;
  videoUrl: string;
  imageUrl: string;
  resolution: string;
  prompt?: string;
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
export class WanProvider {
  private readonly logger = new Logger(WanProvider.name);
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

  async generateAnimateReplace(
    input: WanAnimateReplaceInput,
  ): Promise<GenerationResult> {
    this.logger.log(
      `Creating Kling 2.6 Motion Control task — mode ${input.resolution}`,
    );

    const body: Record<string, unknown> = {
      model: 'kling-2.6/motion-control',
      input: {
        input_urls: [input.imageUrl],
        video_urls: [input.videoUrl],
        character_orientation: 'video',
        mode: input.resolution,
        ...(input.prompt ? { prompt: input.prompt } : {}),
      },
    };

    this.logger.log(
      `[MOTION_CONTROL] Creating task: mode=${input.resolution} imageUrl=${input.imageUrl} videoUrl=${input.videoUrl} prompt="${input.prompt ?? ''}"`,
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
      throw new Error(
        `Kling createTask error (${createResponse.status}): ${errorText}`,
      );
    }

    const createData = (await createResponse.json()) as CreateTaskResponse;
    if (createData.code !== 200) {
      throw new Error(
        `Kling createTask failed: ${createData.msg} (code ${createData.code})`,
      );
    }

    const taskId = createData.data.taskId;
    this.logger.log(`Kling task created: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Kling Motion Control returned no videos.');
    }

    this.logger.log(`${outputUrls.length} video(s) uploaded to S3`);
    return { outputUrls, modelUsed: 'kling-2.6/motion-control' };
  }

  private async pollTaskStatus(
    taskId: string,
    maxAttempts = 120,
    intervalMs = 5_000,
  ): Promise<string[]> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/v1/jobs/recordInfo?taskId=${taskId}`,
        { headers: this.headers() },
        30_000,
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Kling recordInfo error (${response.status}): ${errorText}`,
        );
      }

      const data = (await response.json()) as RecordInfoResponse;

      if (data.data.state === 'waiting') {
        this.logger.debug(
          `Kling task still processing... (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (data.data.state === 'fail') {
        throw new Error(
          `Kling generation failed: ${data.data.failMsg ?? data.data.failCode ?? 'unknown error'}`,
        );
      }

      if (data.data.state === 'success') {
        if (!data.data.resultJson) {
          throw new Error('Kling succeeded but returned no resultJson.');
        }
        const result = JSON.parse(data.data.resultJson) as {
          resultUrls?: string[];
        };
        if (!result.resultUrls?.length) {
          throw new Error('Kling succeeded but returned no video URLs.');
        }
        return result.resultUrls;
      }
    }

    throw new Error('Kling generation timed out.');
  }

  private async downloadAndUpload(
    sourceUrl: string,
    generationId: string,
    index: number,
  ): Promise<string> {
    const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
    if (!response.ok) {
      throw new Error(
        `Failed to download video from Kling (${response.status}): ${sourceUrl}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.uploadsService.uploadBuffer(
      buffer,
      `generations/${generationId}`,
      `output_${index}.mp4`,
      'video/mp4',
    );
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
