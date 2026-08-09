import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

// Seedream V5.0 Pro na KIE (api.kie.ai). Sem imagem de referência usamos o
// modelo text-to-image; com imagem(ns), o modelo image-to-image (edição).
// Reutiliza a mesma conta/credenciais da KIE (NANO_BANANA_*), como o
// SeedreamLiteProvider — não há env própria.
const KIE_MODEL_T2I = 'seedream/5-pro-text-to-image';
const KIE_MODEL_I2I = 'seedream/5-pro-image-to-image';

// KIE Seedream Pro: `quality` basic → 1K, high → 2K (não há 4K).
const QUALITY_MAP: Record<string, 'basic' | 'high'> = {
  RES_1K: 'basic',
  RES_2K: 'high',
  RES_4K: 'high', // legado -> tier máximo disponível
};

// Códigos de fail retornados pela KIE que indicam moderação de conteúdo.
const SEEDREAM_SAFETY_FAIL_CODES = new Set(['430']);

// Proporções suportadas pela KIE Seedream Pro. O valor numérico é usado para
// casar com a proporção da imagem de entrada quando o request não especifica
// aspect (antigo `match_input_image` da WaveSpeed).
const SUPPORTED_ASPECTS: { label: string; ratio: number }[] = [
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '21:9', ratio: 21 / 9 },
];
const SUPPORTED_ASPECT_LABELS = new Set(SUPPORTED_ASPECTS.map((a) => a.label));

const SAFETY_INSTRUCTION =
  'The subject is fully clothed in complete, opaque everyday attire that covers the chest, torso, ' +
  'hips, and groin. Clothing fits naturally and is not see-through. Swimwear, lingerie, and ' +
  'fashion-forward outfits are allowed when the prompt asks for them, as long as the chest, nipples, ' +
  'groin, and buttocks remain fully covered by opaque fabric.';

// Limite defensivo de tamanho do prompt (KIE Seedream Pro aceita até 5000 chars).
const MAX_PROMPT_LENGTH = 5000;

function applySafetyWrapper(prompt: string): string {
  const separator = '\n\n';
  // Orçamento disponível para o prompt do usuário, descontando o wrapper de segurança
  // (que é fixo e não pode ser cortado, sob pena de perder a instrução de segurança).
  const reserved = separator.length + SAFETY_INSTRUCTION.length;
  const maxUserPrompt = MAX_PROMPT_LENGTH - reserved;

  const trimmed = prompt.trim().slice(0, Math.max(0, maxUserPrompt));
  return `${trimmed}${separator}${SAFETY_INSTRUCTION}`;
}

// User-facing error messages (never expose provider name or technical detail)
const USER_ERRORS = {
  configMissing: 'Serviço de geração indisponível no momento. Tente novamente em instantes.',
  startFailed: 'Não foi possível iniciar a geração. Tente novamente em instantes.',
  generationFailed: 'Não foi possível gerar a imagem. Tente novamente.',
  statusCheckFailed: 'Falha ao verificar o status da geração. Tente novamente.',
  noOutput: 'A geração foi concluída, mas não retornou imagens. Tente novamente.',
  timeout: 'A geração demorou mais que o esperado. Tente novamente.',
  downloadFailed: 'Falha ao baixar a imagem gerada. Tente novamente.',
  noImages: 'Nenhuma imagem foi gerada. Tente novamente.',
};

export interface SeedreamImageInput {
  id: string;
  prompt: string;
  resolution: string;
  aspectRatio?: string;
  imageUrls?: string[];
  /**
   * Pula o wrapper de segurança (que força roupa no personagem). Usado no fluxo
   * de undress, onde o prompt explícito precisa passar intacto.
   */
  skipSafetyWrapper?: boolean;
  /** Tag salva em `modelUsed` (default `sem-censura`; undress usa `deepdeep`). */
  modelUsedTag?: string;
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
export class SeedreamProvider {
  private readonly logger = new Logger(SeedreamProvider.name);
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
    this.apiKey = (
      this.configService.get<string>('NANO_BANANA_API_KEY', '') ?? ''
    ).trim();
    if (!this.apiKey) {
      this.logger.warn(
        'NANO_BANANA_API_KEY (KIE) is not set. Image generation will fail with a 401 from the provider.',
      );
    }
  }

  async generateImage(input: SeedreamImageInput): Promise<GenerationResult> {
    if (!this.apiKey) {
      this.logger.error('NANO_BANANA_API_KEY (KIE) is not configured.');
      throw new Error(USER_ERRORS.configMissing);
    }

    const quality = QUALITY_MAP[input.resolution] ?? 'high';
    const hasImages = !!input.imageUrls?.length;
    const model = hasImages ? KIE_MODEL_I2I : KIE_MODEL_T2I;

    // Prompt: undress (skipSafetyWrapper) passa cru; o resto ganha o wrapper que
    // mantém o personagem vestido.
    const finalPrompt = input.skipSafetyWrapper
      ? input.prompt.trim().slice(0, MAX_PROMPT_LENGTH)
      : applySafetyWrapper(input.prompt);

    // KIE exige aspect_ratio fixo (não tem `match_input_image`). Quando o request
    // não define, derivamos da proporção da 1ª imagem de entrada.
    const aspectRatio = await this.resolveAspectRatio(input);

    this.logger.log(
      `[SEEDREAM_PRO] mode=${hasImages ? 'image-to-image' : 'text-to-image'} quality=${quality} aspectRatio=${aspectRatio} images=${input.imageUrls?.length ?? 0} skipSafety=${!!input.skipSafetyWrapper} prompt="${input.prompt.slice(0, 120)}"`,
    );

    const body = {
      model,
      input: {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        quality,
        output_format: 'jpeg',
        // Este é o provider "sem-censura" (undress / face-swap unlocked /
        // fallback de segurança) — nunca bloqueamos no checker da KIE.
        nsfw_checker: false,
        ...(hasImages ? { image_urls: input.imageUrls } : {}),
      },
    };

    const taskId = await this.submitTask(body);
    this.logger.log(`[SEEDREAM_PRO] Task submitted: ${taskId}`);

    const resultUrls = await this.pollTaskStatus(taskId);
    this.logger.log(
      `[SEEDREAM_PRO] Task ${taskId} completed — resultUrls=${resultUrls.length}`,
    );

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error(USER_ERRORS.noImages);
    }

    this.logger.log(`${outputUrls.length} image(s) uploaded to S3`);
    return { outputUrls, modelUsed: input.modelUsedTag ?? 'sem-censura' };
  }

  /**
   * Resolve o `aspect_ratio` para um dos valores suportados pela KIE. Se o
   * request especifica uma proporção válida, usa direto; caso contrário (vazio
   * ou `match_input_image`), casa com a proporção da 1ª imagem de entrada.
   */
  private async resolveAspectRatio(
    input: SeedreamImageInput,
  ): Promise<string> {
    const requested = input.aspectRatio?.trim();

    if (requested && requested !== 'match_input_image') {
      if (SUPPORTED_ASPECT_LABELS.has(requested)) return requested;
      const parsed = this.parseRatio(requested);
      if (parsed) return this.nearestAspect(parsed);
      return '1:1';
    }

    // Sem aspect explícito: deriva da imagem de entrada (preserva o comportamento
    // `match_input_image` da WaveSpeed, essencial no undress/face-swap).
    const firstUrl = input.imageUrls?.[0];
    if (firstUrl) {
      try {
        const ratio = await this.readImageAspect(firstUrl);
        if (ratio) return this.nearestAspect(ratio);
      } catch (error) {
        this.logger.warn(
          `[SEEDREAM_PRO] Could not read input image dimensions, defaulting to 1:1: ${(error as Error).message}`,
        );
      }
    }
    return '1:1';
  }

  private async readImageAspect(url: string): Promise<number | null> {
    const response = await this.fetchWithTimeout(url, {}, 30_000);
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;
    return meta.width / meta.height;
  }

  private nearestAspect(ratio: number): string {
    let best = SUPPORTED_ASPECTS[0];
    let bestDiff = Infinity;
    for (const aspect of SUPPORTED_ASPECTS) {
      // Diferença em escala logarítmica → mais perceptualmente correta.
      const diff = Math.abs(Math.log(aspect.ratio) - Math.log(ratio));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = aspect;
      }
    }
    return best.label;
  }

  private parseRatio(value: string): number | null {
    const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const w = parseFloat(match[1]);
    const h = parseFloat(match[2]);
    if (!w || !h) return null;
    return w / h;
  }

  private async submitTask(body: Record<string, unknown>): Promise<string> {
    const url = `${this.baseUrl}/api/v1/jobs/createTask`;

    // Retry once em erros transientes (429/5xx).
    const maxAttempts = 2;
    const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
    let lastErrorText = '';
    let lastStatus = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        },
        60_000,
      );

      if (response.ok) {
        const data = (await response.json()) as CreateTaskResponse;
        if (data.code === 200 && data.data?.taskId) {
          return data.data.taskId;
        }
        // Moderação de conteúdo devolvida no corpo -> ContentSafetyError.
        const safetyError = ContentSafetyError.fromErrorMessage(data.msg);
        if (safetyError) throw safetyError;
        this.logger.error(
          `[SEEDREAM_PRO] createTask failed: ${data.msg} (code ${data.code})`,
        );
        throw new Error(USER_ERRORS.startFailed);
      }

      lastStatus = response.status;
      lastErrorText = await response.text();

      const safetyError = ContentSafetyError.fromErrorMessage(lastErrorText);
      if (safetyError) throw safetyError;

      if (attempt < maxAttempts && transientStatuses.has(response.status)) {
        this.logger.warn(
          `[SEEDREAM_PRO_RETRY] createTask attempt=${attempt}/${maxAttempts} status=${response.status} body=${lastErrorText.slice(0, 200)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      break;
    }

    this.logger.error(
      `[SEEDREAM_PRO] createTask failed status=${lastStatus} body=${lastErrorText}`,
    );
    throw new Error(USER_ERRORS.startFailed);
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
          `[SEEDREAM_PRO POLL] Fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(USER_ERRORS.statusCheckFailed);
        }
        continue;
      }

      if (!response.ok) {
        networkFailures++;
        const errorText = await response.text();
        this.logger.warn(
          `[SEEDREAM_PRO POLL] HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          const safetyError = ContentSafetyError.fromErrorMessage(errorText);
          if (safetyError) throw safetyError;
          throw new Error(USER_ERRORS.statusCheckFailed);
        }
        continue;
      }

      networkFailures = 0;
      const data = (await response.json()) as RecordInfoResponse;

      if (!data.data) {
        this.logger.debug(
          `[SEEDREAM_PRO POLL] No data in response (attempt ${attempt + 1}/${maxAttempts})`,
        );
        continue;
      }

      const { state } = data.data;

      if (state === 'waiting' || state === 'queuing' || state === 'generating') {
        this.logger.debug(
          `[SEEDREAM_PRO POLL] state=${state} (attempt ${attempt + 1}/${maxAttempts})`,
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

        this.logger.error(`[SEEDREAM_PRO] Prediction failed: ${fullMessage}`);
        throw new Error(USER_ERRORS.generationFailed);
      }

      if (state === 'success') {
        if (!data.data.resultJson) {
          throw new Error(USER_ERRORS.noOutput);
        }

        let payload: ResultJsonPayload;
        try {
          payload = JSON.parse(data.data.resultJson) as ResultJsonPayload;
        } catch (err) {
          this.logger.error(
            `[SEEDREAM_PRO] Failed to parse resultJson: ${(err as Error).message}`,
          );
          throw new Error(USER_ERRORS.generationFailed);
        }

        const urls = payload.resultUrls ?? [];
        if (!urls.length) {
          throw new Error(USER_ERRORS.noOutput);
        }
        return urls;
      }
    }

    throw new Error(USER_ERRORS.timeout);
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
            `[SEEDREAM_PRO] Retrying downloadAndUpload (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          this.logger.error(
            `[SEEDREAM_PRO] Download failed (${response.status}): ${sourceUrl}`,
          );
          throw new Error(USER_ERRORS.downloadFailed);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType =
          response.headers.get('content-type') ?? 'image/jpeg';
        const ext = contentType.includes('png') ? 'png' : 'jpg';

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
