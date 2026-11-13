import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import * as sharp from 'sharp';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import {
  ContentSafetyError,
  isMinorSafetyBlock,
} from '../errors/content-safety.error';
import { isMinorRefusal } from '../errors/minor-refusal';
import { ProviderFailureError } from '../errors/failure-reason';
import { adultSafePrompt } from '../../content-safety/adult-anchor';

// Seedream V5.0 Pro na KIE (api.kie.ai). Sem imagem de referência usamos o
// modelo text-to-image; com imagem(ns), o modelo image-to-image (edição).
// Reutiliza a mesma conta/credenciais da KIE (NANO_BANANA_*), como o
// SeedreamLiteProvider — não há env própria.
const KIE_MODEL_T2I = 'seedream/5-pro-text-to-image';
const KIE_MODEL_I2I = 'seedream/5-pro-image-to-image';

// Motor do Unlocked (13/11/2026): o Seedream 5 Lite, na mesma conta da KIE, custa bem menos que o Pro. Fica atrás de
// UNLOCKED_ENGINE=lite, com canário por usuário (UNLOCKED_ENGINE_CANARY_PCT, padrão 100 quando o motor é lite) e o
// Pro como reserva automática se o Lite falhar ou recusar (recusa por menor nunca é refeita). Sem a env = Pro, igual
// a antes. Só vale para quem pede (`engineSwapEligible`): Unlocked direto e desvio de segurança; troca de rosto e
// Undress seguem no Pro.
const KIE_LITE_T2I = 'seedream/5-lite-text-to-image';
const KIE_LITE_I2I = 'seedream/5-lite-image-to-image';
export type UnlockedEngine = 'pro' | 'lite';
const LITE_POLL_ATTEMPTS = 45;

/**
 * Desvio de segurança que pode rodar no motor alternativo do Unlocked: só o das imagens (processImage*,
 * processNanoBanana). Troca de rosto e provador ficam no Pro, e o desvio do próprio Seedream Lite também (mandar de
 * volta ao Lite que acabou de recusar é chamada perdida).
 */
export function isUnlockedEngineSwapContext(context: string): boolean {
  return (
    /^process(Image|NanoBanana)/.test(context) &&
    !context.endsWith(':seedream-5-lite')
  );
}

// Plano B do Unlocked (TKT-216): quando a KIE nem aceita a tarefa (saldo zerado, 5xx, rede), a mesma geração roda no
// Seedream V5.0 Pro da WaveSpeed, que era o motor do Unlocked até agosto. Só com UNLOCKED_WAVESPEED_FALLBACK=true e
// WAVESPEED_API_KEY. Só no 'sem-censura' (o Undress fica como está). Nas panes de 05 a 08/11/2026 foram 585 falhas
// "Não foi possível iniciar a geração" em 86 contas, porque a imagem 18+ inteira dependia de um único saldo.
const WS_MODEL_T2I = 'bytedance/seedream-v5.0-pro';
const WS_MODEL_EDIT = 'bytedance/seedream-v5.0-pro/edit';
const WS_RESOLUTION: Record<string, '1k' | '2k'> = {
  RES_1K: '1k',
  RES_2K: '2k',
  RES_4K: '2k',
};

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
  configMissing:
    'Serviço de geração indisponível no momento. Tente novamente em instantes.',
  startFailed:
    'Não foi possível iniciar a geração. Tente novamente em instantes.',
  generationFailed: 'Não foi possível gerar a imagem. Tente novamente.',
  statusCheckFailed: 'Falha ao verificar o status da geração. Tente novamente.',
  noOutput:
    'A geração foi concluída, mas não retornou imagens. Tente novamente.',
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
  /** Pode rodar no motor alternativo do Unlocked (UNLOCKED_ENGINE). Só Unlocked direto e desvio de segurança. */
  engineSwapEligible?: boolean;
  /** Chave do canário (o id do usuário): a mesma pessoa cai sempre no mesmo motor. Sem ela, usa o id da geração. */
  canaryKey?: string;
}

/** Resultado do Seedream com o motor que de fato gerou (para o custo por motor no cockpit). */
export interface SeedreamGenerationResult extends GenerationResult {
  engine: UnlockedEngine;
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

interface WavespeedCreateResponse {
  id?: string;
  data?: { id?: string };
}

interface WavespeedResultResponse {
  data?: {
    status?: 'created' | 'processing' | 'completed' | 'failed';
    outputs?: string[];
    error?: string;
  };
}

@Injectable()
export class SeedreamProvider {
  private readonly logger = new Logger(SeedreamProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly wavespeedBaseUrl: string;
  private readonly wavespeedApiKey: string;
  private readonly wavespeedFallbackEnabled: boolean;
  private readonly unlockedEngine: UnlockedEngine;
  private readonly unlockedCanaryPct: number;

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
    this.wavespeedBaseUrl = this.configService.get<string>(
      'WAVESPEED_BASE_URL',
      'https://api.wavespeed.ai',
    );
    this.wavespeedApiKey = (
      this.configService.get<string>('WAVESPEED_API_KEY', '') ?? ''
    ).trim();
    const fallbackFlag = String(
      this.configService.get<string>('UNLOCKED_WAVESPEED_FALLBACK', '') ?? '',
    )
      .trim()
      .toLowerCase();
    this.wavespeedFallbackEnabled =
      (fallbackFlag === 'true' || fallbackFlag === '1') &&
      !!this.wavespeedApiKey;
    const engineFlag = String(
      this.configService.get<string>('UNLOCKED_ENGINE', '') ?? '',
    )
      .trim()
      .toLowerCase();
    this.unlockedEngine = engineFlag === 'lite' ? 'lite' : 'pro';
    const pctRaw = String(
      this.configService.get<string>('UNLOCKED_ENGINE_CANARY_PCT', '') ?? '',
    ).trim();
    // Sem valor (ou inválido) = 0%: o canário precisa ser dito por extenso (env em branco no painel nunca vira "todos").
    const pct = /^\d{1,3}$/.test(pctRaw) ? Number(pctRaw) : 0;
    this.unlockedCanaryPct = Math.min(100, pct);
    if (this.unlockedEngine === 'lite') {
      this.logger.log(
        `[UNLOCKED_ENGINE] motor alternativo=lite canário=${this.unlockedCanaryPct}%${this.unlockedCanaryPct === 0 ? ' (UNLOCKED_ENGINE_CANARY_PCT vazio ou inválido: ninguém no Lite)' : ''}`,
      );
    }
    if (!this.apiKey) {
      this.logger.warn(
        'NANO_BANANA_API_KEY (KIE) is not set. Image generation will fail with a 401 from the provider.',
      );
    }
  }

  async generateImage(
    input: SeedreamImageInput,
  ): Promise<SeedreamGenerationResult> {
    if (!this.apiKey) {
      this.logger.error('NANO_BANANA_API_KEY (KIE) is not configured.');
      throw new Error(USER_ERRORS.configMissing);
    }

    if (this.pickEngine(input) === 'lite') {
      try {
        return await this.generateOnKie(input, 'lite');
      } catch (error) {
        // Recusa de CONTEÚDO do Lite é terminal, como a do Pro sempre foi: o Pro não vira "segunda opinião" (com o
        // nsfw_checker desligado, o que sobra de moderação é o duro: menor, CSAM, pessoa real). Só a falha técnica
        // (saldo, rede, 5xx, tempo, upload) refaz no Pro.
        if (
          error instanceof ContentSafetyError ||
          isMinorSafetyBlock(error) ||
          isMinorRefusal(error)
        ) {
          throw error;
        }
        this.logger.warn(
          `[UNLOCKED_ENGINE] gen=${input.id} o Lite não entregou (${(error as Error).message}); refazendo no Pro`,
        );
      }
    }
    return this.generateOnKie(input, 'pro');
  }

  /**
   * Motor desta geração. Pro, salvo quando UNLOCKED_ENGINE=lite, a chamada aceita troca de motor e a pessoa (canaryKey)
   * cai dentro do canário. O sorteio é estável: o mesmo usuário vê sempre o mesmo motor.
   */
  pickEngine(input: SeedreamImageInput): UnlockedEngine {
    if (this.unlockedEngine !== 'lite' || !input.engineSwapEligible) {
      return 'pro';
    }
    if (this.unlockedCanaryPct >= 100) return 'lite';
    if (this.unlockedCanaryPct <= 0) return 'pro';
    const digest = createHash('sha256')
      .update(`unlocked-engine:${input.canaryKey || input.id}`)
      .digest();
    return digest.readUInt32BE(0) % 100 < this.unlockedCanaryPct
      ? 'lite'
      : 'pro';
  }

  private async generateOnKie(
    input: SeedreamImageInput,
    engine: UnlockedEngine,
  ): Promise<SeedreamGenerationResult> {
    const hasImages = !!input.imageUrls?.length;
    // Pro: basic = 1K, high = 2K. Lite: basic = 2K (high = 3K): o Lite sempre em 2K, a resolução do Unlocked.
    const quality =
      engine === 'lite' ? 'basic' : (QUALITY_MAP[input.resolution] ?? 'high');
    const model =
      engine === 'lite'
        ? hasImages
          ? KIE_LITE_I2I
          : KIE_LITE_T2I
        : hasImages
          ? KIE_MODEL_I2I
          : KIE_MODEL_T2I;

    // Prompt: o modelo sem censura (skipSafetyWrapper: Unlocked, despir, desvio de segurança) recebe o pedido com a
    // âncora de adulto (toda pessoa gerada é adulta; gíria de juventude vira "mulher adulta"); o resto ganha o wrapper
    // que mantém o personagem vestido.
    const finalPrompt = input.skipSafetyWrapper
      ? adultSafePrompt(input.prompt, MAX_PROMPT_LENGTH)
      : applySafetyWrapper(input.prompt);

    // KIE exige aspect_ratio fixo (não tem `match_input_image`). Quando o request
    // não define, derivamos da proporção da 1ª imagem de entrada.
    const aspectRatio = await this.resolveAspectRatio(input);

    this.logger.log(
      `[SEEDREAM_PRO] engine=${engine} mode=${hasImages ? 'image-to-image' : 'text-to-image'} quality=${quality} aspectRatio=${aspectRatio} images=${input.imageUrls?.length ?? 0} skipSafety=${!!input.skipSafetyWrapper} prompt="${input.prompt.slice(0, 120)}"`,
    );

    const body = {
      model,
      input: {
        prompt: finalPrompt,
        aspect_ratio: aspectRatio,
        quality,
        // JPEG nos dois motores: sem isso o Lite devolve PNG de ~5 MB (testado em 13/11: com jpeg, ~400 KB)
        output_format: 'jpeg',
        // Este é o provider "sem-censura" (undress / face-swap unlocked /
        // fallback de segurança) — nunca bloqueamos no checker da KIE.
        nsfw_checker: false,
        ...(hasImages ? { image_urls: input.imageUrls } : {}),
      },
    };

    let taskId: string;
    try {
      taskId = await this.submitTask(body, engine === 'lite');
    } catch (error) {
      // recusa de conteúdo segue o caminho de sempre; só a falha técnica de início vai ao plano B
      // o Lite não vai à WaveSpeed: quem cuida da falha dele é o Pro, que tem o próprio plano B
      if (
        engine === 'lite' ||
        error instanceof ContentSafetyError ||
        !this.canUseWavespeedFallback(input)
      ) {
        throw error;
      }
      this.logger.warn(
        `[SEEDREAM_PRO→WAVESPEED] gen=${input.id} a KIE não aceitou a tarefa (${(error as Error).message}); plano B na WaveSpeed`,
      );
      return this.generateViaWavespeed(
        input,
        finalPrompt,
        aspectRatio,
        error as Error,
      );
    }
    this.logger.log(`[SEEDREAM_PRO] Task submitted: ${taskId}`);

    // o Lite responde em ~40 s: espera curta (~3 min) para o Pro ainda caber no prazo do cron de travadas (20 min)
    const resultUrls = await this.pollTaskStatus(
      taskId,
      engine === 'lite' ? LITE_POLL_ATTEMPTS : undefined,
    );
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
    return {
      outputUrls,
      modelUsed: input.modelUsedTag ?? 'sem-censura',
      engine,
    };
  }

  /**
   * Resolve o `aspect_ratio` para um dos valores suportados pela KIE. Se o
   * request especifica uma proporção válida, usa direto; caso contrário (vazio
   * ou `match_input_image`), casa com a proporção da 1ª imagem de entrada.
   */
  private async resolveAspectRatio(input: SeedreamImageInput): Promise<string> {
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

  private async submitTask(
    body: Record<string, unknown>,
    keepProviderDetail = false,
  ): Promise<string> {
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
        throw this.startError(
          keepProviderDetail,
          `${data.msg} (code ${data.code})`,
        );
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
    throw this.startError(
      keepProviderDetail,
      `status=${lastStatus} ${lastErrorText.slice(0, 500)}`,
    );
  }

  /**
   * Erro de início. No Pro segue o Error genérico de sempre. No Lite guarda o texto do provedor
   * (ProviderFailureError.providerDetail) para a trava de menor ler antes de decidir refazer no Pro.
   */
  private startError(keepProviderDetail: boolean, providerDetail: string) {
    return keepProviderDetail
      ? new ProviderFailureError(USER_ERRORS.startFailed, providerDetail)
      : new Error(USER_ERRORS.startFailed);
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

      if (
        state === 'waiting' ||
        state === 'queuing' ||
        state === 'generating'
      ) {
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
        // texto amigável pro usuário, motivo técnico preservado pra classificação
        throw new ProviderFailureError(
          USER_ERRORS.generationFailed,
          fullMessage,
        );
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

  // ─── Plano B na WaveSpeed (TKT-216) ──────────────────────────

  /** Só o Unlocked (`sem-censura`), com a flag ligada e a chave da WaveSpeed. */
  private canUseWavespeedFallback(input: SeedreamImageInput): boolean {
    const tag = input.modelUsedTag ?? 'sem-censura';
    return this.wavespeedFallbackEnabled && tag === 'sem-censura';
  }

  /**
   * Roda a geração no Seedream V5.0 Pro da WaveSpeed com o mesmo prompt final e a mesma proporção. Se o plano B também
   * falhar por motivo técnico, sobe o erro ORIGINAL da KIE (é o que o processador e o usuário já conhecem). Recusa de
   * conteúdo da WaveSpeed sobe como ContentSafetyError, para a trava de menor e a classificação seguirem iguais.
   */
  private async generateViaWavespeed(
    input: SeedreamImageInput,
    finalPrompt: string,
    aspectRatio: string,
    originalError: Error,
  ): Promise<SeedreamGenerationResult> {
    const hasImages = !!input.imageUrls?.length;
    const model = hasImages ? WS_MODEL_EDIT : WS_MODEL_T2I;
    const body: Record<string, unknown> = {
      prompt: finalPrompt,
      resolution: WS_RESOLUTION[input.resolution] ?? '2k',
      aspect_ratio: aspectRatio,
      output_format: 'jpeg',
      enable_base64_output: false,
      enable_sync_mode: false,
      ...(hasImages ? { images: input.imageUrls } : {}),
    };

    try {
      const predictionId = await this.createWavespeedPrediction(model, body);
      this.logger.log(
        `[WAVESPEED_SEEDREAM] gen=${input.id} prediction=${predictionId}`,
      );
      const resultUrls = await this.pollWavespeedPrediction(predictionId);
      const outputUrls: string[] = [];
      for (let i = 0; i < resultUrls.length; i++) {
        outputUrls.push(
          await this.downloadAndUpload(resultUrls[i], input.id, i),
        );
      }
      if (!outputUrls.length) throw new Error(USER_ERRORS.noImages);
      this.logger.log(
        `[WAVESPEED_SEEDREAM] gen=${input.id} ${outputUrls.length} image(s) uploaded to S3`,
      );
      return { outputUrls, modelUsed: 'sem-censura', engine: 'pro' };
    } catch (fallbackError) {
      if (fallbackError instanceof ContentSafetyError) throw fallbackError;
      this.logger.error(
        `[WAVESPEED_SEEDREAM] gen=${input.id} plano B também falhou: ${(fallbackError as Error).message}`,
      );
      throw originalError;
    }
  }

  private async createWavespeedPrediction(
    model: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    const maxAttempts = 2;
    const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
    let lastStatus = 0;
    let lastErrorText = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.fetchWithTimeout(
        `${this.wavespeedBaseUrl}/api/v3/${model}`,
        {
          method: 'POST',
          headers: this.wavespeedHeaders(),
          body: JSON.stringify(body),
        },
        60_000,
      );
      if (response.ok) {
        const data = (await response.json()) as WavespeedCreateResponse;
        const predictionId = data.data?.id ?? data.id;
        if (!predictionId) throw new Error(USER_ERRORS.startFailed);
        return predictionId;
      }
      lastStatus = response.status;
      lastErrorText = await response.text();
      const safetyError = ContentSafetyError.fromErrorMessage(lastErrorText);
      if (safetyError) throw safetyError;
      if (attempt < maxAttempts && transientStatuses.has(response.status)) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      break;
    }

    this.logger.error(
      `[WAVESPEED_SEEDREAM] createPrediction failed status=${lastStatus} body=${lastErrorText.slice(0, 300)}`,
    );
    throw new Error(USER_ERRORS.startFailed);
  }

  private async pollWavespeedPrediction(
    predictionId: string,
    maxAttempts = 120,
    intervalMs = 3_000,
  ): Promise<string[]> {
    const url = `${this.wavespeedBaseUrl}/api/v3/predictions/${predictionId}/result`;
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0)
        await new Promise((resolve) => setTimeout(resolve, intervalMs));

      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          url,
          { headers: this.wavespeedHeaders() },
          30_000,
        );
      } catch {
        networkFailures++;
        if (networkFailures >= maxNetworkRetries)
          throw new Error(USER_ERRORS.statusCheckFailed);
        continue;
      }
      if (!response.ok) {
        networkFailures++;
        const errorText = await response.text();
        if (networkFailures >= maxNetworkRetries) {
          const safetyError = ContentSafetyError.fromErrorMessage(errorText);
          if (safetyError) throw safetyError;
          throw new Error(USER_ERRORS.statusCheckFailed);
        }
        continue;
      }

      networkFailures = 0;
      const data = ((await response.json()) as WavespeedResultResponse).data;
      if (!data) throw new Error(USER_ERRORS.statusCheckFailed);
      if (data.status === 'completed') {
        if (!data.outputs?.length) throw new Error(USER_ERRORS.noOutput);
        return data.outputs;
      }
      if (data.status === 'failed') {
        const errorText = data.error ?? 'unknown error';
        const safetyError = ContentSafetyError.fromErrorMessage(errorText);
        if (safetyError) throw safetyError;
        throw new ProviderFailureError(USER_ERRORS.generationFailed, errorText);
      }
    }

    throw new Error(USER_ERRORS.timeout);
  }

  private wavespeedHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.wavespeedApiKey}`,
    };
  }
}
