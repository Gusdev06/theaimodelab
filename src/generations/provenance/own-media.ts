import { Logger } from '@nestjs/common';
import { GenerationStatus, GenerationType } from '@prisma/client';
import * as sharp from 'sharp';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * "Esta foto é uma geração da própria cliente, feita do zero na plataforma?" (pedido do dono, 26/10/2026).
 *
 * O desvio automático para modelo sem censura (Veo bloqueou → MiniMax H3; filtro de imagem → Unlocked) nunca leva a
 * foto da cliente, porque ela pode ser de uma pessoa real. Só que a foto, muitas vezes, é a modelo de IA que a própria
 * cliente criou aqui. Este módulo reconhece esse caso:
 *
 *  - Toda imagem que a plataforma entrega ganha uma impressão visual (dHash 9x8, 64 bits) e a proporção, guardadas em
 *    `media_fingerprints`. O site recomprime a foto antes de mandar (canvas → JPEG), então o hash exato dos bytes não
 *    serviria; o dHash sobrevive a redimensionar e recomprimir.
 *  - `cleanLineage`: a geração nasceu só de texto (sem foto de entrada e sem prompt clonado de foto), ou todas as
 *    fotos de entrada eram, elas mesmas, gerações limpas da mesma conta. Troca de rosto, provador e afins nunca entram
 *    (não são TEXT_TO_IMAGE/IMAGE_TO_IMAGE). Foto vinda de fora, ou derivada dela, nunca fica limpa.
 *  - No desvio, cada foto do pedido é comparada com as impressões limpas da MESMA conta. Só libera quando todas batem
 *    (distância ≤ 6 de 64 e proporção quase igual). Vídeo ou áudio de entrada nunca libera.
 *
 * Falha de leitura, rede ou banco = "não reconhecida": o desvio segue barrado como antes. Nada aqui lança.
 */

/** Distância máxima (bits diferentes de 64) para considerar a mesma imagem depois de recomprimida/redimensionada. */
export const MAX_DHASH_DISTANCE = 6;
/** Diferença máxima de proporção (largura ÷ altura), relativa. */
export const MAX_ASPECT_DIFF = 0.03;
/** Marca que o "Clonar prompt" põe em todo prompt tirado de uma foto (PR #4): prompt assim descreve uma foto real. */
const CLONED_FROM_PHOTO = /reference_override/i;
/** Maior arquivo baixado para conferir (imagem de entrada ou saída). */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** Quantas impressões limpas da conta entram na comparação (as mais novas). */
const MAX_FINGERPRINTS = 5_000;
/** Gerações antigas (antes desta tabela) que ganham impressão na hora, quando a foto não bateu com nenhuma. */
const BACKFILL_LIMIT = 40;
const BACKFILL_WINDOW_DAYS = 120;
const BACKFILL_CONCURRENCY = 6;
const BACKFILL_COOLDOWN_MS = 30 * 60 * 1000;

export interface Fingerprint {
  dhash: string;
  aspect: number;
}

/** dHash 9x8 (64 bits, hexadecimal) e proporção de uma imagem. Lança se o arquivo não for imagem. */
export async function fingerprintImage(buffer: Buffer): Promise<Fingerprint> {
  const meta = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!meta.width || !meta.height) throw new Error('imagem sem dimensões');
  // a orientação EXIF 5–8 troca largura e altura
  const aspect = (meta.orientation ?? 1) >= 5 ? meta.height / meta.width : meta.width / meta.height;

  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const stride = info.channels;
  const luma = (x: number, y: number) => data[(y * 9 + x) * stride];
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (luma(x, y) < luma(x + 1, y) ? 1n : 0n);
    }
  }
  return { dhash: bits.toString(16).padStart(16, '0'), aspect };
}

/** Bits diferentes entre dois dHash. Hash inválido = 64 (nunca bate). */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return 64;
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/** A imagem é a mesma de alguma das impressões (recomprimida ou redimensionada)? */
export function matchesAny(candidate: Fingerprint, known: readonly Fingerprint[]): boolean {
  return known.some(
    (item) =>
      hammingDistance(candidate.dhash, item.dhash) <= MAX_DHASH_DISTANCE &&
      Math.abs(candidate.aspect - item.aspect) / Math.max(item.aspect, 1e-6) <= MAX_ASPECT_DIFF,
  );
}

export type LineageByOrigin = 'clean' | 'check_inputs' | 'not_clean';

/**
 * Linhagem pela origem da geração: só texto = limpa; com fotos de entrada = depende de as fotos serem limpas;
 * qualquer outro tipo (troca de rosto, provador, upscale, vídeo…) ou imagem a partir de foto sem registro da foto =
 * não limpa.
 */
export function lineageByOrigin(input: {
  type: GenerationType;
  inputImageCount: number;
  prompt: string | null;
}): LineageByOrigin {
  if (input.prompt && CLONED_FROM_PHOTO.test(input.prompt)) return 'not_clean';
  if (input.type === GenerationType.TEXT_TO_IMAGE) {
    return input.inputImageCount === 0 ? 'clean' : 'check_inputs';
  }
  if (input.type === GenerationType.IMAGE_TO_IMAGE) {
    return input.inputImageCount === 0 ? 'not_clean' : 'check_inputs';
  }
  return 'not_clean';
}

/** Campos de job com IMAGEM de entrada (URL ou lista de URLs). */
const IMAGE_FIELDS = [
  'imageUrl',
  'imageUrls',
  'lastImageUrl',
  'firstFrameUrl',
  'lastFrameUrl',
  'referenceImageUrls',
  'sourceImageUrl',
  'targetImageUrl',
] as const;
/** Campos de job com vídeo ou áudio de entrada: nunca reconhecidos como geração própria. */
const OTHER_MEDIA_FIELDS = [
  'referenceVideoUrls',
  'referenceAudioUrls',
  'videoUrl',
  'videoList',
  'audioUrl',
] as const;

/**
 * Fotos de entrada de um job, para conferir a origem. `null` = há mídia que não dá para conferir (vídeo, áudio,
 * formato desconhecido): a origem não é reconhecida.
 */
export function inputImageUrlsOfJob(
  data: unknown,
  storedInputImageUrls: readonly string[] = [],
): string[] | null {
  const fields = (data ?? {}) as Record<string, unknown>;
  if (fields.hasVideoInput === true) return null;
  for (const field of OTHER_MEDIA_FIELDS) {
    const value = fields[field];
    if (Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim().length > 0 : value != null) {
      return null;
    }
  }
  const urls: string[] = [];
  for (const field of IMAGE_FIELDS) {
    const value = fields[field];
    if (value == null) continue;
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      if (typeof item !== 'string') return null;
      if (item.trim()) urls.push(item.trim());
    }
  }
  if (fields.hasInputImages === true) urls.push(...storedInputImageUrls);
  return [...new Set(urls)];
}

async function download(url: string): Promise<Buffer | null> {
  try {
    if (!/^https:\/\//i.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return null;
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_DOWNLOAD_BYTES) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length > MAX_DOWNLOAD_BYTES ? null : buffer;
  } catch {
    return null;
  }
}

async function fingerprintUrl(url: string): Promise<Fingerprint | null> {
  const buffer = await download(url);
  if (!buffer) return null;
  try {
    return await fingerprintImage(buffer);
  } catch {
    return null;
  }
}

export class OwnMediaProvenance {
  private readonly logger = new Logger(OwnMediaProvenance.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Todas as fotos são gerações limpas desta conta? Lista vazia = false (sem foto não há o que liberar).
   * Nunca lança.
   */
  async allOwnClean(userId: string, imageUrls: readonly string[] | null): Promise<boolean> {
    if (!imageUrls || imageUrls.length === 0) return false;
    try {
      const candidates = await Promise.all(imageUrls.map((url) => fingerprintUrl(url)));
      if (candidates.some((item) => item === null)) return false;
      const inputs = candidates as Fingerprint[];

      let known = await this.cleanFingerprints(userId);
      if (inputs.every((item) => matchesAny(item, known))) return true;

      // gerações de antes desta tabela: impressão feita agora, só das que nasceram de texto (no máximo 1x a cada
      // 30 min por conta neste processo, para uma conta que sempre manda foto de fora não baixar a galeria toda hora)
      if (!this.backfillDue(userId)) return false;
      const added = await this.backfillTextOnly(userId);
      if (added === 0) return false;
      known = await this.cleanFingerprints(userId);
      return inputs.every((item) => matchesAny(item, known));
    } catch (error) {
      this.logger.warn(`[OWN_MEDIA] user=${userId}: conferência da origem falhou (${(error as Error).message})`);
      return false;
    }
  }

  /**
   * Grava a impressão das imagens que uma geração acabou de entregar, com a linhagem. Chamado na conclusão, ANTES
   * de apagar as fotos de entrada (a linhagem confere as entradas). Nunca lança.
   */
  async recordGeneration(
    generationId: string,
    outputFingerprints: readonly (Fingerprint | null)[] = [],
  ): Promise<void> {
    try {
      const generation = await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: {
          userId: true,
          type: true,
          prompt: true,
          status: true,
          inputImages: { select: { url: true }, orderBy: { order: 'asc' } },
          outputs: { select: { url: true, order: true }, orderBy: { order: 'asc' } },
        },
      });
      if (!generation || generation.status !== GenerationStatus.COMPLETED) return;
      if (
        generation.type !== GenerationType.TEXT_TO_IMAGE &&
        generation.type !== GenerationType.IMAGE_TO_IMAGE
      ) {
        return;
      }

      const inputUrls = generation.inputImages
        .map((image) => image.url)
        .filter((url): url is string => !!url);
      const origin = lineageByOrigin({
        type: generation.type,
        inputImageCount: generation.inputImages.length,
        prompt: generation.prompt,
      });
      let clean = origin === 'clean';
      if (origin === 'check_inputs') {
        clean =
          inputUrls.length === generation.inputImages.length &&
          (await this.allOwnClean(generation.userId, inputUrls));
      }

      for (const output of generation.outputs) {
        // a conclusão já baixou a saída para a miniatura e mandou a impressão; sem ela, baixa aqui
        const fingerprint = outputFingerprints[output.order] ?? (await fingerprintUrl(output.url));
        if (!fingerprint) continue;
        await this.prisma.mediaFingerprint.upsert({
          where: { generationId_outputOrder: { generationId, outputOrder: output.order } },
          create: {
            userId: generation.userId,
            generationId,
            outputOrder: output.order,
            dhash: fingerprint.dhash,
            aspect: fingerprint.aspect,
            cleanLineage: clean,
          },
          update: { dhash: fingerprint.dhash, aspect: fingerprint.aspect, cleanLineage: clean },
        });
      }
    } catch (error) {
      this.logger.warn(`[OWN_MEDIA] gen=${generationId}: impressão não gravada (${(error as Error).message})`);
    }
  }

  private readonly lastBackfill = new Map<string, number>();

  private backfillDue(userId: string): boolean {
    const now = Date.now();
    const last = this.lastBackfill.get(userId);
    if (last !== undefined && now - last < BACKFILL_COOLDOWN_MS) return false;
    if (this.lastBackfill.size > 10_000) this.lastBackfill.clear();
    this.lastBackfill.set(userId, now);
    return true;
  }

  private async cleanFingerprints(userId: string): Promise<Fingerprint[]> {
    return this.prisma.mediaFingerprint.findMany({
      where: { userId, cleanLineage: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_FINGERPRINTS,
      select: { dhash: true, aspect: true },
    });
  }

  /** Impressão das gerações só de texto mais novas que ainda não têm. Devolve quantas gravou. */
  private async backfillTextOnly(userId: string): Promise<number> {
    const since = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const generations = await this.prisma.generation.findMany({
      where: {
        userId,
        status: GenerationStatus.COMPLETED,
        type: GenerationType.TEXT_TO_IMAGE,
        createdAt: { gte: since },
        inputImages: { none: {} },
        mediaFingerprints: { none: {} },
      },
      orderBy: { createdAt: 'desc' },
      take: BACKFILL_LIMIT,
      select: {
        id: true,
        prompt: true,
        outputs: { select: { url: true, order: true }, orderBy: { order: 'asc' } },
      },
    });

    const jobs = generations.flatMap((generation) =>
      generation.outputs.map((output) => ({
        generationId: generation.id,
        outputOrder: output.order,
        url: output.url,
        clean:
          lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 0, prompt: generation.prompt }) ===
          'clean',
      })),
    );

    let added = 0;
    for (let start = 0; start < jobs.length; start += BACKFILL_CONCURRENCY) {
      const batch = jobs.slice(start, start + BACKFILL_CONCURRENCY);
      const prints = await Promise.all(batch.map((job) => fingerprintUrl(job.url)));
      for (let i = 0; i < batch.length; i++) {
        const fingerprint = prints[i];
        const job = batch[i];
        if (!fingerprint) continue;
        await this.prisma.mediaFingerprint.upsert({
          where: { generationId_outputOrder: { generationId: job.generationId, outputOrder: job.outputOrder } },
          create: {
            userId,
            generationId: job.generationId,
            outputOrder: job.outputOrder,
            dhash: fingerprint.dhash,
            aspect: fingerprint.aspect,
            cleanLineage: job.clean,
          },
          update: {},
        });
        if (job.clean) added++;
      }
    }
    return added;
  }
}
