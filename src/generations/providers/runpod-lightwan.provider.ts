import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UploadsService } from '../../uploads/uploads.service';
import { adultSafePrompt } from '../../content-safety/adult-anchor';
import { GenerationResult } from './theaimodelab.provider';

/**
 * Vídeo 18+ (imagem → vídeo) no worker PRÓPRIO do RunPod: LightWan2.2-A14B I2V (NVFP4 + sparse attention, 4 passos,
 * Apache-2.0), RTX 5090 serverless. Substitui o LTX 2.3 Spicy da WaveSpeed (AUP proíbe explícito, TKT-265) quando a
 * flag está ligada.
 *
 * Bancada 19/11/2026: clipe de 5 s em 480p = 11,3 s com o worker quente (US$ ~0,006 a US$ 1,89/h); carga do modelo 45 s.
 * A WaveSpeed cobra US$ 0,153 e leva 30 s (p50). Por isso a rota é:
 *   - worker quente → RunPod;
 *   - worker frio → WaveSpeed (o pedido não espera a partida a frio) e um aquecimento é disparado para os próximos;
 *   - SPICY_I2V_RUNPOD_COLD=wait faz esperar o frio no RunPod (para cenas que a WaveSpeed recusaria).
 * O worker só faz 81 quadros (5 s) em 480p: outra duração ou resolução segue na WaveSpeed.
 *
 * Envs: SPICY_I2V_ENGINE=runpod (liga) · SPICY_I2V_RUNPOD_PCT (canário por pessoa, vazio = 0) ·
 * SPICY_I2V_RUNPOD_COLD=fallback|wait · RUNPOD_API_KEY · RUNPOD_LIGHTWAN_ENDPOINT_ID.
 */
export const RUNPOD_LIGHTWAN_MODEL = 'runpod/lightwan2.2-i2v-nvfp4-480p';
const RUNPOD_API = 'https://api.runpod.ai/v2';
const POLL_INTERVAL_MS = 2_500;
/** Frio inteiro (subir container + carregar ~29 GB) + geração, com folga; o cron de travadas é bem mais longo. */
const JOB_DEADLINE_MS = 6 * 60_000;
/** Um aquecimento por janela: a cada pedido frio não precisa disparar outro enquanto o worker sobe. */
const WARMUP_COOLDOWN_MS = 90_000;
const PROMPT_MAX_WITH_ANCHOR = 2500;

export type LightwanRoute = 'runpod' | 'wavespeed';

export interface LightwanRouteInput {
  /** Chave estável do canário (o usuário). */
  canaryKey: string;
  /** '480p' | '720p' | '1080p' */
  resolution: string;
  durationSeconds: number;
}

export interface LightwanImageToVideoInput {
  id: string;
  prompt: string;
  imageUrl: string;
}

interface RunpodHealth {
  workers?: { idle?: number; ready?: number; running?: number; initializing?: number };
}

interface RunpodJobStatus {
  id?: string;
  status?: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  output?: { video_base64?: string; error?: string; seconds_gen?: number } | string;
  error?: string;
}

@Injectable()
export class RunpodLightwanProvider {
  private readonly logger = new Logger(RunpodLightwanProvider.name);
  private readonly apiKey: string;
  private readonly endpointId: string;
  private readonly enabled: boolean;
  private readonly canaryPct: number;
  private readonly coldMode: 'fallback' | 'wait';
  private lastWarmupAt = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    const read = (key: string) => String(this.configService.get<string>(key, '') ?? '').trim();
    this.apiKey = read('RUNPOD_API_KEY');
    this.endpointId = read('RUNPOD_LIGHTWAN_ENDPOINT_ID');
    const pctRaw = read('SPICY_I2V_RUNPOD_PCT');
    // vazio ou inválido = 0%: o canário precisa ser dito por extenso
    this.canaryPct = /^\d{1,3}$/.test(pctRaw) ? Math.min(100, Number(pctRaw)) : 0;
    this.coldMode = read('SPICY_I2V_RUNPOD_COLD').toLowerCase() === 'wait' ? 'wait' : 'fallback';
    this.enabled =
      read('SPICY_I2V_ENGINE').toLowerCase() === 'runpod' &&
      !!this.apiKey &&
      !!this.endpointId &&
      this.canaryPct > 0;
    if (this.enabled) {
      this.logger.log(
        `[RUNPOD_LIGHTWAN] ligado: canário=${this.canaryPct}% frio=${this.coldMode} endpoint=${this.endpointId}`,
      );
    }
  }

  /** O pedido cabe no worker (5 s, 480p) e a pessoa está no canário. Não consulta a rede. */
  isEligible(input: LightwanRouteInput): boolean {
    if (!this.enabled) return false;
    if (input.resolution !== '480p') return false;
    if (Math.round(input.durationSeconds) > 5) return false;
    if (this.canaryPct >= 100) return true;
    const digest = createHash('sha256')
      .update(`spicy-i2v-runpod:${input.canaryKey}`)
      .digest();
    return digest.readUInt32BE(0) % 100 < this.canaryPct;
  }

  /**
   * Rota final. Elegível + worker quente → RunPod. Elegível + frio → WaveSpeed e aquece (modo fallback) ou RunPod
   * esperando o frio (modo wait). Erro ao ler a saúde do endpoint = WaveSpeed (nunca trava a cliente).
   */
  async route(input: LightwanRouteInput): Promise<LightwanRoute> {
    if (!this.isEligible(input)) return 'wavespeed';
    if (this.coldMode === 'wait') return 'runpod';
    const warm = await this.hasWarmWorker();
    if (warm) return 'runpod';
    this.warmup();
    return 'wavespeed';
  }

  async hasWarmWorker(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${RUNPOD_API}/${this.endpointId}/health`, { headers: this.headers() }, 5_000);
      if (!response.ok) return false;
      const health = (await response.json()) as RunpodHealth;
      const workers = health.workers ?? {};
      return (workers.idle ?? 0) + (workers.ready ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Dispara um job de aquecimento sem esperar (o worker carrega o modelo no import e fica quente pelo idleTimeout). */
  warmup(): void {
    if (!this.enabled) return;
    const now = Date.now();
    if (now - this.lastWarmupAt < WARMUP_COOLDOWN_MS) return;
    this.lastWarmupAt = now;
    this.fetchWithTimeout(
      `${RUNPOD_API}/${this.endpointId}/run`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ input: { warmup: true } }) },
      10_000,
    )
      .then((response) => {
        if (!response.ok) this.logger.warn(`[RUNPOD_LIGHTWAN] aquecimento recusado status=${response.status}`);
      })
      .catch((error: unknown) => this.logger.warn(`[RUNPOD_LIGHTWAN] aquecimento falhou: ${String(error).slice(0, 160)}`));
  }

  async generateImageToVideo(input: LightwanImageToVideoInput): Promise<GenerationResult> {
    if (!input.imageUrl) throw new Error('RunPod LightWan: imagem de entrada ausente.');
    const started = Date.now();
    const created = await this.fetchWithTimeout(
      `${RUNPOD_API}/${this.endpointId}/run`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          input: { image_url: input.imageUrl, prompt: adultSafePrompt(input.prompt, PROMPT_MAX_WITH_ANCHOR) },
          policy: { executionTimeout: JOB_DEADLINE_MS, ttl: JOB_DEADLINE_MS + 60_000 },
        }),
      },
      30_000,
    );
    if (!created.ok) {
      throw new Error(`RunPod LightWan: /run recusado (${created.status}) ${(await created.text()).slice(0, 200)}`);
    }
    const job = (await created.json()) as RunpodJobStatus;
    if (!job.id) throw new Error('RunPod LightWan: /run sem id');
    this.logger.log(`[RUNPOD_LIGHTWAN] gen=${input.id} job=${job.id}`);

    let transientFailures = 0;
    while (Date.now() - started < JOB_DEADLINE_MS) {
      await this.wait(POLL_INTERVAL_MS);
      let status: RunpodJobStatus;
      try {
        const response = await this.fetchWithTimeout(`${RUNPOD_API}/${this.endpointId}/status/${job.id}`, { headers: this.headers() }, 20_000);
        if (!response.ok) throw new Error(`status ${response.status}`);
        status = (await response.json()) as RunpodJobStatus;
        transientFailures = 0;
      } catch (error) {
        transientFailures += 1;
        if (transientFailures >= 6) throw new Error(`RunPod LightWan: consulta falhou 6x (${String(error).slice(0, 120)})`);
        continue;
      }
      if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') continue;
      if (status.status !== 'COMPLETED') {
        throw new Error(`RunPod LightWan: job ${status.status ?? 'sem status'} ${String(status.error ?? '').slice(0, 200)}`);
      }
      const output = typeof status.output === 'object' && status.output ? status.output : {};
      if (output.error || !output.video_base64) {
        throw new Error(`RunPod LightWan: ${output.error ?? 'saída sem vídeo'}`);
      }
      const buffer = Buffer.from(output.video_base64, 'base64');
      if (buffer.length < 1_000) throw new Error('RunPod LightWan: vídeo vazio');
      const url = await this.uploadsService.uploadBuffer(buffer, `generations/${input.id}`, 'output_0.mp4', 'video/mp4');
      this.logger.log(
        `[RUNPOD_LIGHTWAN] gen=${input.id} ok em ${Math.round((Date.now() - started) / 1000)} s (geração ${output.seconds_gen ?? '?'} s)`,
      );
      return { outputUrls: [url], modelUsed: RUNPOD_LIGHTWAN_MODEL };
    }
    this.cancel(job.id);
    throw new Error('RunPod LightWan: tempo esgotado');
  }

  private cancel(jobId: string): void {
    this.fetchWithTimeout(`${RUNPOD_API}/${this.endpointId}/cancel/${jobId}`, { method: 'POST', headers: this.headers() }, 10_000).catch(
      () => undefined,
    );
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
