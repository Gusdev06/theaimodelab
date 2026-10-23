import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectsCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'crypto';
import * as sharp from 'sharp';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
import { PresignedUrlDto } from './dto/presigned-url.dto';
import { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';
import {
  IMAGE_SAFETY_CONFIG,
  SAFETY_TIMING,
  type ImageSafetyConfig,
} from '../content-safety/image-safety/image-safety.config';
import type { StorageArea } from '../content-safety/image-safety/types';

/** Teto do prazo de uma leitura do storage pela checagem (arquivo de tamanho sem limite, como a promoção). */
const STORAGE_READ_MAX_TIMEOUT_MS = 10 * 60_000;

/** Quantas chaves recusadas entram na mensagem do erro (a lista completa fica em `failedKeys`). */
const STRICT_DELETE_KEYS_IN_MESSAGE = 5;

/** Cache da mídia pública: curto e sem `immutable`, para que apagar + purgar tire o arquivo do ar (MEDIA_CACHE_MAX_AGE). */
export const DEFAULT_MEDIA_CACHE_MAX_AGE_SECONDS = 86_400;
const MAX_MEDIA_CACHE_MAX_AGE_SECONDS = 31_536_000;

/** Pasta das mídias que a cliente envia para uma geração (`inputs/<id da geração>/<uuid>/<arquivo>`). */
export const GENERATION_INPUT_ROOT = 'inputs';
/** Entrada no bucket privado: nunca vai para cache nenhum. */
export const PRIVATE_INPUT_CACHE_CONTROL = 'private, no-store';
/**
 * Validade da URL assinada que o provedor recebe (SAFETY_INPUT_URL_TTL). O processor reassina a cada tentativa
 * (refreshInputReadUrl), então ela cobre UMA tentativa: até 45 min de vídeo com consultas mais a busca assíncrona do
 * kie/WaveSpeed. Por isso o piso é 1 h e o padrão 2 h. O teto é o máximo da assinatura SigV4 (7 dias).
 */
export const DEFAULT_INPUT_URL_TTL_SECONDS = 7_200;
const MIN_INPUT_URL_TTL_SECONDS = 3_600;
const MAX_INPUT_URL_TTL_SECONDS = 604_800;

const GENERATION_ID_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Pasta dos resultados que os provedores gravam (`generations/<id da geração>`): é ela que vai para a quarentena. */
export const GENERATION_OUTPUT_ROOT = 'generations';
/** Pasta da evidência quando não há S3_EVIDENCE_BUCKET (dentro do bucket privado de entradas, nunca no público). */
export const EVIDENCE_ROOT = 'evidence';
/**
 * Validade da URL assinada que o provedor devolve ao gravar na quarentena: só o caminho até a checagem a usa (a
 * checagem lê pela chave), então é curta.
 */
export const QUARANTINE_UPLOAD_URL_TTL_SECONDS = 1_800;

/** Por que a leitura de um objeto do storage não deu certo (o porteiro decide se espera ou encerra). */
export type StorageReadFailure =
  | 'not_configured'
  | 'not_found'
  | 'too_large'
  | 'failed';

export class StorageReadError extends Error {
  constructor(
    readonly reason: StorageReadFailure,
    readonly area: StorageArea,
  ) {
    super(`Leitura no storage (${area}) falhou: ${reason}`);
    this.name = 'StorageReadError';
  }
}

/** Onde está um objeto gravado: área (bucket) e chave. Nunca leva a URL assinada. */
export interface StoredMediaLocation {
  area: StorageArea;
  key: string;
}

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

/** Tipo pelo final da chave (reserva: a quarentena devolve o tipo gravado). */
export function contentTypeOfKey(key: string): string {
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** Chave segura: não vazia, sem barra no começo e sem segmento `..`. */
function isSafeStorageKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    !key.startsWith('/') &&
    !key.split('/').includes('..')
  );
}

/** Pasta `generations/<id>` (ou mais funda) que os provedores usam para o resultado. */
export function isGenerationOutputFolder(folder: string): boolean {
  return (
    folder === GENERATION_OUTPUT_ROOT ||
    folder.startsWith(`${GENERATION_OUTPUT_ROOT}/`)
  );
}

/** Chave nova e imprevisível na promoção: troca o segmento do uuid (`generations/<id>/<uuid>/<arquivo>`). */
function promotedKeyOf(key: string): string {
  const parts = key.split('/');
  const filename = parts.pop() || 'output';
  if (parts.length >= 3) parts[parts.length - 1] = randomUUID();
  else parts.push(randomUUID());
  return [...parts, filename].join('/');
}

/** Mídia de entrada gravada: `url` é o que vai para o banco, a fila e o provedor. */
export interface StoredGenerationInput {
  url: string;
  key: string;
  /** true = bucket privado (S3_INPUT_PRIVATE_BUCKET) e `url` assinada com validade curta */
  isPrivate: boolean;
}

/** Inteiro do env dentro da faixa; ausente usa o padrão, inválido usa o padrão e avisa. */
function readBoundedInteger(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): { value: number; invalid: boolean } {
  if (raw === undefined || raw === null || raw === '') {
    return { value: fallback, invalid: false };
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { value: fallback, invalid: true };
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return { value: fallback, invalid: true };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { value: fallback, invalid: true };
  }
  return { value, invalid: false };
}

/**
 * Falha do deleteByPrefixStrict: a pasta NÃO está confirmada como apagada. `deleted` diz quantos objetos o bucket
 * confirmou antes da falha; `failedKeys`, quais ele recusou (Errors[] do DeleteObjects).
 */
export class StorageDeleteError extends Error {
  constructor(
    message: string,
    readonly prefix: string,
    readonly deleted: number,
    readonly failedKeys: string[],
  ) {
    super(message);
    this.name = 'StorageDeleteError';
  }
}

function describeStorageFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly s3Client: S3Client | null;
  private readonly bucketName: string;
  private readonly publicUrlBase: string;
  /** Cache-Control de toda mídia gravada no bucket público */
  private readonly publicCacheControl: string;
  /** Bucket privado das entradas (mesmo endpoint S3); null = entradas seguem no bucket público */
  private readonly inputPrivateBucket: string | null;
  private readonly inputUrlTtlSeconds: number;
  /**
   * Bucket privado da quarentena dos resultados (S3_QUARANTINE_BUCKET). Leitura, promoção, descarte e evidência valem
   * sempre que ele existe, inclusive com o modo off (o que ficou segurado antes do desligamento ainda sai de lá); a
   * GRAVAÇÃO de resultado novo nele só acontece com o modo ligado (quarantineWrites).
   */
  private readonly quarantineBucket: string | null;
  /** Resultados novos nascem na quarentena: IMAGE_SAFETY_MODE diferente de off E S3_QUARANTINE_BUCKET (senão, Onda 0). */
  private readonly quarantineWrites: boolean;
  /** Bucket da evidência (S3_EVIDENCE_BUCKET); null = pasta `evidence/` do bucket privado de entradas */
  private readonly evidenceBucket: string | null;

  constructor(
    private readonly configService: ConfigService,
    /** configuração da segurança de imagem (módulo global); ausente = quarentena desligada */
    @Optional()
    @Inject(IMAGE_SAFETY_CONFIG)
    imageSafety: ImageSafetyConfig | null = null,
  ) {
    this.quarantineBucket = imageSafety?.quarantineBucket ?? null;
    this.quarantineWrites =
      this.quarantineBucket !== null &&
      !!imageSafety &&
      imageSafety.imageMode !== 'off';
    this.evidenceBucket = imageSafety?.evidenceBucket ?? null;
    const endpoint = this.configService.get<string>('S3_ENDPOINT');
    this.bucketName = this.configService.get<string>(
      'S3_BUCKET_NAME',
      'ai-generations',
    );
    this.publicUrlBase = (
      this.configService.get<string>('S3_PUBLIC_URL', '') || ''
    ).replace(/\/$/, '');

    const cacheMaxAge = readBoundedInteger(
      this.configService.get<string>('MEDIA_CACHE_MAX_AGE'),
      DEFAULT_MEDIA_CACHE_MAX_AGE_SECONDS,
      0,
      MAX_MEDIA_CACHE_MAX_AGE_SECONDS,
    );
    if (cacheMaxAge.invalid) {
      this.logger.warn(
        `MEDIA_CACHE_MAX_AGE inválido (inteiro de 0 a ${MAX_MEDIA_CACHE_MAX_AGE_SECONDS}); usando ${DEFAULT_MEDIA_CACHE_MAX_AGE_SECONDS}`,
      );
    }
    this.publicCacheControl = `public, max-age=${cacheMaxAge.value}`;

    const inputUrlTtl = readBoundedInteger(
      this.configService.get<string>('SAFETY_INPUT_URL_TTL'),
      DEFAULT_INPUT_URL_TTL_SECONDS,
      MIN_INPUT_URL_TTL_SECONDS,
      MAX_INPUT_URL_TTL_SECONDS,
    );
    if (inputUrlTtl.invalid) {
      this.logger.warn(
        `SAFETY_INPUT_URL_TTL inválido (inteiro de ${MIN_INPUT_URL_TTL_SECONDS} a ${MAX_INPUT_URL_TTL_SECONDS}); usando ${DEFAULT_INPUT_URL_TTL_SECONDS}`,
      );
    }
    this.inputUrlTtlSeconds = inputUrlTtl.value;

    const privateBucket = (
      this.configService.get<string>('S3_INPUT_PRIVATE_BUCKET') ?? ''
    ).trim();
    if (privateBucket && privateBucket === this.bucketName) {
      // o mesmo bucket continuaria servindo a entrada pela URL pública: não conta como privado
      this.logger.warn(
        'S3_INPUT_PRIVATE_BUCKET é o próprio bucket público (S3_BUCKET_NAME): ignorado, entradas seguem públicas',
      );
      this.inputPrivateBucket = null;
    } else {
      this.inputPrivateBucket = privateBucket || null;
    }
    if (endpoint && !this.inputPrivateBucket) {
      this.logger.warn(
        `S3_INPUT_PRIVATE_BUCKET não configurado: as mídias de entrada seguem no bucket público (${GENERATION_INPUT_ROOT}/)`,
      );
    }

    if (endpoint) {
      this.s3Client = new S3Client({
        endpoint,
        region: this.configService.get<string>('S3_REGION', 'us-east-1'),
        credentials: {
          accessKeyId: this.configService.get<string>('S3_ACCESS_KEY', ''),
          secretAccessKey: this.configService.get<string>(
            'S3_SECRET_KEY',
            '',
          ),
        },
        forcePathStyle: true,
      });
      this.logger.log('S3 client configured');
    } else {
      this.s3Client = null;
      this.logger.warn('S3_ENDPOINT not configured — using mock URLs');
    }
  }

  /**
   * Returns a permanent public URL for an S3 object.
   * Requires S3_PUBLIC_URL to be configured.
   */
  getPublicUrl(fileKey: string): string {
    if (!this.publicUrlBase) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }
    return `${this.publicUrlBase}/${fileKey}`;
  }

  async generatePresignedUrl(
    dto: PresignedUrlDto,
  ): Promise<PresignedUrlResponseDto> {
    const sanitizedFilename = dto.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileKey = `${dto.purpose}/${randomUUID()}/${sanitizedFilename}`;

    if (!this.s3Client) {
      return {
        uploadUrl: `https://mock-s3.local/${this.bucketName}/${fileKey}?X-Amz-Expires=900`,
        fileKey,
      };
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileKey,
      ContentType: dto.contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 900, // 15 minutes
    });

    return { uploadUrl, fileKey };
  }

  /**
   * Downloads a file from a URL and uploads it to S3.
   * Returns a public URL to access the file.
   */
  async uploadFromUrl(
    sourceUrl: string,
    folder: string,
    filename: string,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      this.logger.warn('S3 not configured — returning source URL as-is');
      return sourceUrl;
    }

    // Download
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download file from ${sourceUrl}: ${response.status}`,
      );
    }

    let buffer: Buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'image/png';

    // For MP4 videos, move moov atom to the beginning for streaming playback
    if (contentType === 'video/mp4') {
      buffer = await this.applyFaststart(buffer);
    }

    // Upload to S3
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
        CacheControl: this.publicCacheControl,
      }),
    );

    this.logger.log(`Uploaded ${fileKey} (${buffer.length} bytes)`);

    // Return signed URL for reading
    return this.getPublicUrl(fileKey);
  }

  /**
   * Uploads raw buffer to S3 and returns a public URL.
   */
  async uploadBuffer(
    buffer: Buffer,
    folder: string,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    // resultado de geração com a checagem ligada: nasce na quarentena (privado) e só vira público por
    // promoteFromQuarantine, depois da checagem. Ponto único para os provedores, sem mexer em nenhum deles
    if (
      this.quarantineWrites &&
      this.quarantineBucket &&
      isGenerationOutputFolder(folder)
    ) {
      return this.uploadToQuarantine(
        this.quarantineBucket,
        fileKey,
        buffer,
        contentType,
      );
    }

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    // For MP4 videos, move moov atom to the beginning for streaming playback
    let finalBuffer = buffer;
    if (contentType === 'video/mp4') {
      finalBuffer = await this.applyFaststart(buffer);
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: finalBuffer,
        ContentType: contentType,
        ContentLength: finalBuffer.length,
        CacheControl: this.publicCacheControl,
      }),
    );

    this.logger.log(`Uploaded ${fileKey} (${finalBuffer.length} bytes)`);
    return this.getPublicUrl(fileKey);
  }

  /**
   * Re-muxes an MP4 buffer with -movflags +faststart so the moov atom
   * is at the beginning of the file, enabling streaming playback.
   */
  /**
   * Transcodes any input audio buffer to MP3 (mono, 96kbps, 24kHz).
   * Used to normalize browser-recorded webm/ogg/m4a samples before sending
   * to providers that only accept mp3/wav (e.g. WaveSpeed OmniVoice).
   */
  async transcodeAudioToMp3(buffer: Buffer): Promise<Buffer> {
    const tempDir = path.join('/tmp', `audio-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const inputPath = path.join(tempDir, 'input');
    const outputPath = path.join(tempDir, 'output.mp3');

    try {
      fs.writeFileSync(inputPath, buffer);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .audioCodec('libmp3lame')
          .audioChannels(1)
          .audioBitrate('96k')
          .audioFrequency(24000)
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      const result = fs.readFileSync(outputPath);
      this.logger.log(
        `Audio transcoded to mp3: ${buffer.length} → ${result.length} bytes`,
      );
      return result;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private async applyFaststart(buffer: Buffer): Promise<Buffer> {
    const tempDir = path.join('/tmp', `faststart-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputPath = path.join(tempDir, 'output.mp4');

    try {
      fs.writeFileSync(inputPath, buffer);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions('-c', 'copy', '-movflags', '+faststart')
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      const result = fs.readFileSync(outputPath);
      this.logger.log(
        `Faststart applied: ${buffer.length} → ${result.length} bytes`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `Failed to apply faststart, uploading original: ${(error as Error).message}`,
      );
      return buffer;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Generates a thumbnail from an image URL, uploads it to S3 and returns its public URL.
   */
  async generateThumbnail(
    sourceUrl: string,
    folder: string,
    filename: string,
    width = 256,
    height?: number,
    preserveAspect = false,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      // preserveAspect: encaixa dentro da caixa width×height mantendo a proporção
      // original (sem recorte) — usado na galeria para respeitar 9:16, 16:9 etc.
      const thumbnail = await sharp(buffer)
        .resize(width, height ?? width, {
          fit: preserveAspect ? 'inside' : 'cover',
          withoutEnlargement: preserveAspect,
        })
        .webp({ quality: 70 })
        .toBuffer();

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: fileKey,
          Body: thumbnail,
          ContentType: 'image/webp',
        }),
      );

      this.logger.log(`Thumbnail uploaded ${fileKey} (${thumbnail.length} bytes)`);
      return this.getPublicUrl(fileKey);
    } catch (error) {
      this.logger.warn(`Failed to generate thumbnail: ${(error as Error).message}`);
      return sourceUrl;
    }
  }

  /**
   * Same as generateThumbnail but throws on failure instead of returning sourceUrl.
   */
  async generateThumbnailDirect(
    sourceUrl: string,
    folder: string,
    filename: string,
    width = 256,
    height?: number,
    preserveAspect = false,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const thumbnail = await sharp(buffer)
      .resize(width, height ?? width, {
        fit: preserveAspect ? 'inside' : 'cover',
        withoutEnlargement: preserveAspect,
      })
      .webp({ quality: 70 })
      .toBuffer();

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: thumbnail,
        ContentType: 'image/webp',
      }),
    );

    this.logger.log(`Thumbnail uploaded ${fileKey} (${thumbnail.length} bytes)`);
    return this.getPublicUrl(fileKey);
  }

  /**
   * Generates a thumbnail from a video URL by extracting the first frame with ffmpeg.
   * Downloads video → extracts frame at 0s → resizes with sharp → uploads to S3.
   */
  async generateVideoThumbnail(
    videoUrl: string,
    folder: string,
    filename: string,
    size = 256,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    const tempDir = path.join('/tmp', `vidthumb-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const videoPath = path.join(tempDir, 'input.mp4');
    const framePath = path.join(tempDir, 'frame.jpg');

    try {
      // Download video to temp file first (more reliable than streaming from URL)
      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }
      const videoBuffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(videoPath, videoBuffer);

      // Extract first frame from local file
      await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(0)
          .frames(1)
          .output(framePath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      // Resize with sharp and upload
      const frameBuffer = fs.readFileSync(framePath);
      const thumbnail = await sharp(frameBuffer)
        .resize(size, size, { fit: 'cover' })
        .webp({ quality: 70 })
        .toBuffer();

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: fileKey,
          Body: thumbnail,
          ContentType: 'image/webp',
        }),
      );

      this.logger.log(`Video thumbnail uploaded ${fileKey} (${thumbnail.length} bytes)`);
      return this.getPublicUrl(fileKey);
    } catch (error) {
      this.logger.warn(`Failed to generate video thumbnail: ${(error as Error).message}`);
      throw error;
    } finally {
      // Cleanup temp files
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  /**
   * Uploads raw buffer to S3 and returns both a public URL (for external APIs)
   * and a signed URL (for internal use / display).
   * With public bucket, both URLs are the same permanent public URL.
   */
  async uploadBufferPublic(
    buffer: Buffer,
    folder: string,
    filename: string,
    contentType: string,
  ): Promise<{ publicUrl: string; signedUrl: string }> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      const mockUrl = `https://mock-s3.local/${this.bucketName}/${fileKey}`;
      return { publicUrl: mockUrl, signedUrl: mockUrl };
    }

    // For MP4 videos, move moov atom to the beginning for streaming playback
    let finalBuffer = buffer;
    if (contentType === 'video/mp4') {
      finalBuffer = await this.applyFaststart(buffer);
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: finalBuffer,
        ContentType: contentType,
        ContentLength: finalBuffer.length,
        CacheControl: this.publicCacheControl,
      }),
    );

    this.logger.log(`Uploaded (public) ${fileKey} (${finalBuffer.length} bytes)`);

    const publicUrl = this.getPublicUrl(fileKey);
    return { publicUrl, signedUrl: publicUrl };
  }

  /* ─── Quarentena e evidência (segurança de imagem, camada 5) ─────────────────────────────────────────────── */

  /** Os resultados de geração nascem na quarentena (modo diferente de off e S3_QUARANTINE_BUCKET)? */
  get quarantineEnabled(): boolean {
    return this.quarantineWrites;
  }

  /** Existe bucket de quarentena (para ler, promover, descartar ou mover o que já está nele, em qualquer modo)? */
  get quarantineConfigured(): boolean {
    return this.quarantineBucket !== null;
  }

  private async uploadToQuarantine(
    bucket: string,
    fileKey: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<string> {
    if (!this.s3Client) {
      return `https://mock-s3.local/${bucket}/${fileKey}?X-Amz-Expires=${QUARANTINE_UPLOAD_URL_TTL_SECONDS}`;
    }
    const size = await this.putObject(
      bucket,
      fileKey,
      buffer,
      contentType,
      PRIVATE_INPUT_CACHE_CONTROL,
    );
    this.logger.log(`Uploaded (quarantine) ${fileKey} (${size} bytes)`);
    return this.signedReadUrl(
      bucket,
      fileKey,
      QUARANTINE_UPLOAD_URL_TTL_SECONDS,
    );
  }

  private async signedReadUrl(
    bucket: string,
    fileKey: string,
    expiresInSeconds: number,
  ): Promise<string> {
    const ttl = Math.min(
      Math.max(Math.floor(expiresInSeconds), 1),
      MAX_INPUT_URL_TTL_SECONDS,
    );
    if (!this.s3Client) {
      return `https://mock-s3.local/${bucket}/${fileKey}?X-Amz-Expires=${ttl}`;
    }
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: bucket, Key: fileKey }),
      { expiresIn: ttl },
    );
  }

  /** Bucket de cada área; null quando a área não está configurada. */
  private bucketOf(area: StorageArea): string | null {
    switch (area) {
      case 'public':
        return this.bucketName;
      case 'input-private':
        return this.inputPrivateBucket;
      case 'quarantine':
        return this.quarantineBucket;
      case 'evidence':
        return this.evidenceBucket ?? this.inputPrivateBucket;
    }
  }

  /**
   * Área e chave de uma mídia gravada a partir da URL (pública, assinada ou simulada). A URL assinada vence; a chave
   * não. null = URL que não é do nosso storage (o porteiro nunca baixa mídia de fora).
   */
  locateStoredMedia(
    url: string | null | undefined,
  ): StoredMediaLocation | null {
    if (!url) return null;
    const clean = url.split(/[?#]/)[0];
    let area: StorageArea | null = null;
    let rawKey: string | null = null;
    if (this.publicUrlBase && clean.startsWith(`${this.publicUrlBase}/`)) {
      area = 'public';
      rawKey = clean.slice(this.publicUrlBase.length + 1);
    } else {
      let pathname: string;
      try {
        pathname = new URL(clean).pathname;
      } catch {
        return null;
      }
      const candidates: Array<[StorageArea, string | null]> = [
        ['quarantine', this.quarantineBucket],
        ['evidence', this.evidenceBucket],
        ['input-private', this.inputPrivateBucket],
        ['public', this.bucketName],
      ];
      for (const [candidate, bucket] of candidates) {
        if (!bucket) continue;
        const marker = `/${bucket}/`;
        const at = pathname.indexOf(marker);
        if (at !== -1) {
          area = candidate;
          rawKey = pathname.slice(at + marker.length);
          break;
        }
      }
    }
    if (!area || !rawKey) return null;
    let key: string;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      return null;
    }
    if (!isSafeStorageKey(key)) return null;
    // a evidência sem bucket próprio mora em `evidence/` do bucket privado de entradas
    if (area === 'input-private' && key.startsWith(`${EVIDENCE_ROOT}/`)) {
      area = 'evidence';
    }
    return { area, key };
  }

  /** Lê um objeto gravado (até `maxBytes`). Lança StorageReadError; nunca devolve parte do arquivo. */
  async readObject(
    area: StorageArea,
    key: string,
    maxBytes: number,
  ): Promise<Buffer> {
    return (await this.readStoredObject(area, key, maxBytes)).body;
  }

  /**
   * Igual a readObject, com o tipo gravado no storage. Sempre com prazo (SAFETY_TIMING.storageReadTimeoutMs, ou
   * `options.timeoutMs`) e, quando vier, o sinal de quem chama: socket preso no storage não trava o job nem o cron.
   */
  async readStoredObject(
    area: StorageArea,
    key: string,
    maxBytes: number,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ body: Buffer; contentType: string | null }> {
    const bucket = this.bucketOf(area);
    if (!this.s3Client || !bucket) {
      throw new StorageReadError('not_configured', area);
    }
    if (!isSafeStorageKey(key)) throw new StorageReadError('not_found', area);
    // prazo padrão cresce com o tamanho permitido (piso de ~1 MB/s, teto de 10 min): vídeo grande não é cortado
    const deadline = AbortSignal.timeout(
      options.timeoutMs ??
        Math.min(
          Math.max(
            SAFETY_TIMING.storageReadTimeoutMs,
            Math.ceil(maxBytes / 1_048_576) * 1_000,
          ),
          STORAGE_READ_MAX_TIMEOUT_MS,
        ),
    );
    const abortSignal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;
    let output: {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
      ContentLength?: number;
      ContentType?: string;
    };
    try {
      output = await this.s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal },
      );
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      const name = (error as { name?: string }).name;
      if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') {
        throw new StorageReadError('not_found', area);
      }
      this.logger.warn(
        `Leitura de ${key} (${area}) falhou: ${describeStorageFailure(error)}`,
      );
      throw new StorageReadError('failed', area);
    }
    if (
      typeof output.ContentLength === 'number' &&
      output.ContentLength > maxBytes
    ) {
      throw new StorageReadError('too_large', area);
    }
    if (!output.Body) throw new StorageReadError('not_found', area);
    let bytes: Uint8Array;
    try {
      bytes = await output.Body.transformToByteArray();
    } catch (error) {
      this.logger.warn(
        `Leitura de ${key} (${area}) interrompida: ${describeStorageFailure(error)}`,
      );
      throw new StorageReadError('failed', area);
    }
    if (bytes.length > maxBytes) throw new StorageReadError('too_large', area);
    return {
      body: Buffer.from(bytes),
      contentType: output.ContentType ?? null,
    };
  }

  /**
   * ÚNICO caminho de um resultado da quarentena para o público: grava no bucket público com o cache curto e uma chave
   * nova imprevisível e só então apaga a cópia da quarentena (falha ao apagar vira log: a quarentena é privada).
   * `body` evita baixar de novo o que a checagem já leu. Para várias saídas, use copyQuarantineToPublic em todas e
   * deleteQuarantineObject só depois (nada sai da quarentena pela metade).
   */
  async promoteFromQuarantine(
    key: string,
    options: { body?: Buffer; contentType?: string | null } = {},
  ): Promise<{ url: string; key: string }> {
    const promoted = await this.copyQuarantineToPublic(key, options);
    await this.deleteQuarantineObject(key);
    return promoted;
  }

  /**
   * 1ª fase da promoção: grava a cópia pública (cache curto, chave nova imprevisível) SEM apagar a quarentena.
   * Lança se a cópia falhar.
   */
  async copyQuarantineToPublic(
    key: string,
    options: { body?: Buffer; contentType?: string | null } = {},
  ): Promise<{ url: string; key: string }> {
    const bucket = this.quarantineBucket;
    if (!bucket) throw new StorageReadError('not_configured', 'quarantine');
    if (!isSafeStorageKey(key)) {
      throw new StorageReadError('not_found', 'quarantine');
    }
    const publicKey = promotedKeyOf(key);
    if (!this.s3Client) {
      return { url: this.getPublicUrl(publicKey), key: publicKey };
    }
    let body = options.body;
    let contentType = options.contentType ?? null;
    if (!body) {
      const stored = await this.readStoredObject(
        'quarantine',
        key,
        Number.MAX_SAFE_INTEGER,
      );
      body = stored.body;
      contentType = contentType ?? stored.contentType;
    }
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: publicKey,
        Body: body,
        ContentType: contentType ?? contentTypeOfKey(key),
        ContentLength: body.length,
        CacheControl: this.publicCacheControl,
      }),
    );
    this.logger.log(`Promoted ${key} → ${publicKey} (${body.length} bytes)`);
    return { url: this.getPublicUrl(publicKey), key: publicKey };
  }

  /** 2ª fase da promoção: apaga a cópia da quarentena (falha vira log: a quarentena é privada). */
  async deleteQuarantineObject(key: string): Promise<void> {
    if (!this.quarantineBucket || !isSafeStorageKey(key)) return;
    await this.deleteObjectQuietly(this.quarantineBucket, key);
  }

  /**
   * Apaga uma pasta SÓ no bucket de quarentena (resultado de geração que terminou sem publicar: sobra de upload
   * parcial, encerramento por falha). Nunca toca no público. Sem quarentena configurada, não faz nada.
   */
  async deleteQuarantinePrefix(prefix: string): Promise<number> {
    if (!this.s3Client || !this.quarantineBucket) return 0;
    if (
      !prefix.startsWith(`${GENERATION_OUTPUT_ROOT}/`) ||
      !prefix.endsWith('/') ||
      prefix.split('/').includes('..')
    ) {
      throw new Error(`Pasta fora da quarentena de resultados: "${prefix}"`);
    }
    return this.deleteByPrefixIn(this.s3Client, this.quarantineBucket, prefix);
  }

  /**
   * Guarda a mídia como evidência (sinal forte ou médio): bucket S3_EVIDENCE_BUCKET ou, sem ele, `evidence/` do bucket
   * privado de entradas; NUNCA o público. Apaga a origem só depois da cópia gravada e devolve a chave da evidência
   * (content_safety_scans.evidence_key). Sem bucket privado nenhum, lança e a mídia fica onde está.
   */
  async moveToEvidence(
    area: StorageArea,
    key: string,
    sha256: string | null,
    options: { body?: Buffer; contentType?: string | null } = {},
  ): Promise<string> {
    if (area === 'evidence') return key;
    if (!(this.evidenceBucket ?? this.inputPrivateBucket)) {
      throw new StorageReadError('not_configured', 'evidence');
    }
    let body = options.body;
    let contentType = options.contentType ?? null;
    if (!body) {
      const stored = await this.readStoredObject(
        area,
        key,
        Number.MAX_SAFE_INTEGER,
      );
      body = stored.body;
      contentType = contentType ?? stored.contentType;
    }
    const evidenceKey = await this.storeEvidence(
      body,
      contentType ?? contentTypeOfKey(key),
      sha256,
      key.split('/').pop() || 'media',
    );
    const source = this.bucketOf(area);
    if (source) await this.deleteObjectQuietly(source, key);
    return evidenceKey;
  }

  /**
   * Grava bytes em memória como evidência (rotas sem fila, foto recebida em base64). Devolve a chave. O sha256 é
   * SEMPRE o dos bytes gravados (vai na chave e nos metadados do objeto, para provar a integridade depois); o esperado
   * que vier de fora só é conferido: divergente vira log de erro e a evidência é guardada mesmo assim.
   */
  async storeEvidence(
    body: Buffer,
    contentType: string,
    sha256: string | null,
    filename: string,
  ): Promise<string> {
    const bucket = this.evidenceBucket ?? this.inputPrivateBucket;
    if (!bucket) throw new StorageReadError('not_configured', 'evidence');
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'media';
    const digest = createHash('sha256').update(body).digest('hex');
    if (sha256 && sha256 !== digest) {
      this.logger.error(
        `Evidência com sha256 diferente do esperado (${sha256.slice(0, 12)} × ${digest.slice(0, 12)}): guardada com o hash dos bytes`,
      );
    }
    const evidenceKey = `${EVIDENCE_ROOT}/${digest}/${randomUUID()}/${safeName}`;
    if (!this.s3Client) return evidenceKey;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: evidenceKey,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        CacheControl: PRIVATE_INPUT_CACHE_CONTROL,
        Metadata: { sha256: digest },
      }),
    );
    this.logger.log(`Stored evidence ${evidenceKey} (${body.length} bytes)`);
    return evidenceKey;
  }

  /** Apaga um objeto gravado (caso leve: só o veredito fica). Lança se o storage recusar. */
  async deleteStoredObject(area: StorageArea, key: string): Promise<void> {
    const bucket = this.bucketOf(area);
    if (!this.s3Client || !bucket || !isSafeStorageKey(key)) return;
    await this.s3Client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    );
  }

  /** URL assinada curta de um resultado na quarentena (revisor; padrão 120 s). */
  async signedQuarantineUrl(
    key: string,
    expiresInSeconds: number = SAFETY_TIMING.reviewMediaUrlTtlSeconds,
  ): Promise<string> {
    const bucket = this.quarantineBucket;
    if (!bucket) throw new StorageReadError('not_configured', 'quarantine');
    if (!isSafeStorageKey(key)) {
      throw new StorageReadError('not_found', 'quarantine');
    }
    return this.signedReadUrl(bucket, key, expiresInSeconds);
  }

  /**
   * URL assinada curta de uma mídia em qualquer área (quarentena, evidência, entrada privada ou público) para o revisor
   * de segurança (padrão 120 s): a aba de revisão nunca usa a URL pública. Área sem bucket configurado lança.
   */
  async signedReviewMediaUrl(
    area: StorageArea,
    key: string,
    expiresInSeconds: number = SAFETY_TIMING.reviewMediaUrlTtlSeconds,
  ): Promise<string> {
    const bucket = this.bucketOf(area);
    if (!bucket) throw new StorageReadError('not_configured', area);
    if (!isSafeStorageKey(key)) throw new StorageReadError('not_found', area);
    return this.signedReadUrl(bucket, key, expiresInSeconds);
  }

  private async deleteObjectQuietly(
    bucket: string,
    key: string,
  ): Promise<void> {
    if (!this.s3Client) return;
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
      );
    } catch (error) {
      this.logger.warn(
        `Cópia de origem ${key} não apagada: ${describeStorageFailure(error)}`,
      );
    }
  }

  /** As entradas das gerações vão para o bucket privado (S3_INPUT_PRIVATE_BUCKET)? */
  get privateInputsEnabled(): boolean {
    return this.inputPrivateBucket !== null;
  }

  /** Validade, em segundos, da URL assinada de leitura das entradas privadas (SAFETY_INPUT_URL_TTL). */
  get inputUrlTtl(): number {
    return this.inputUrlTtlSeconds;
  }

  /**
   * Grava uma mídia enviada pela cliente para a geração em `inputs/<id da geração>/<uuid>/<arquivo>`.
   * Com S3_INPUT_PRIVATE_BUCKET: bucket privado, `private, no-store`, e a URL devolvida é assinada com a validade de
   * SAFETY_INPUT_URL_TTL (é ela que vai para o banco, a fila e o provedor). Sem a env: bucket público, como antes.
   */
  async uploadGenerationInput(
    buffer: Buffer,
    generationId: string,
    filename: string,
    contentType: string,
  ): Promise<StoredGenerationInput> {
    if (!GENERATION_ID_SEGMENT.test(generationId)) {
      throw new Error(
        `Id de geração inválido para a pasta de entrada: "${generationId}"`,
      );
    }
    if (!filename || filename.includes('/') || filename.includes('..')) {
      throw new Error(`Nome de arquivo de entrada inválido: "${filename}"`);
    }
    const fileKey = `${GENERATION_INPUT_ROOT}/${generationId}/${randomUUID()}/${filename}`;

    if (!this.inputPrivateBucket) {
      if (!this.s3Client) {
        return {
          url: `https://mock-s3.local/${this.bucketName}/${fileKey}`,
          key: fileKey,
          isPrivate: false,
        };
      }
      const size = await this.putObject(
        this.bucketName,
        fileKey,
        buffer,
        contentType,
        this.publicCacheControl,
      );
      this.logger.log(`Uploaded (public input) ${fileKey} (${size} bytes)`);
      return {
        url: this.getPublicUrl(fileKey),
        key: fileKey,
        isPrivate: false,
      };
    }

    if (this.s3Client) {
      const size = await this.putObject(
        this.inputPrivateBucket,
        fileKey,
        buffer,
        contentType,
        PRIVATE_INPUT_CACHE_CONTROL,
      );
      this.logger.log(`Uploaded (private input) ${fileKey} (${size} bytes)`);
    }
    return {
      url: await this.getInputReadUrl(fileKey),
      key: fileKey,
      isPrivate: true,
    };
  }

  /**
   * URL de leitura de uma entrada já gravada: assinada no bucket privado (validade padrão SAFETY_INPUT_URL_TTL) ou a
   * pública, quando as entradas ainda estão no bucket público. Serve para reassinar a evidência guardada.
   */
  async getInputReadUrl(
    fileKey: string,
    expiresInSeconds: number = this.inputUrlTtlSeconds,
  ): Promise<string> {
    if (
      !fileKey.startsWith(`${GENERATION_INPUT_ROOT}/`) ||
      fileKey.includes('..')
    ) {
      throw new Error(`Chave fora da pasta de entradas: "${fileKey}"`);
    }
    if (!this.inputPrivateBucket) return this.getPublicUrl(fileKey);

    const ttl = Math.min(
      Math.max(Math.floor(expiresInSeconds), 1),
      MAX_INPUT_URL_TTL_SECONDS,
    );
    if (!this.s3Client) {
      return `https://mock-s3.local/${this.inputPrivateBucket}/${fileKey}?X-Amz-Expires=${ttl}`;
    }
    return getSignedUrl(
      this.s3Client,
      new GetObjectCommand({ Bucket: this.inputPrivateBucket, Key: fileKey }),
      { expiresIn: ttl },
    );
  }

  /**
   * URL nova para uma entrada da geração, a cada envio ao provedor: a assinada no upload vence (fila longa, nova
   * tentativa do BullMQ, desvio de modelo) e a chave não. Só reassina a URL do bucket PRIVADO dentro de
   * `inputs/<generationId>/`; pública, de outra geração, fora de `inputs/` ou ilegível volta igual (a de antes do bucket
   * privado continua no público, e reassinar no privado daria 404).
   */
  async refreshInputReadUrl(
    url: string,
    generationId: string,
  ): Promise<string> {
    if (!this.inputPrivateBucket || !url) return url;
    if (this.publicUrlBase && url.startsWith(`${this.publicUrlBase}/`)) {
      return url;
    }
    let pathname: string;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return url;
    }
    const marker = `/${this.inputPrivateBucket}/`;
    const at = pathname.indexOf(marker);
    if (at === -1) return url;
    let key: string;
    try {
      key = decodeURIComponent(pathname.slice(at + marker.length));
    } catch {
      return url;
    }
    if (
      !GENERATION_ID_SEGMENT.test(generationId) ||
      !key.startsWith(`${GENERATION_INPUT_ROOT}/${generationId}/`) ||
      key.includes('..')
    ) {
      return url;
    }
    return this.getInputReadUrl(key);
  }

  /**
   * Chave de uma entrada a partir da URL gravada no banco (assinada do bucket privado, pública ou simulada).
   * A URL assinada vence; a chave não. Devolve null para o que não é da pasta de entradas.
   */
  inputKeyFromUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    const clean = url.split(/[?#]/)[0];
    let key: string | null = null;
    if (this.publicUrlBase && clean.startsWith(`${this.publicUrlBase}/`)) {
      key = clean.slice(this.publicUrlBase.length + 1);
    } else {
      let pathname: string;
      try {
        pathname = new URL(clean).pathname;
      } catch {
        return null;
      }
      for (const bucket of [this.inputPrivateBucket, this.bucketName]) {
        if (!bucket) continue;
        const marker = `/${bucket}/`;
        const at = pathname.indexOf(marker);
        if (at !== -1) {
          key = pathname.slice(at + marker.length);
          break;
        }
      }
    }
    if (!key) return null;
    try {
      key = decodeURIComponent(key);
    } catch {
      return null;
    }
    return key.startsWith(`${GENERATION_INPUT_ROOT}/`) && !key.includes('..')
      ? key
      : null;
  }

  /** PutObject com o faststart do MP4 (moov no começo, para tocar enquanto baixa). Devolve o tamanho gravado. */
  private async putObject(
    bucket: string,
    fileKey: string,
    buffer: Buffer,
    contentType: string,
    cacheControl: string,
  ): Promise<number> {
    if (!this.s3Client) throw new Error('S3 não configurado (S3_ENDPOINT)');
    const finalBuffer =
      contentType === 'video/mp4' ? await this.applyFaststart(buffer) : buffer;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: fileKey,
        Body: finalBuffer,
        ContentType: contentType,
        ContentLength: finalBuffer.length,
        CacheControl: cacheControl,
      }),
    );
    return finalBuffer.length;
  }

  /**
   * Buckets onde uma pasta pode ter objetos: o público sempre; o privado também quando a pasta é de entradas
   * (o que nasceu antes do bucket privado continua no público até a limpeza); a quarentena também quando a pasta é de
   * resultados (a exclusão LGPD e a limpeza alcançam o que ficou segurado ou sobrou de um upload parcial).
   */
  private bucketsForPrefix(prefix: string): string[] {
    const buckets = [this.bucketName];
    if (
      this.inputPrivateBucket &&
      prefix.startsWith(`${GENERATION_INPUT_ROOT}/`)
    ) {
      buckets.push(this.inputPrivateBucket);
    }
    if (
      this.quarantineBucket &&
      prefix.startsWith(`${GENERATION_OUTPUT_ROOT}/`)
    ) {
      buckets.push(this.quarantineBucket);
    }
    return buckets;
  }

  /**
   * Generates a signed read URL for an S3 object.
   * Only used by backfill scripts to re-sign expired URLs from old data.
   */
  async getSignedReadUrl(fileKey: string): Promise<string> {
    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: fileKey,
    });

    return getSignedUrl(this.s3Client, command, {
      expiresIn: 7 * 24 * 60 * 60,
    });
  }

  /**
   * Deletes all S3 objects under a given prefix (folder).
   * E.g., deleteByPrefix('inputs/abc123/') removes all files in that folder.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    if (!this.s3Client) {
      this.logger.warn('S3 not configured — skipping deleteByPrefix');
      return 0;
    }

    let totalDeleted = 0;
    let firstError: Error | null = null;
    // cada bucket é tentado mesmo que o anterior falhe; o erro sobe no fim
    for (const bucket of this.bucketsForPrefix(prefix)) {
      try {
        totalDeleted += await this.deleteByPrefixIn(
          this.s3Client,
          bucket,
          prefix,
        );
      } catch (error) {
        firstError ??=
          error instanceof Error ? error : new Error(String(error));
      }
    }

    if (totalDeleted > 0) {
      this.logger.log(
        `Deleted ${totalDeleted} objects under prefix "${prefix}"`,
      );
    }
    if (firstError) throw firstError;

    return totalDeleted;
  }

  private async deleteByPrefixIn(
    s3Client: S3Client,
    bucket: string,
    prefix: string,
  ): Promise<number> {
    let totalDeleted = 0;
    let continuationToken: string | undefined;

    do {
      const listResult = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const objects = listResult.Contents;
      if (!objects?.length) break;

      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
        }),
      );

      totalDeleted += objects.length;
      continuationToken = listResult.IsTruncated
        ? listResult.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return totalDeleted;
  }

  /**
   * Versão estrita do deleteByPrefix, para quando a exclusão precisa ser confirmada (exclusão de conta, LGPD): só
   * devolve (o total apagado) quando o bucket confirmou cada objeto da pasta. Lança StorageDeleteError quando o S3 não
   * está configurado, a pasta não tem a forma `<raiz>/.../` (nunca apaga o bucket inteiro), a listagem ou o
   * DeleteObjects falham, ou o DeleteObjects devolve Errors[] para alguma chave. Depois de uma chave recusada, segue
   * apagando as páginas seguintes e lança no fim: a pasta conta como não apagada e a próxima rodada tenta de novo.
   */
  async deleteByPrefixStrict(prefix: string): Promise<number> {
    if (!this.s3Client) {
      throw new StorageDeleteError(
        'S3 não configurado (S3_ENDPOINT): nada foi apagado.',
        prefix,
        0,
        [],
      );
    }
    // pasta de verdade (`raiz/.../`): prefixo vazio, solto ou começando na raiz apagaria o bucket inteiro
    if (
      typeof prefix !== 'string' ||
      prefix !== prefix.trim() ||
      prefix.length < 2 ||
      prefix.startsWith('/') ||
      !prefix.endsWith('/')
    ) {
      throw new StorageDeleteError(
        `Pasta inválida para exclusão: "${String(prefix)}".`,
        String(prefix),
        0,
        [],
      );
    }

    let deleted = 0;
    const failures: StorageDeleteError[] = [];
    // cada bucket é tentado mesmo que o anterior falhe; a pasta só conta como apagada se todos confirmarem
    for (const bucket of this.bucketsForPrefix(prefix)) {
      try {
        deleted += await this.deleteByPrefixStrictIn(
          this.s3Client,
          bucket,
          prefix,
        );
      } catch (error) {
        failures.push(
          error instanceof StorageDeleteError
            ? error
            : new StorageDeleteError(
                `Exclusão na pasta "${prefix}" falhou: ${describeStorageFailure(error)}`,
                prefix,
                0,
                [],
              ),
        );
      }
    }

    if (failures.length) {
      if (failures.length === 1 && deleted === 0) throw failures[0];
      throw new StorageDeleteError(
        failures.map((failure) => failure.message).join(' | '),
        prefix,
        deleted + failures.reduce((sum, failure) => sum + failure.deleted, 0),
        failures.flatMap((failure) => failure.failedKeys),
      );
    }

    if (deleted > 0) {
      this.logger.log(
        `Deleted ${deleted} objects under prefix "${prefix}" (strict)`,
      );
    }
    return deleted;
  }

  private async deleteByPrefixStrictIn(
    s3Client: S3Client,
    bucket: string,
    prefix: string,
  ): Promise<number> {
    let deleted = 0;
    const failedKeys: string[] = [];
    let unnamedFailures = 0;
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();

    do {
      let listResult: ListObjectsV2CommandOutput;
      try {
        listResult = await s3Client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
      } catch (error) {
        throw new StorageDeleteError(
          `Listagem da pasta "${prefix}" falhou: ${describeStorageFailure(error)}`,
          prefix,
          deleted,
          failedKeys,
        );
      }

      const keys = (listResult.Contents ?? [])
        .map((object) => object.Key)
        .filter(
          (key): key is string => typeof key === 'string' && key.length > 0,
        );

      if (keys.length) {
        let deleteResult: DeleteObjectsCommandOutput;
        try {
          deleteResult = await s3Client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })) },
            }),
          );
        } catch (error) {
          throw new StorageDeleteError(
            `Exclusão na pasta "${prefix}" falhou: ${describeStorageFailure(error)}`,
            prefix,
            deleted,
            failedKeys,
          );
        }

        const pageKeys = new Set(keys);
        const refusedHere = new Set<string>();
        for (const failure of deleteResult.Errors ?? []) {
          if (failure?.Key && pageKeys.has(failure.Key))
            refusedHere.add(failure.Key);
          else unnamedFailures++;
        }
        failedKeys.push(...refusedHere);
        deleted += keys.length - refusedHere.size;
      }

      if (listResult.IsTruncated) {
        const next = listResult.NextContinuationToken;
        // sem token (ou o mesmo de antes) a listagem pararia no meio: a pasta não fica confirmada
        if (!next || seenTokens.has(next)) {
          throw new StorageDeleteError(
            `Listagem da pasta "${prefix}" veio truncada sem continuação válida.`,
            prefix,
            deleted,
            failedKeys,
          );
        }
        seenTokens.add(next);
        continuationToken = next;
      } else {
        continuationToken = undefined;
      }
    } while (continuationToken);

    if (failedKeys.length || unnamedFailures) {
      const sample = failedKeys
        .slice(0, STRICT_DELETE_KEYS_IN_MESSAGE)
        .join(', ');
      throw new StorageDeleteError(
        `O bucket recusou ${failedKeys.length + unnamedFailures} objeto(s) da pasta "${prefix}"` +
          (sample
            ? ` (${sample}${failedKeys.length > STRICT_DELETE_KEYS_IN_MESSAGE ? ', ...' : ''})`
            : '') +
          `; ${deleted} apagado(s).`,
        prefix,
        deleted,
        failedKeys,
      );
    }

    return deleted;
  }

  /**
   * Generates a tiny blurred base64 data URL from an image buffer.
   * Used as LQIP (Low Quality Image Placeholder) for instant perceived loading.
   */
  async generateBlurDataUrl(imageBuffer: Buffer): Promise<string> {
    const tiny = await sharp(imageBuffer)
      .resize(16, 16, { fit: 'cover' })
      .blur(2)
      .webp({ quality: 20 })
      .toBuffer();
    return `data:image/webp;base64,${tiny.toString('base64')}`;
  }
}
