import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

/**
 * Kling V3 Turbo (image-to-video) via kie.ai.
 *
 * Mesma API assíncrona do KIE usada nos outros modelos (Seedance/Grok/Veo):
 *   POST {BASE}/api/v1/jobs/createTask  -> { data: { taskId } }
 *   GET  {BASE}/api/v1/jobs/recordInfo?taskId=... -> { data: { state, resultJson, failMsg } }
 *
 * Portado do goz-saas (src/lib/kie-video.ts), adaptado para o fluxo com fila
 * do theaimodelab: aqui o provider faz o polling internamente (roda dentro do
 * BullMQ worker) e devolve as URLs já persistidas no nosso storage.
 */

const KLING_MODEL = 'kling/v3-turbo-image-to-video';

const KLING_SAFETY_FAIL_CODES = new Set(['430']);

const RESOLUTION_MAP: Record<string, '720p' | '1080p'> = {
  RES_720P: '720p',
  RES_1080P: '1080p',
};

export interface KlingVideoInput {
  id: string;
  prompt?: string;
  /** URL pública da imagem de entrada (primeiro frame). Kling é image-to-video. */
  imageUrls: string[];
  resolution: string;
  durationSeconds: number;
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
    state: 'waiting' | 'queuing' | 'generating' | 'success' | 'fail';
    resultJson?: string;
    failCode?: string;
    failMsg?: string | null;
  } | null;
}

interface ResultJsonPayload {
  resultUrls?: string[];
}

@Injectable()
export class KlingProvider {
  private readonly logger = new Logger(KlingProvider.name);
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

  async generateImageToVideo(input: KlingVideoInput): Promise<GenerationResult> {
    if (!input.imageUrls?.length) {
      throw new Error('Kling: imagem de entrada (primeiro frame) ausente.');
    }

    const resolution = RESOLUTION_MAP[input.resolution] ?? '720p';
    // Kling V3 Turbo aceita duração de 3 a 15s (passo 1). Clampa pra faixa válida.
    const duration = Math.min(15, Math.max(3, Math.round(input.durationSeconds)));

    this.logger.log(
      `[KLING] resolution=${resolution} duration=${duration}s imageUrls=${input.imageUrls.length} prompt="${input.prompt ?? ''}"`,
    );

    const body = {
      model: KLING_MODEL,
      input: {
        prompt: input.prompt ?? '',
        image_urls: input.imageUrls,
        duration,
        resolution,
      },
    };

    const taskId = await this.submitTask(body);
    this.logger.log(`[KLING] Task submitted: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);
    this.logger.log(
      `[KLING] Task ${taskId} completed — resultUrls=${resultUrls.length}`,
    );

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error('Kling returned no video results.');
    }

    return { outputUrls, modelUsed: KLING_MODEL };
  }

  private async submitTask(body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/v1/jobs/createTask`;
    this.logger.log(`[KLING] POST ${url}`);

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
        `[KLING] createTask error (${response.status}): ${errorText}`,
      );
      throw new Error(`Kling createTask error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as CreateTaskResponse;

    if (data.code !== 200 || !data.data?.taskId) {
      throw new Error(`Kling createTask failed: ${data.msg} (code ${data.code})`);
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
          `[KLING POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `[KLING POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Kling recordInfo error (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (!data.data) {
        continue;
      }

      const { state } = data.data;

      if (state === 'waiting' || state === 'queuing' || state === 'generating') {
        this.logger.debug(
          `[KLING POLL] state=${state} (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      if (state === 'fail') {
        const failMsg = data.data.failMsg ?? data.msg ?? 'unknown error';
        const failCode = data.data.failCode ?? '';
        const fullMessage = `${failMsg}${failCode ? ` (${failCode})` : ''}`;

        if (
          KLING_SAFETY_FAIL_CODES.has(failCode) ||
          ContentSafetyError.fromErrorMessage(failMsg)
        ) {
          throw new ContentSafetyError(fullMessage, failCode || undefined);
        }

        throw new Error(`Kling generation failed: ${fullMessage}`);
      }

      if (state === 'success') {
        if (!data.data.resultJson) {
          throw new Error('Kling succeeded but resultJson is empty.');
        }

        let payload: ResultJsonPayload;
        try {
          payload = JSON.parse(data.data.resultJson) as ResultJsonPayload;
        } catch (err) {
          throw new Error(
            `Failed to parse Kling resultJson: ${(err as Error).message}`,
          );
        }

        const urls = payload.resultUrls ?? [];
        if (!urls.length) {
          throw new Error('Kling returned empty resultUrls.');
        }
        return urls;
      }
    }

    throw new Error('Kling generation timed out.');
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
            `[KLING] Retrying download (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download video from Kling (${response.status}): ${sourceUrl}`,
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
