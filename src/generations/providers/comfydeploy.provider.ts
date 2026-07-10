import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';

/**
 * ComfyDeploy — WanImageToVideo (image-to-video, uso NSFW/legacy).
 *
 * Portado do goz-saas (src/lib/comfydeploy.ts). Diferente dos modelos KIE, usa
 * a API própria da ComfyDeploy (api.comfydeploy.com):
 *   POST /api/run/deployment/queue  -> { run_id }
 *   GET  /api/run/{runId}           -> { status, progress, outputs }
 *
 * ATENÇÃO à duração: o external input `duration` do deployment é ligado direto
 * ao `length` (nº de FRAMES) do nó WanImageToVideo — o workflow NÃO converte
 * segundos→frames. Convertemos aqui: frames = round(segundos * 16) + 1
 * (formato 4n+1 esperado pelo Wan).
 */

const COMFYDEPLOY_MODEL = 'comfydeploy/wan-image-to-video';
const VIDEO_FRAME_RATE = 16;

const POLL_INTERVAL_MS = 4_000;
const POLL_TIMEOUT_MS = 10 * 60_000; // 10 min

type RunStatus =
  | 'queued'
  | 'running'
  | 'started'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timeout';

interface Run {
  id: string;
  status: RunStatus;
  progress?: number;
  live_status?: string | null;
  outputs?: Array<{ data?: { files?: Array<{ url?: string }> } }>;
}

export interface ComfyDeployVideoInput {
  id: string;
  prompt: string;
  /** URL pública da imagem de entrada. */
  imageUrl: string;
  durationSeconds: number;
}

/** Converte segundos em frames no formato 4n+1 aceito pelo WanImageToVideo. */
function secondsToFrames(seconds: number): number {
  return Math.round(seconds * VIDEO_FRAME_RATE) + 1;
}

@Injectable()
export class ComfyDeployProvider {
  private readonly logger = new Logger(ComfyDeployProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly deploymentId: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    this.baseUrl = this.configService
      .get<string>('COMFYDEPLOY_BASE_URL', 'https://api.comfydeploy.com')
      .replace(/\/+$/, '');
    this.apiKey = this.configService.get<string>('COMFYDEPLOY_API_KEY', '');
    this.deploymentId = this.configService.get<string>(
      'COMFYDEPLOY_DEPLOYMENT_ID',
      '',
    );
  }

  async generateImageToVideo(
    input: ComfyDeployVideoInput,
  ): Promise<GenerationResult> {
    if (!this.apiKey) throw new Error('COMFYDEPLOY_API_KEY missing');
    if (!this.deploymentId) throw new Error('COMFYDEPLOY_DEPLOYMENT_ID missing');
    if (!input.imageUrl) throw new Error('ComfyDeploy: imagem de entrada ausente.');

    const frames = secondsToFrames(input.durationSeconds);
    this.logger.log(
      `[COMFYDEPLOY] duration=${input.durationSeconds}s (${frames} frames) prompt="${input.prompt}"`,
    );

    const runId = await this.queueRun({
      input_image: input.imageUrl,
      prompt: input.prompt,
      duration: frames,
    });
    this.logger.log(`[COMFYDEPLOY] Run queued: ${runId}`);

    const resultUrl = await this.pollRun(runId);
    this.logger.log(`[COMFYDEPLOY] Run ${runId} completed`);

    const outputUrl = await this.downloadAndUpload(resultUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: COMFYDEPLOY_MODEL };
  }

  private async queueRun(inputs: {
    input_image: string;
    prompt: string;
    duration: number;
  }): Promise<string> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/run/deployment/queue`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ deployment_id: this.deploymentId, inputs }),
      },
      60_000,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ComfyDeploy queue ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as { run_id?: string; id?: string };
    const runId = data.run_id ?? data.id;
    if (!runId) throw new Error('ComfyDeploy queue: missing run id');
    return runId;
  }

  private async pollRun(runId: string): Promise<string> {
    const start = Date.now();
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      let run: Run;
      try {
        const response = await this.fetchWithTimeout(
          `${this.baseUrl}/api/run/${runId}`,
          { headers: this.headers() },
          30_000,
        );
        if (!response.ok) {
          throw new Error(`ComfyDeploy status ${response.status}`);
        }
        run = (await response.json()) as Run;
        networkFailures = 0;
      } catch (error) {
        networkFailures++;
        this.logger.warn(
          `[COMFYDEPLOY POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
        );
        if (networkFailures >= maxNetworkRetries) throw error;
        continue;
      }

      if (run.status === 'success') {
        const url = run.outputs?.[0]?.data?.files?.[0]?.url;
        if (!url) {
          throw new Error('ComfyDeploy: run succeeded but no output url');
        }
        return url;
      }

      if (
        run.status === 'failed' ||
        run.status === 'cancelled' ||
        run.status === 'timeout'
      ) {
        throw new Error(`ComfyDeploy: run ${run.status}`);
      }

      this.logger.debug(
        `[COMFYDEPLOY POLL] status=${run.status} progress=${run.progress ?? 0}`,
      );
    }

    throw new Error('ComfyDeploy generation timed out.');
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
        }
        const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
        if (!response.ok) {
          throw new Error(
            `Failed to download video from ComfyDeploy (${response.status}): ${sourceUrl}`,
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

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, ...extra };
  }
}
