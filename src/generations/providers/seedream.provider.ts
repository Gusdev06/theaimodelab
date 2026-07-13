import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

// Seedream V5.0 Pro na WaveSpeed. Sem imagem de referência usamos o endpoint
// text-to-image; com imagem(ns), o endpoint de edição (image-to-image).
const WS_MODEL_T2I = 'bytedance/seedream-v5.0-pro';
const WS_MODEL_EDIT = 'bytedance/seedream-v5.0-pro/edit';

// WaveSpeed só cobra por dois tiers: 1k (barato) e 2k (caro). Não há mais 4K.
const RESOLUTION_MAP: Record<string, '1k' | '2k'> = {
  RES_1K: '1k',
  RES_2K: '2k',
  RES_4K: '2k', // legado -> tier máximo disponível
};

function mapResolution(resolution?: string): '1k' | '2k' {
  return (resolution && RESOLUTION_MAP[resolution]) || '2k';
}

const SAFETY_INSTRUCTION =
  'The subject is fully clothed in complete, opaque everyday attire that covers the chest, torso, ' +
  'hips, and groin. Clothing fits naturally and is not see-through. Swimwear, lingerie, and ' +
  'fashion-forward outfits are allowed when the prompt asks for them, as long as the chest, nipples, ' +
  'groin, and buttocks remain fully covered by opaque fabric.';

// Limite defensivo de tamanho do prompt.
const MAX_PROMPT_LENGTH = 4000;

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

interface CreatePredictionResponse {
  data?: { id?: string };
  id?: string;
  code?: number;
  message?: string;
}

interface PredictionResultResponse {
  code?: number;
  message?: string;
  data?: {
    id: string;
    status: 'created' | 'processing' | 'completed' | 'failed';
    outputs?: string[];
    error?: string;
  };
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
      'WAVESPEED_BASE_URL',
      'https://api.wavespeed.ai',
    );
    this.apiKey = (this.configService.get<string>('WAVESPEED_API_KEY', '') ?? '').trim();
    if (!this.apiKey) {
      this.logger.warn(
        'WAVESPEED_API_KEY is not set. Image generation will fail with a 401 from the provider.',
      );
    }
  }

  async generateImage(input: SeedreamImageInput): Promise<GenerationResult> {
    if (!this.apiKey) {
      this.logger.error('WAVESPEED_API_KEY is not configured.');
      throw new Error(USER_ERRORS.configMissing);
    }

    const resolution = mapResolution(input.resolution);
    const hasImages = !!input.imageUrls?.length;
    const model = hasImages ? WS_MODEL_EDIT : WS_MODEL_T2I;

    // Prompt: undress (skipSafetyWrapper) passa cru; o resto ganha o wrapper que
    // mantém o personagem vestido.
    const finalPrompt = input.skipSafetyWrapper
      ? input.prompt.trim().slice(0, MAX_PROMPT_LENGTH)
      : applySafetyWrapper(input.prompt);

    // `match_input_image` não existe na WaveSpeed: omitimos o campo e a API casa
    // com a 1ª imagem. Sem imagem, default 1:1.
    const requestedAspect = hasImages
      ? (input.aspectRatio ?? 'match_input_image')
      : (input.aspectRatio ?? '1:1');

    const body: Record<string, unknown> = {
      prompt: finalPrompt,
      resolution,
      output_format: 'jpeg',
      enable_base64_output: false,
      enable_sync_mode: false,
    };
    if (hasImages) body.images = input.imageUrls;
    if (requestedAspect && requestedAspect !== 'match_input_image') {
      body.aspect_ratio = requestedAspect;
    }

    this.logger.log(
      `Creating prediction: model=${model} resolution=${resolution} aspectRatio=${requestedAspect} imageUrls=${input.imageUrls?.length ?? 0} skipSafety=${!!input.skipSafetyWrapper} prompt="${input.prompt.slice(0, 120)}"`,
    );

    const predictionId = await this.createPrediction(model, body);
    this.logger.log(`Seedream prediction created: ${predictionId}`);

    const resultUrls = await this.pollPrediction(predictionId);

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

  private async createPrediction(
    model: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    // Retry once em erros transientes (WaveSpeed às vezes devolve 401/429/5xx em
    // chamadas concorrentes; um pequeno delay recupera).
    const maxAttempts = 2;
    const transientStatuses = new Set([401, 408, 429, 500, 502, 503, 504]);
    let lastErrorText = '';
    let lastStatus = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/v3/${model}`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        },
        60_000,
      );

      if (response.ok) {
        const data = (await response.json()) as CreatePredictionResponse;
        const predictionId = data.data?.id ?? data.id;
        if (!predictionId) {
          this.logger.error(
            `WaveSpeed createPrediction missing id in response: ${JSON.stringify(data)}`,
          );
          throw new Error(USER_ERRORS.startFailed);
        }
        return predictionId;
      }

      lastStatus = response.status;
      lastErrorText = await response.text();

      // Moderação de conteúdo -> ContentSafetyError (aciona o fallback do processor).
      const safetyError = ContentSafetyError.fromErrorMessage(lastErrorText);
      if (safetyError) throw safetyError;

      if (attempt < maxAttempts && transientStatuses.has(response.status)) {
        this.logger.warn(
          `[WAVESPEED_RETRY] createPrediction attempt=${attempt}/${maxAttempts} status=${response.status} body=${lastErrorText.slice(0, 200)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      break;
    }

    this.logger.error(
      `WaveSpeed createPrediction failed status=${lastStatus} body=${lastErrorText}`,
    );
    throw new Error(USER_ERRORS.startFailed);
  }

  private async pollPrediction(
    predictionId: string,
    maxAttempts = 120,
    intervalMs = 3_000,
  ): Promise<string[]> {
    const getUrl = `${this.baseUrl}/api/v3/predictions/${predictionId}/result`;
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          getUrl,
          { headers: this.headers() },
          30_000,
        );
      } catch (error) {
        networkFailures++;
        this.logger.warn(
          `Poll fetch failed (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
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
          `Poll HTTP error ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          const safetyError = ContentSafetyError.fromErrorMessage(errorText);
          if (safetyError) throw safetyError;
          throw new Error(USER_ERRORS.statusCheckFailed);
        }
        continue;
      }

      networkFailures = 0;
      const payload = (await response.json()) as PredictionResultResponse;
      const data = payload.data;
      if (!data) {
        this.logger.error(
          `WaveSpeed result empty payload for predictionId=${predictionId}`,
        );
        throw new Error(USER_ERRORS.statusCheckFailed);
      }

      if (data.status === 'completed') {
        const output = data.outputs ?? [];
        if (!output.length) {
          throw new Error(USER_ERRORS.noOutput);
        }
        return output;
      }

      if (data.status === 'failed') {
        const errorStr = data.error ?? 'unknown error';
        const safetyError = ContentSafetyError.fromErrorMessage(errorStr);
        if (safetyError) throw safetyError;
        this.logger.error(`Prediction failed: ${errorStr}`);
        throw new Error(USER_ERRORS.generationFailed);
      }

      this.logger.debug(
        `WaveSpeed prediction ${predictionId} ${data.status} (attempt ${attempt + 1}/${maxAttempts})`,
      );
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
            `Retrying downloadAndUpload (${attempt + 1}/${maxRetries}) for ${generationId}`,
          );
        }

        const response = await this.fetchWithTimeout(sourceUrl, {}, 60_000);
        if (!response.ok) {
          this.logger.error(
            `Download failed (${response.status}): ${sourceUrl}`,
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
