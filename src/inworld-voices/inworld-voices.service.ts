import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type InworldVoiceSource = 'SYSTEM' | 'IVC' | 'PVC';

export interface InworldVoice {
  voiceId: string;
  displayName: string;
  description?: string;
  langCode: string;
  tags?: string[];
  source?: InworldVoiceSource;
}

interface InworldListResponse {
  voices?: InworldVoice[];
}

interface InworldPreviewResponse {
  audioContent?: string;
}

const LIST_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Allowlist of voice IDs supported by WaveSpeed's Inworld 1.5 Max TTS.
 * Source: https://wavespeed.ai/docs/docs-api/inworld/inworld-inworld-1.5-max-text-to-speech
 *
 * The Inworld direct API may return more voices than WaveSpeed proxies. Since
 * we synthesize TTS via WaveSpeed (not Inworld direct), only these are usable.
 */
const WAVESPEED_INWORLD_VOICE_ALLOWLIST = new Set<string>([
  // English
  'Alex', 'Ashley', 'Craig', 'Deborah', 'Dennis', 'Edward', 'Elizabeth',
  'Hades', 'Julia', 'Pixie', 'Mark', 'Olivia', 'Priya', 'Ronald', 'Sarah',
  'Shaun', 'Theodore', 'Timothy', 'Wendy', 'Dominus', 'Hana', 'Clive',
  'Carter', 'Blake', 'Luna',
  // Chinese
  'Yichen', 'Xiaoyin', 'Xinyi', 'Jing',
  // Japanese
  'Asuka', 'Satoshi',
  // Korean
  'Hyunwoo', 'Minji', 'Seojun', 'Yoona',
  // French
  'Alain', 'Hélène', 'Mathieu', 'Étienne',
  // German
  'Johanna', 'Josef',
  // Spanish
  'Diego', 'Lupita', 'Miguel', 'Rafael',
  // Portuguese
  'Heitor', 'Maitê',
  // Italian
  'Gianni', 'Orietta',
  // Dutch
  'Erik', 'Katrien', 'Lennart', 'Lore',
  // Polish
  'Szymon', 'Wojciech',
  // Russian
  'Svetlana', 'Elena', 'Dmitry', 'Nikolai',
  // Hindi
  'Riya', 'Manoj',
  // Hebrew
  'Yael', 'Oren',
  // Arabic
  'Nour', 'Omar',
]);

@Injectable()
export class InworldVoicesService {
  private readonly logger = new Logger(InworldVoicesService.name);
  private readonly baseUrl = 'https://api.inworld.ai';
  private readonly apiKey: string;

  private listCache: { at: number; key: string; voices: InworldVoice[] } | null =
    null;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = (
      this.configService.get<string>('INWORLD_API_KEY', '') ?? ''
    ).trim();
    if (!this.apiKey) {
      this.logger.warn(
        'INWORLD_API_KEY is not set. Inworld voice listing/preview will fail.',
      );
    }
  }

  private ensureConfigured(): void {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'O catálogo de vozes não está disponível no momento. Tente novamente em alguns instantes.',
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Basic ${this.apiKey}`,
      Accept: 'application/json',
    };
  }

  async listVoices(languages?: string[]): Promise<InworldVoice[]> {
    this.ensureConfigured();

    const cacheKey = (languages ?? []).slice().sort().join(',');
    const now = Date.now();
    if (
      this.listCache &&
      this.listCache.key === cacheKey &&
      now - this.listCache.at < LIST_CACHE_TTL_MS
    ) {
      return this.listCache.voices;
    }

    const url = new URL(`${this.baseUrl}/voices/v1/voices`);
    for (const lang of languages ?? []) {
      url.searchParams.append('languages', lang);
    }

    const response = await this.fetchWithTimeout(
      url.toString(),
      { method: 'GET', headers: this.headers() },
      20_000,
    );

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(
        `Inworld listVoices failed status=${response.status} body=${body.slice(0, 300)}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível carregar as vozes. Tente novamente em alguns instantes.',
      );
    }

    const data = (await response.json()) as InworldListResponse;
    const allVoices = data.voices ?? [];
    // Filter to voices actually supported by WaveSpeed (our TTS gateway).
    // System voices not in the allowlist would fail at synthesis time.
    const voices = allVoices.filter(
      (v) =>
        v.source !== 'SYSTEM' || WAVESPEED_INWORLD_VOICE_ALLOWLIST.has(v.voiceId),
    );

    this.listCache = { at: now, key: cacheKey, voices };
    this.logger.log(
      `Inworld listVoices ok count=${voices.length}/${allVoices.length} languages=${cacheKey || 'all'}`,
    );
    return voices;
  }

  async getVoicePreview(
    voiceId: string,
    modelId = 'inworld-tts-1.5-max',
  ): Promise<Buffer> {
    this.ensureConfigured();

    const url = new URL(`${this.baseUrl}/tts/v1/voice:preview`);
    url.searchParams.set('voice_id', voiceId);
    url.searchParams.set('model_id', modelId);

    const response = await this.fetchWithTimeout(
      url.toString(),
      { method: 'GET', headers: this.headers() },
      30_000,
    );

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(
        `Inworld voicePreview failed voice=${voiceId} status=${response.status} body=${body.slice(0, 300)}`,
      );
      if (response.status === 404) {
        throw new ServiceUnavailableException(
          'Voz não encontrada no catálogo da Inworld.',
        );
      }
      throw new ServiceUnavailableException(
        'Não foi possível carregar a prévia dessa voz. Tente novamente em alguns instantes.',
      );
    }

    const data = (await response.json()) as InworldPreviewResponse;
    if (!data.audioContent) {
      throw new ServiceUnavailableException(
        'A prévia dessa voz não está disponível.',
      );
    }
    return Buffer.from(data.audioContent, 'base64');
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
}
