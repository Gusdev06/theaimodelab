import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import { UploadsService } from '../../uploads/uploads.service';
import { GenerationResult } from './theaimodelab.provider';

/**
 * Provider para a Deepdeep API (https://use.n88ed.app).
 *
 * Fluxo (image-to-image, sem prompt):
 *   1. Baixa a imagem de input do S3.
 *   2. Converte para WebP em base64 mantendo < 5MB (exigência da API).
 *   3. POST /api/deepdeep  → { task_id }.
 *   4. Poll GET /api/deepdeep/{id} até status completed | error | error_expired.
 *   5. Decodifica `output` (data URI / base64 puro / URL) e faz upload pro S3.
 *
 * Endpoints alternativos POST /api/process e GET /api/process/{id} são aliases —
 * usamos os canônicos /deepdeep.
 *
 * Rate limit da API: 15 req/min. Cada geração faz 1 createTask + N polls; o
 * intervalo de poll (5s) mantém uma única task bem abaixo do limite, mas com
 * concorrência alta no worker convém subir DEEPDEEP_POLL_INTERVAL_MS.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB — teto da API
const INPUT_MAX_DIMENSION = 2048; // downscale defensivo antes de tentar WebP

export interface DeepDeepInput {
  id: string;
  /** URLs (S3) das imagens de input. Só a primeira é usada. */
  imageUrls?: string[];
  /** Ignorado pela Deepdeep API — aceito apenas para log/consistência. */
  prompt?: string;
}

interface CreateTaskResponse {
  task_id: string;
}

type ApiTaskStatus = 'pending' | 'completed' | 'error' | 'error_expired';

interface ApiTaskResponse {
  id: string;
  status: ApiTaskStatus;
  type: string;
  input: string | null;
  output: string | null;
  error: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

@Injectable()
export class DeepDeepProvider {
  private readonly logger = new Logger(DeepDeepProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly uploadsService: UploadsService,
  ) {
    this.baseUrl = this.configService
      .get<string>('DEEPDEEP_BASE_URL', 'https://use.n88ed.app')
      .replace(/\/+$/, '');
    this.apiKey = this.configService.get<string>('DEEPDEEP_API_KEY', '');
    this.pollIntervalMs = Number(
      this.configService.get<string>('DEEPDEEP_POLL_INTERVAL_MS', '5000'),
    );
  }

  async generateImage(input: DeepDeepInput): Promise<GenerationResult> {
    const sourceUrl = input.imageUrls?.[0];
    if (!sourceUrl) {
      throw new Error('Deepdeep requer uma imagem de input (image-to-image).');
    }
    if (!this.apiKey) {
      throw new Error('DEEPDEEP_API_KEY não configurada.');
    }

    this.logger.log(
      `[DEEPDEEP] ${input.id} iniciando — input=${sourceUrl}`,
    );

    // 1 + 2. Baixa a imagem de input e converte para WebP base64 < 5MB.
    const inputBuffer = await this.downloadImage(sourceUrl);
    const imageDataUri = await this.toWebpDataUri(inputBuffer);

    // 3. Cria a task.
    const taskId = await this.createTask(imageDataUri);
    this.logger.log(`[DEEPDEEP] Task criada: ${taskId}`);

    // 4. Poll até terminar → retorna o payload de `output`.
    const output = await this.pollTaskStatus(taskId);

    // 5. Decodifica o output e sobe pro S3.
    const outputBuffer = await this.resolveOutput(output);
    const { ext, contentType } = detectImage(outputBuffer);
    const outputUrl = await this.uploadOutput(
      outputBuffer,
      input.id,
      ext,
      contentType,
    );

    this.logger.log(`[DEEPDEEP] ${input.id} concluído → ${outputUrl}`);
    return { outputUrls: [outputUrl], modelUsed: 'deepdeep' };
  }

  // ─── Passo 3: criar task ────────────────────────────────────

  private async createTask(imageDataUri: string): Promise<string> {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/deepnude`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ image: imageDataUri }),
      },
      60_000,
    );

    if (!response.ok) {
      const errorText = await response.text();
      // 401 = auth, 422 = payload inválido (ex.: imagem > 5MB ou base64 corrompido)
      throw new Error(
        `Deepdeep createTask erro (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as CreateTaskResponse;
    if (!data.task_id) {
      throw new Error('Deepdeep createTask não retornou task_id.');
    }
    return data.task_id;
  }

  // ─── Passo 4: polling ───────────────────────────────────────

  private async pollTaskStatus(
    taskId: string,
    maxAttempts = 120,
  ): Promise<string> {
    const maxNetworkRetries = 5;
    let networkFailures = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(this.pollIntervalMs);
      }

      let response: Response;
      try {
        response = await this.fetchWithTimeout(
          `${this.baseUrl}/api/deepnude/${taskId}`,
          { headers: this.headers() },
          30_000,
        );
      } catch (error) {
        // Erros de rede transientes não devem matar a geração de imediato.
        networkFailures++;
        this.logger.warn(
          `[DEEPDEEP] Poll falhou (${networkFailures}/${maxNetworkRetries}): ${(error as Error).message}`,
        );
        if (networkFailures >= maxNetworkRetries) throw error;
        continue;
      }

      if (!response.ok) {
        // 404 pode acontecer por um instante logo após criar a task; tolera.
        networkFailures++;
        const errorText = await response.text();
        this.logger.warn(
          `[DEEPDEEP] Poll HTTP ${response.status} (${networkFailures}/${maxNetworkRetries}): ${errorText}`,
        );
        if (networkFailures >= maxNetworkRetries) {
          throw new Error(
            `Deepdeep status erro (${response.status}): ${errorText}`,
          );
        }
        continue;
      }

      networkFailures = 0;
      const task = (await response.json()) as ApiTaskResponse;

      switch (task.status) {
        case 'pending':
          this.logger.debug(
            `[DEEPDEEP] Processando... (tentativa ${attempt + 1}/${maxAttempts})`,
          );
          continue;

        case 'completed':
          if (!task.output) {
            throw new Error('Deepdeep completou mas não retornou output.');
          }
          return task.output;

        case 'error':
        case 'error_expired':
          throw new Error(
            `Deepdeep falhou (${task.status}): ${task.error ?? 'erro desconhecido'}`,
          );

        default:
          throw new Error(`Deepdeep status inesperado: ${task.status}`);
      }
    }

    throw new Error('Deepdeep excedeu o tempo limite (timeout).');
  }

  // ─── Passo 5a: normalizar o output para Buffer ──────────────

  /**
   * `output` pode vir como data URI (`data:image/...;base64,...`), base64 puro,
   * ou uma URL http(s). Tratamos os três casos.
   */
  private async resolveOutput(output: string): Promise<Buffer> {
    const value = output.trim();

    if (/^https?:\/\//i.test(value)) {
      return this.downloadImage(value);
    }

    const base64 = value.startsWith('data:')
      ? value.slice(value.indexOf(',') + 1)
      : value;

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
      throw new Error('Deepdeep retornou um output vazio/inválido.');
    }
    return buffer;
  }

  // ─── Passo 5b: upload pro S3 ────────────────────────────────

  private async uploadOutput(
    buffer: Buffer,
    generationId: string,
    ext: string,
    contentType: string,
  ): Promise<string> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await sleep(2_000);
          this.logger.warn(
            `[DEEPDEEP] Retry upload (${attempt + 1}/${maxRetries}) para ${generationId}`,
          );
        }
        return await this.uploadsService.uploadBuffer(
          buffer,
          `generations/${generationId}`,
          `output_0.${ext}`,
          contentType,
        );
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw lastError!;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private async downloadImage(url: string): Promise<Buffer> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) await sleep(2_000);
        const response = await this.fetchWithTimeout(url, {}, 60_000);
        if (!response.ok) {
          throw new Error(
            `Falha ao baixar imagem (${response.status}): ${url}`,
          );
        }
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw lastError!;
  }

  /**
   * Converte qualquer imagem para WebP mantendo o resultado < 5MB.
   * Reduz qualidade progressivamente e, em último caso, as dimensões.
   */
  private async toWebpDataUri(inputBuffer: Buffer): Promise<string> {
    const base = sharp(inputBuffer, { failOn: 'none' })
      .rotate() // respeita orientação EXIF
      .resize({
        width: INPUT_MAX_DIMENSION,
        height: INPUT_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      });

    for (const quality of [90, 80, 70, 55, 40]) {
      const webp = await base.clone().webp({ quality }).toBuffer();
      if (webp.length <= MAX_IMAGE_BYTES) {
        return `data:image/webp;base64,${webp.toString('base64')}`;
      }
      this.logger.debug(
        `[DEEPDEEP] WebP q=${quality} = ${(webp.length / 1024 / 1024).toFixed(2)}MB, reduzindo...`,
      );
    }

    // Fallback final: metade da resolução na menor qualidade.
    const meta = await sharp(inputBuffer, { failOn: 'none' }).metadata();
    const halfWidth = Math.max(512, Math.floor((meta.width ?? 1024) / 2));
    const webp = await sharp(inputBuffer, { failOn: 'none' })
      .rotate()
      .resize({ width: halfWidth, withoutEnlargement: true })
      .webp({ quality: 35 })
      .toBuffer();

    if (webp.length > MAX_IMAGE_BYTES) {
      throw new Error(
        'Não foi possível comprimir a imagem de input para menos de 5MB.',
      );
    }
    return `data:image/webp;base64,${webp.toString('base64')}`;
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
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Detecta o formato a partir dos magic bytes para nomear/servir corretamente. */
function detectImage(buffer: Buffer): { ext: string; contentType: string } {
  // WebP: "RIFF"...."WEBP"
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  // PNG
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  // JPEG
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  // Default seguro.
  return { ext: 'png', contentType: 'image/png' };
}
