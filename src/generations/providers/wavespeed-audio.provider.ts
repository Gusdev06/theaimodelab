import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';
import {
  normalizeInworldMarkup,
  stripExpressiveMarkup,
} from './inworld-markup.util';

export interface WavespeedTextToSpeechInput {
  id: string;
  text: string;
  voiceId: string;
  language?: string;
  speed?: number;
}

export interface WavespeedVoiceCloneInput {
  id: string;
  text: string;
  audioUrl: string;
  language?: string;
}

interface CreatePredictionResponse {
  data?: {
    id?: string;
  };
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
export class WavespeedAudioProvider {
  private readonly logger = new Logger(WavespeedAudioProvider.name);
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
        'WAVESPEED_API_KEY is not set. Audio generation will fail with a 401 from the provider.',
      );
    }
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      throw new Error(
        'Não foi possível gerar o áudio agora. Entre em contato com o suporte.',
      );
    }
  }

  async generateTextToSpeech(
    input: WavespeedTextToSpeechInput,
  ): Promise<GenerationResult> {
    this.ensureConfigured();

    if (input.voiceId.startsWith('inworld:')) {
      return this.generateInworldTextToSpeech({
        ...input,
        voiceId: input.voiceId.slice('inworld:'.length),
      });
    }

    const model = 'wavespeed-ai/omnivoice/text-to-speech';
    // OmniVoice não suporta tags de reação/pausa — removemos para não serem
    // lidas em voz alta. (Emoções só funcionam no caminho Inworld.)
    const text = stripExpressiveMarkup(input.text);
    const body: Record<string, unknown> = {
      text,
      voice_id: input.voiceId,
    };
    if (input.language) body.language = input.language;
    if (typeof input.speed === 'number') body.speed = input.speed;

    this.logger.log(
      `[TTS] gen=${input.id} voice=${input.voiceId} language=${input.language ?? 'auto'} speed=${input.speed ?? 1} text="${input.text.slice(0, 80)}"`,
    );

    const predictionId = await this.createPrediction(model, body);
    const audioUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(audioUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: model };
  }

  private async generateInworldTextToSpeech(
    input: WavespeedTextToSpeechInput,
  ): Promise<GenerationResult> {
    const model = 'inworld/inworld-1.5-max/text-to-speech';
    // Inworld suporta markup de emoção/efeito — traduzimos tags em pt-BR/ES
    // para a sintaxe oficial e aplicamos as regras de posição.
    const text = normalizeInworldMarkup(input.text);
    const body: Record<string, unknown> = {
      text,
      voice_id: input.voiceId,
    };
    if (typeof input.speed === 'number') body.speaking_rate = input.speed;

    this.logger.log(
      `[TTS_INWORLD] gen=${input.id} voice=${input.voiceId} speaking_rate=${input.speed ?? 1} text="${input.text.slice(0, 80)}"`,
    );

    const predictionId = await this.createPrediction(model, body);
    const audioUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(audioUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: model };
  }

  async generateVoiceClone(
    input: WavespeedVoiceCloneInput,
  ): Promise<GenerationResult> {
    this.ensureConfigured();
    const model = 'wavespeed-ai/omnivoice/voice-clone';
    // OmniVoice (voice clone) não suporta tags de reação/pausa — removemos.
    const text = stripExpressiveMarkup(input.text);
    const body: Record<string, unknown> = {
      text,
      audio: input.audioUrl,
    };
    if (input.language) body.language = input.language;

    this.logger.log(
      `[VOICE_CLONE] gen=${input.id} audio=${input.audioUrl} language=${input.language ?? 'auto'} text="${input.text.slice(0, 80)}"`,
    );

    const predictionId = await this.createPrediction(model, body);
    const audioUrl = await this.pollPrediction(predictionId);
    const outputUrl = await this.downloadAndUpload(audioUrl, input.id, 0);

    return { outputUrls: [outputUrl], modelUsed: model };
  }

  private async createPrediction(
    model: string,
    body: Record<string, unknown>,
  ): Promise<string> {
    // Retry once on transient errors (401/429/5xx). WaveSpeed occasionally
    // returns 401 on rapid follow-up calls / concurrent requests / when their
    // auth cache is being refreshed — a small delay is enough to recover.
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
          throw new Error(
            'O serviço de áudio não respondeu como esperado. Tente novamente em alguns instantes.',
          );
        }
        if (attempt > 1) {
          this.logger.log(
            `WaveSpeed prediction created on retry attempt=${attempt}: ${predictionId}`,
          );
        } else {
          this.logger.log(`WaveSpeed prediction created: ${predictionId}`);
        }
        return predictionId;
      }

      lastStatus = response.status;
      lastErrorText = await response.text();

      const shouldRetry =
        attempt < maxAttempts && transientStatuses.has(response.status);

      if (shouldRetry) {
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
    throw new Error(this.friendlyHttpMessage(lastStatus, lastErrorText));
  }

  private async pollPrediction(
    predictionId: string,
    maxAttempts = 90,
    intervalMs = 2_000,
  ): Promise<string> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }

      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/api/v3/predictions/${predictionId}/result`,
        { headers: this.headers() },
        30_000,
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(
          `WaveSpeed result failed status=${response.status} predictionId=${predictionId} body=${errorText}`,
        );
        throw new Error(this.friendlyHttpMessage(response.status, errorText));
      }

      const payload = (await response.json()) as PredictionResultResponse;
      const data = payload.data;
      if (!data) {
        this.logger.error(
          `WaveSpeed result empty payload for predictionId=${predictionId}`,
        );
        throw new Error(
          'Resposta inesperada do serviço de áudio. Tente gerar de novo.',
        );
      }

      if (data.status === 'completed') {
        const audioUrl = data.outputs?.[0];
        if (!audioUrl) {
          this.logger.error(
            `WaveSpeed completed without audio URL predictionId=${predictionId}`,
          );
          throw new Error(
            'A geração foi concluída mas o áudio não pôde ser recuperado. Tente novamente.',
          );
        }
        return audioUrl;
      }

      if (data.status === 'failed') {
        const rawError = data.error ?? 'unknown error';
        this.logger.error(
          `WaveSpeed prediction failed predictionId=${predictionId} error=${rawError}`,
        );
        throw new Error(this.friendlyProviderError(rawError));
      }

      this.logger.debug(
        `WaveSpeed prediction ${predictionId} ${data.status} (attempt ${attempt + 1}/${maxAttempts})`,
      );
    }

    throw new Error(
      'A geração de áudio demorou mais que o esperado. Tente um texto mais curto ou tente de novo em alguns instantes.',
    );
  }

  /** Maps HTTP status from WaveSpeed to a user-friendly message in pt-BR. */
  private friendlyHttpMessage(status: number, body: string): string {
    if (status === 401 || status === 403) {
      const lower = body.toLowerCase();
      // Auth-related failures: don't expose the cause to the user.
      if (
        lower.includes('unauthorized') ||
        lower.includes('invalid') ||
        lower.includes('api key') ||
        lower.includes('apikey') ||
        lower.includes('token') ||
        lower.includes('credential') ||
        lower.includes('forbidden')
      ) {
        return 'Não foi possível gerar o áudio agora. Tente novamente em alguns instantes — se persistir, entre em contato com o suporte.';
      }
      // Otherwise it's most likely the Bronze-tier rate limit (WaveSpeed
      // returns 401 instead of 429 in that case) or an unreachable/unsupported
      // reference audio.
      return 'Não foi possível gerar o áudio agora. Pode ser limite de gerações simultâneas ou um áudio de referência incompatível (use mp3 ou wav). Aguarde alguns segundos e tente novamente.';
    }
    if (status === 413) {
      return 'O áudio de referência é muito grande. Use um arquivo menor (até 15MB).';
    }
    if (status === 415) {
      return 'Formato de áudio não suportado. Use mp3 ou wav.';
    }
    if (status === 429) {
      return 'Estamos com muitas gerações simultâneas no momento. Aguarde alguns segundos e tente novamente.';
    }
    if (status >= 500) {
      return 'O serviço de áudio está instável no momento. Tente novamente em alguns minutos.';
    }
    // Bad request or other 4xx — try to surface a hint if the body has it
    const lower = body.toLowerCase();
    if (lower.includes('format') || lower.includes('codec')) {
      return 'Formato de áudio não suportado. Use mp3 ou wav.';
    }
    if (lower.includes('language')) {
      return 'O idioma selecionado não está disponível para essa voz.';
    }
    return 'Não foi possível gerar o áudio agora. Tente novamente em alguns instantes.';
  }

  /** Maps WaveSpeed prediction.error strings to a user-friendly message. */
  private friendlyProviderError(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes('format') || lower.includes('codec') || lower.includes('decode')) {
      return 'O áudio de referência está em um formato que não conseguimos processar. Use mp3 ou wav.';
    }
    if (lower.includes('too short') || lower.includes('duration')) {
      return 'O áudio de referência é muito curto. Use uma amostra com pelo menos 5 segundos de fala clara.';
    }
    if (lower.includes('language')) {
      return 'O idioma selecionado não é suportado pela voz escolhida.';
    }
    if (lower.includes('content') || lower.includes('moderation') || lower.includes('safety')) {
      return 'O conteúdo foi bloqueado pela moderação. Reformule o texto e tente novamente.';
    }
    return 'A geração de áudio falhou. Tente novamente — se persistir, tente outro texto ou áudio de referência.';
  }

  private async downloadAndUpload(
    sourceUrl: string,
    generationId: string,
    index: number,
  ): Promise<string> {
    const response = await this.fetchWithTimeout(sourceUrl, {}, 120_000);
    if (!response.ok) {
      this.logger.error(
        `Failed to download audio from WaveSpeed status=${response.status} url=${sourceUrl}`,
      );
      throw new Error(
        'Falha ao baixar o áudio gerado. Tente novamente em alguns instantes.',
      );
    }
    const contentType =
      response.headers.get('content-type') ?? 'audio/mpeg';
    const ext = contentType.includes('wav')
      ? 'wav'
      : contentType.includes('ogg')
        ? 'ogg'
        : 'mp3';
    const buffer = Buffer.from(await response.arrayBuffer());
    return this.uploadsService.uploadBuffer(
      buffer,
      `generations/${generationId}`,
      `output_${index}.${ext}`,
      contentType,
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
