import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';

// ─── Model mapping ─────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  'veo-3.1-fast-generate-001': 'veo3_fast',
  'veo-3.1-generate-001': 'veo3',
};

const RESOLUTION_MAP: Record<string, string> = {
  RES_720P: '720p',
  RES_1080P: '1080p',
  RES_4K: '4k',
};

// ─── Input interfaces ──────────────────────────────────────

export interface VeoTextToVideoInput {
  id: string;
  prompt: string;
  model: string;
  aspectRatio?: string;
  resolution: string; // Prisma Resolution enum (e.g. RES_1080P)
  generateAudio: boolean;
  seed?: number;
}

export interface VeoImageToVideoInput extends VeoTextToVideoInput {
  imageUrls: string[]; // 1-2 public URLs (first frame, optional last frame)
}

export interface VeoReferenceToVideoInput extends VeoTextToVideoInput {
  imageUrls: string[]; // 1-3 reference images (veo3_fast only)
}

// ─── Response types ────────────────────────────────────────

interface VeoGenerateResponse {
  code: number;
  msg: string;
  data: { taskId: string } | null;
}

interface VeoRecordInfoResponse {
  code: number;
  msg: string;
  data: {
    taskId: string;
    successFlag: number; // 0 = processing, 1 = success, 2 = failed, 3 = failed
    response?: {
      taskId?: string;
      resultUrls?: string[];
      originUrls?: string[];
      fullResultUrls?: string[];
      resolution?: string;
    } | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  } | null;
}

interface VeoGet1080pResponse {
  code: number;
  msg: string;
  data: {
    resultUrl: string;
  } | null;
}

interface VeoGet4kResponse {
  code: number;
  msg: string;
  data: {
    taskId: string;
    resultUrls?: string[];
    imageUrls?: string[];
  } | null;
}

// ─── Provider ──────────────────────────────────────────────

@Injectable()
export class VeoProvider {
  private readonly logger = new Logger(VeoProvider.name);
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

  // ─── Text to Video ─────────────────────────────────────────

  async generateTextToVideo(
    input: VeoTextToVideoInput,
  ): Promise<GenerationResult> {
    const kieModel = MODEL_MAP[input.model] ?? 'veo3_fast';
    const resolution = RESOLUTION_MAP[input.resolution] ?? '1080p';

    this.logger.log(
      `[VEO] Text-to-video — model=${kieModel} resolution=${resolution} aspectRatio=${input.aspectRatio} audio=${input.generateAudio}`,
    );

    const body: Record<string, unknown> = {
      prompt: input.prompt,
      model: kieModel,
      aspect_ratio: input.aspectRatio ?? '16:9',
      generationType: 'TEXT_2_VIDEO',
      enableTranslation: false,
    };

    if (input.seed) {
      body.seeds = input.seed;
    }

    return this.submitAndWait(body, input.id, input.model, resolution);
  }

  // ─── Image to Video (first/last frames) ─────────────────────

  async generateImageToVideo(
    input: VeoImageToVideoInput,
  ): Promise<GenerationResult> {
    const kieModel = MODEL_MAP[input.model] ?? 'veo3_fast';
    const resolution = RESOLUTION_MAP[input.resolution] ?? '1080p';

    this.logger.log(
      `[VEO] Image-to-video — model=${kieModel} resolution=${resolution} images=${input.imageUrls.length}`,
    );

    const body: Record<string, unknown> = {
      prompt: input.prompt,
      model: kieModel,
      aspect_ratio: input.aspectRatio ?? '16:9',
      imageUrls: input.imageUrls,
      generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO',
      enableTranslation: false,
    };

    if (input.seed) {
      body.seeds = input.seed;
    }

    return this.submitAndWait(body, input.id, input.model, resolution);
  }

  // ���── Reference to Video (material-based, veo3_fast only) ───

  async generateReferenceToVideo(
    input: VeoReferenceToVideoInput,
  ): Promise<GenerationResult> {
    const kieModel = MODEL_MAP[input.model] ?? 'veo3_fast';
    const resolution = RESOLUTION_MAP[input.resolution] ?? '1080p';

    this.logger.log(
      `[VEO] Reference-to-video — model=${kieModel} resolution=${resolution} images=${input.imageUrls.length}`,
    );

    const body: Record<string, unknown> = {
      prompt: input.prompt,
      model: kieModel,
      aspect_ratio: input.aspectRatio ?? '16:9',
      imageUrls: input.imageUrls,
      generationType: 'REFERENCE_2_VIDEO',
      enableTranslation: false,
    };

    if (input.seed) {
      body.seeds = input.seed;
    }

    return this.submitAndWait(body, input.id, input.model, resolution);
  }

  // ─── Core flow: submit → poll → fetch result ──────────────

  private async submitAndWait(
    body: Record<string, unknown>,
    generationId: string,
    modelUsed: string,
    resolution: string,
  ): Promise<GenerationResult> {
    // 1. Submit generation
    const taskId = await this.submitGeneration(body);
    this.logger.log(`[VEO] Task submitted: ${taskId}`);

    // 2. Poll until complete
    const pollResult = await this.pollTaskStatus(taskId);
    this.logger.log(
      `[VEO] Task ${taskId} completed — resultUrls=${pollResult.length}`,
    );

    // 3. Fetch higher resolution if needed
    let finalUrls = pollResult;

    if (resolution === '1080p') {
      const url1080p = await this.fetch1080pVideo(taskId);
      if (url1080p) {
        finalUrls = [url1080p];
      }
    } else if (resolution === '4k') {
      const urls4k = await this.fetch4kVideo(taskId);
      if (urls4k.length) {
        finalUrls = urls4k;
      }
    }

    // 4. Download and upload to S3
    const outputUrls: string[] = [];
    for (let i = 0; i < finalUrls.length; i++) {
      const url = await this.downloadAndUpload(
        finalUrls[i],
        generationId,
        i,
      );
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Veo returned no video results.');
    }

    this.logger.log(`[VEO] ${outputUrls.length} video(s) uploaded to S3`);
    return { outputUrls, modelUsed };
  }

  // ─── Step 1: Submit generation ────────────────────────────

  private async submitGeneration(
    body: Record<string, unknown>,
  ): Promise<string> {
    const url = `${this.baseUrl}/api/v1/veo/generate`;
    this.logger.log(`[VEO] POST ${url}`);
    this.logger.log(
      `[VEO] Body: ${JSON.stringify({ ...body, imageUrls: body.imageUrls ? `[${(body.imageUrls as string[]).length} URL(s)]` : undefined })}`,
    );

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
      this.logger.error(`[VEO] Generate error (${response.status}): ${errorText}`);
      throw new Error(`Veo generate error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as VeoGenerateResponse;

    if (data.code !== 200 || !data.data?.taskId) {
      throw new Error(
        `Veo generate failed: ${data.msg} (code ${data.code})`,
      );
    }

    return data.data.taskId;
  }

  // ─── Step 2: Poll for completion ──────────────────────────

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

      const url = `${this.baseUrl}/api/v1/veo/record-info?taskId=${taskId}`;
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, { headers: this.headers() }, 30_000);
        networkFailures = 0;
      } catch (error) {
        networkFailures++;
        this.logger.warn(
          `[VEO POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `[VEO POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Veo record-info error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as VeoRecordInfoResponse;

      if (!data.data) {
        this.logger.debug(
          `[VEO POLL] No data in response (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      const { successFlag } = data.data;

      // 0 = still processing
      if (successFlag === 0) {
        this.logger.debug(
          `[VEO POLL] Still processing... (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      // 2 or 3 = failed
      if (successFlag === 2 || successFlag === 3) {
        const failMsg =
          data.data.errorMessage ?? data.msg ?? 'unknown error';
        throw new Error(`Veo generation failed: ${failMsg}`);
      }

      // 1 = success
      if (successFlag === 1) {
        const resp = data.data.response;
        const urls =
          resp?.resultUrls ?? resp?.originUrls ?? resp?.fullResultUrls;

        if (urls?.length) {
          return urls;
        }

        // If no URLs in record-info, we'll get them from the resolution endpoints
        this.logger.log(
          `[VEO] Task ${taskId} succeeded but no URLs in record-info — will fetch from resolution endpoint`,
        );
        return [];
      }
    }

    throw new Error('Veo generation timed out.');
  }

  // ─── Step 3a: Fetch 1080p video ───────────────────────────

  private async fetch1080pVideo(taskId: string): Promise<string | null> {
    this.logger.log(`[VEO] Fetching 1080p video for task ${taskId}`);

    const maxAttempts = 12; // ~4 minutes at 20s intervals
    const intervalMs = 20_000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      const url = `${this.baseUrl}/api/v1/veo/get-1080p-video?taskId=${taskId}`;

      try {
        const response = await this.fetchWithTimeout(
          url,
          { headers: this.headers() },
          30_000,
        );

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.warn(
            `[VEO 1080p] HTTP ${response.status} (attempt ${attempt + 1}/${maxAttempts}): ${errorText}`,
          );
          continue;
        }

        const data = (await response.json()) as VeoGet1080pResponse;

        if (data.code === 200 && data.data?.resultUrl) {
          this.logger.log(`[VEO 1080p] Got URL for task ${taskId}`);
          return data.data.resultUrl;
        }

        this.logger.debug(
          `[VEO 1080p] Not ready yet (attempt ${attempt + 1}/${maxAttempts})`,
        );
      } catch (error) {
        this.logger.warn(
          `[VEO 1080p] Fetch error (attempt ${attempt + 1}/${maxAttempts}): ${(error as Error).message}`,
        );
      }
    }

    this.logger.warn(
      `[VEO 1080p] Could not get 1080p video for task ${taskId} after ${maxAttempts} attempts — using default resolution`,
    );
    return null;
  }

  // ─── Step 3b: Fetch 4K video ──────────────────────────────

  private async fetch4kVideo(taskId: string): Promise<string[]> {
    this.logger.log(`[VEO] Requesting 4K video for task ${taskId}`);

    const url = `${this.baseUrl}/api/v1/veo/get-4k-video`;

    try {
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ taskId, index: 0 }),
        },
        30_000,
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(`[VEO 4K] Submit error (${response.status}): ${errorText}`);
        return [];
      }

      const data = (await response.json()) as VeoGet4kResponse;

      if (data.code === 200 && data.data?.resultUrls?.length) {
        this.logger.log(`[VEO 4K] Got URLs for task ${taskId}`);
        return data.data.resultUrls;
      }

      // 4K may need polling — retry
      this.logger.log(`[VEO 4K] Processing... will poll for result`);
    } catch (error) {
      this.logger.warn(`[VEO 4K] Submit error: ${(error as Error).message}`);
      return [];
    }

    // Poll for 4K result
    return this.poll4kVideo(taskId);
  }

  private async poll4kVideo(
    taskId: string,
    maxAttempts = 30, // ~10 minutes at 20s intervals
    intervalMs = 20_000,
  ): Promise<string[]> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      const url = `${this.baseUrl}/api/v1/veo/get-4k-video`;

      try {
        const response = await this.fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ taskId, index: 0 }),
          },
          30_000,
        );

        if (!response.ok) continue;

        const data = (await response.json()) as VeoGet4kResponse;

        if (data.code === 200 && data.data?.resultUrls?.length) {
          this.logger.log(`[VEO 4K] Got URLs for task ${taskId}`);
          return data.data.resultUrls;
        }

        this.logger.debug(
          `[VEO 4K] Not ready yet (attempt ${attempt + 1}/${maxAttempts})`,
        );
      } catch (error) {
        this.logger.warn(
          `[VEO 4K] Poll error (attempt ${attempt + 1}/${maxAttempts}): ${(error as Error).message}`,
        );
      }
    }

    this.logger.warn(
      `[VEO 4K] Could not get 4K video for task ${taskId} — using default resolution`,
    );
    return [];
  }

  // ─── Download & upload to S3 ──────────────────────────────

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
            `[VEO] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download video from Veo (${response.status}): ${sourceUrl}`,
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

  // ─── Helpers ──────────────────────────────────────────────

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
