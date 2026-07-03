import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import { ContentSafetyError } from '../errors/content-safety.error';

const RESOLUTION_MAP: Record<string, string> = {
  RES_2K: '2K',
  RES_4K: '4K',
};

const SEEDREAM_MODEL_SLUG = 'bytedance/seedream-4.5';
const REPLICATE_BASE_URL = 'https://api.replicate.com/v1';

const SAFETY_INSTRUCTION =
  'The subject is fully clothed in complete, opaque everyday attire that covers the chest, torso, ' +
  'hips, and groin. Clothing fits naturally and is not see-through. Swimwear, lingerie, and ' +
  'fashion-forward outfits are allowed when the prompt asks for them, as long as the chest, nipples, ' +
  'groin, and buttocks remain fully covered by opaque fabric.';

// Replicate (bytedance/seedream-4.5) rejeita input.prompt > 4000 chars (422).
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
  resolutionUnsupported: 'Resolução não suportada por esse modelo.',
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
}

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string[] | string | null;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
}

@Injectable()
export class SeedreamProvider {
  private readonly logger = new Logger(SeedreamProvider.name);
  private readonly apiToken: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    this.apiToken = this.configService.get<string>('REPLICATE_API_TOKEN', '');
  }

  async generateImage(input: SeedreamImageInput): Promise<GenerationResult> {
    if (!this.apiToken) {
      this.logger.error('REPLICATE_API_TOKEN is not configured.');
      throw new Error(USER_ERRORS.configMissing);
    }

    const size = RESOLUTION_MAP[input.resolution];
    if (!size) {
      throw new Error(USER_ERRORS.resolutionUnsupported);
    }

    const aspectRatio = input.imageUrls?.length
      ? (input.aspectRatio ?? 'match_input_image')
      : (input.aspectRatio ?? '1:1');

    const wrappedPrompt = applySafetyWrapper(input.prompt);
    if (wrappedPrompt.length < input.prompt.trim().length + 2 + SAFETY_INSTRUCTION.length) {
      this.logger.warn(
        `Prompt truncado para caber no limite de ${MAX_PROMPT_LENGTH} chars da API (original: ${input.prompt.trim().length} chars).`,
      );
    }

    const body = {
      input: {
        prompt: wrappedPrompt,
        size,
        aspect_ratio: aspectRatio,
        sequential_image_generation: 'disabled',
        max_images: 1,
        disable_safety_checker: true,
        ...(input.imageUrls?.length && { image_input: input.imageUrls }),
      },
    };

    this.logger.log(
      `Creating prediction: size=${size} aspectRatio=${aspectRatio} imageUrls=${input.imageUrls?.length ?? 0} prompt="${input.prompt}" (safety wrapper applied)`,
    );

    const createResponse = await this.fetchWithTimeout(
      `${REPLICATE_BASE_URL}/models/${SEEDREAM_MODEL_SLUG}/predictions`,
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
      this.logger.error(
        `Create prediction error (${createResponse.status}): ${errorText}`,
      );
      throw new Error(USER_ERRORS.startFailed);
    }

    const prediction = (await createResponse.json()) as Prediction;
    this.logger.log(`Seedream prediction created: ${prediction.id}`);

    const resultUrls = await this.pollPrediction(prediction);

    const outputUrls: string[] = [];
    for (let i = 0; i < resultUrls.length; i++) {
      const url = await this.downloadAndUpload(resultUrls[i], input.id, i);
      outputUrls.push(url);
    }

    if (!outputUrls.length) {
      throw new Error(USER_ERRORS.noImages);
    }

    this.logger.log(`${outputUrls.length} image(s) uploaded to S3`);
    return { outputUrls, modelUsed: 'sem-censura' };
  }

  private async pollPrediction(
    initial: Prediction,
    maxAttempts = 120,
    intervalMs = 3_000,
  ): Promise<string[]> {
    const getUrl =
      initial.urls?.get ?? `${REPLICATE_BASE_URL}/predictions/${initial.id}`;

    let current = initial;
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (current.status === 'succeeded') {
        const output = Array.isArray(current.output)
          ? current.output
          : current.output
            ? [current.output]
            : [];
        if (!output.length) {
          throw new Error(USER_ERRORS.noOutput);
        }
        return output;
      }

      if (current.status === 'failed' || current.status === 'canceled') {
        const errorStr = current.error ?? 'unknown error';
        const safetyError = ContentSafetyError.fromErrorMessage(errorStr);
        if (safetyError) throw safetyError;
        this.logger.error(
          `Prediction ${current.status}: ${errorStr}`,
        );
        throw new Error(USER_ERRORS.generationFailed);
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));

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
      current = (await response.json()) as Prediction;
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
      Authorization: `Bearer ${this.apiToken}`,
    };
  }
}
