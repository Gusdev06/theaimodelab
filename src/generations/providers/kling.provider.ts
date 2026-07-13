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

// Model identifier da kie.ai para a família Kling 3.0 (inclui o Turbo).
// Na kie o createTask usa uma única string; a variante/resolução é escolhida
// pelo campo `input.mode` (std/pro/4K), não por um model id separado.
const KLING_MODEL = 'kling-3.0/video';

// Slug estável salvo em generation.modelUsed (mantém o rótulo do produto).
const KLING_MODEL_SLUG = 'kling-v3-turbo';

const KLING_SAFETY_FAIL_CODES = new Set(['430']);

// Kling 3.0 na kie.ai seleciona a resolução pelo "mode":
//   std = 720p, pro = 1080p, 4K = 2160p
const MODE_MAP: Record<string, 'std' | 'pro' | '4K'> = {
  RES_720P: 'std',
  RES_1080P: 'pro',
};

export interface KlingVideoInput {
  id: string;
  prompt?: string;
  /** URL pública da imagem de entrada (primeiro frame). Kling é image-to-video. */
  imageUrls: string[];
  resolution: string;
  durationSeconds: number;
  /** Proporção do vídeo: '16:9' | '9:16' | '1:1'. Default '9:16' se ausente. */
  aspectRatio?: string;
  /** Gerar com áudio nativo. Default false. */
  generateAudio?: boolean;
}

const KLING_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1']);

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

    const mode = MODE_MAP[input.resolution] ?? 'std';
    // Kling V3 Turbo aceita duração de 3 a 15s (passo 1). Clampa pra faixa válida.
    const duration = Math.min(15, Math.max(3, Math.round(input.durationSeconds)));
    const aspectRatio =
      input.aspectRatio && KLING_ASPECT_RATIOS.has(input.aspectRatio)
        ? input.aspectRatio
        : '9:16';
    const sound = input.generateAudio ?? false;

    this.logger.log(
      `[KLING] mode=${mode} duration=${duration}s aspect=${aspectRatio} sound=${sound} imageUrls=${input.imageUrls.length} prompt="${input.prompt ?? ''}"`,
    );

    // Formato atual do createTask da kie.ai para kling-3.0/video.
    // `duration` é string, resolução vai em `mode`, e os campos de multi-shot
    // são obrigatórios (mandamos vazios pra geração single-shot).
    const body = {
      model: KLING_MODEL,
      input: {
        prompt: input.prompt ?? '',
        image_urls: input.imageUrls,
        sound,
        duration: String(duration),
        aspect_ratio: aspectRatio,
        mode,
        multi_shots: false,
        multi_prompt: [],
        kling_elements: [],
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

    return { outputUrls, modelUsed: KLING_MODEL_SLUG };
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
