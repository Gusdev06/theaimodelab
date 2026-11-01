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
 *  - Toda imagem que a plataforma entrega ganha uma impressão visual: dHash 9x8 (64 bits), miniatura 16x16 em cinza e
 *    a proporção, em `media_fingerprints`. O site recomprime a foto antes de mandar (canvas → JPEG), então o hash
 *    exato dos bytes não serviria.
 *  - `cleanLineage`: a geração nasceu só de texto (sem foto de entrada, sem busca de imagem na web e sem prompt clonado
 *    de foto), ou todas as fotos de entrada bateram, no critério ESTRITO, com gerações limpas da mesma conta. Troca de
 *    rosto, provador e afins nunca entram (não são TEXT_TO_IMAGE/IMAGE_TO_IMAGE).
 *  - No desvio, cada foto do pedido é comparada com as impressões limpas da MESMA conta. Quando todas batem, quem vai
 *    ao modelo sem censura é a NOSSA cópia guardada da geração que bateu, nunca os bytes que vieram no pedido: uma foto
 *    forjada para bater com a impressão não chega ao modelo, e um falso positivo só troca a foto por uma da própria
 *    modelo da cliente.
 *  - Imagem com transparência, com várias páginas ou gigante não é conferida (não reconhecida).
 *
 * Falha de leitura, rede ou banco = "não reconhecida": o desvio segue barrado como antes. Nada aqui lança.
 */

/** Critério do desvio: a foto enviada vira a nossa cópia, então um falso positivo não leva foto de fora. */
export const DETOUR_MATCH = { maxDistance: 6, maxThumbDiff: 14, maxAspectDiff: 0.03 } as const;
/**
 * Critério da linhagem (uma imagem nova feita a partir de foto vira "limpa"): aqui a foto que o provedor recebeu é a
 * do pedido, então o critério é bem mais apertado.
 */
export const LINEAGE_MATCH = { maxDistance: 4, maxThumbDiff: 8, maxAspectDiff: 0.02 } as const;
export type MatchRule = { maxDistance: number; maxThumbDiff: number; maxAspectDiff: number };

/** Marca que o "Clonar prompt" põe em todo prompt tirado de uma foto (PR #4): prompt assim descreve uma foto real. */
const CLONED_FROM_PHOTO = /reference_override/i;
/** Maior arquivo baixado para conferir (imagem de entrada ou saída). */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Maior imagem decodificada (largura × altura): acima disso não confere (bomba de descompressão). */
const MAX_INPUT_PIXELS = 40_000_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** Quantas impressões limpas da conta entram na comparação (as mais novas). */
const MAX_FINGERPRINTS = 5_000;
/** Gerações antigas (antes desta tabela) que ganham impressão na hora, quando a foto não bateu com nenhuma. */
const BACKFILL_LIMIT = 30;
const BACKFILL_WINDOW_DAYS = 120;
const BACKFILL_CONCURRENCY = 4;
const BACKFILL_COOLDOWN_MS = 30 * 60 * 1000;

export interface Fingerprint {
  /** dHash 9x8 em hexadecimal (16 caracteres) */
  dhash: string;
  /** miniatura 16x16 em cinza, hexadecimal (512 caracteres) */
  thumb: string;
  /** largura ÷ altura */
  aspect: number;
}

/**
 * Impressão de uma imagem. Lança para arquivo que não é imagem, com transparência (o que a conferência vê pode não
 * ser o que o provedor vê), com várias páginas ou grande demais.
 */
export async function fingerprintImage(buffer: Buffer): Promise<Fingerprint> {
  const options = { failOn: 'none' as const, limitInputPixels: MAX_INPUT_PIXELS };
  const meta = await sharp(buffer, options).metadata();
  if (!meta.width || !meta.height) throw new Error('imagem sem dimensões');
  if (meta.width * meta.height > MAX_INPUT_PIXELS) throw new Error('imagem grande demais');
  if ((meta.pages ?? 1) > 1) throw new Error('imagem com várias páginas');
  if (meta.hasAlpha) {
    const stats = await sharp(buffer, options).stats();
    const alpha = stats.channels[stats.channels.length - 1];
    if (!alpha || alpha.min < 255) throw new Error('imagem com transparência');
  }
  // a orientação EXIF 5–8 troca largura e altura
  const aspect = (meta.orientation ?? 1) >= 5 ? meta.height / meta.width : meta.width / meta.height;

  const grey = (width: number, height: number) =>
    sharp(buffer, options)
      .rotate()
      .removeAlpha()
      .greyscale()
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

  const small = await grey(9, 8);
  const luma = (x: number, y: number) => small.data[(y * 9 + x) * small.info.channels];
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (luma(x, y) < luma(x + 1, y) ? 1n : 0n);
    }
  }

  const thumbnail = await grey(16, 16);
  const thumbBytes = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) thumbBytes[i] = thumbnail.data[i * thumbnail.info.channels];

  return { dhash: bits.toString(16).padStart(16, '0'), thumb: thumbBytes.toString('hex'), aspect };
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

/** Diferença média (0–255) entre duas miniaturas 16x16. Miniatura inválida = 255 (nunca bate). */
export function thumbDifference(a: string, b: string): number {
  if (!/^[0-9a-f]{512}$/i.test(a) || !/^[0-9a-f]{512}$/i.test(b)) return 255;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  let total = 0;
  for (let i = 0; i < 256; i++) total += Math.abs(left[i] - right[i]);
  return total / 256;
}

export interface Comparison {
  distance: number;
  thumbDiff: number;
}

/** Compara duas impressões; null = não é a mesma imagem pelo critério. */
export function compare(candidate: Fingerprint, known: Fingerprint, rule: MatchRule): Comparison | null {
  if (Math.abs(candidate.aspect - known.aspect) / Math.max(known.aspect, 1e-6) > rule.maxAspectDiff) return null;
  const distance = hammingDistance(candidate.dhash, known.dhash);
  if (distance > rule.maxDistance) return null;
  const thumbDiff = thumbDifference(candidate.thumb, known.thumb);
  if (thumbDiff > rule.maxThumbDiff) return null;
  return { distance, thumbDiff };
}

/** A impressão mais parecida que passa no critério (ou null). */
export function bestMatch<T extends Fingerprint>(
  candidate: Fingerprint,
  known: readonly T[],
  rule: MatchRule,
): (Comparison & { item: T }) | null {
  let best: (Comparison & { item: T }) | null = null;
  for (const item of known) {
    const result = compare(candidate, item, rule);
    if (!result) continue;
    if (!best || result.distance + result.thumbDiff / 4 < best.distance + best.thumbDiff / 4) {
      best = { ...result, item };
    }
  }
  return best;
}

export type LineageByOrigin = 'clean' | 'check_inputs' | 'not_clean';

/**
 * Linhagem pela origem da geração: só texto = limpa; com fotos de entrada = depende de as fotos serem limpas;
 * qualquer outro tipo (troca de rosto, provador, upscale, vídeo…), imagem a partir de foto sem registro da foto,
 * busca de imagem na web (Nano Banana `google_search`) ou prompt clonado de foto = não limpa.
 */
export function lineageByOrigin(input: {
  type: GenerationType;
  inputImageCount: number;
  prompt: string | null;
  parameters?: unknown;
}): LineageByOrigin {
  if (input.prompt && CLONED_FROM_PHOTO.test(input.prompt)) return 'not_clean';
  const params = (input.parameters ?? {}) as Record<string, unknown>;
  if (params.google_search === true || params.googleSearch === true) return 'not_clean';
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

function isPresent(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value != null && value !== false;
}

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
  if (OTHER_MEDIA_FIELDS.some((field) => isPresent(fields[field]))) return null;
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

/**
 * Troca, nos campos de imagem do job, cada foto do pedido pela nossa cópia da geração que bateu. Devolve null se
 * sobrar alguma foto sem troca ou houver vídeo/áudio (aí nada vai ao modelo sem censura).
 */
export function substituteImageUrls<T>(data: T, replacements: ReadonlyMap<string, string>): T | null {
  const fields = { ...(data as Record<string, unknown>) };
  if (fields.hasVideoInput === true) return null;
  if (OTHER_MEDIA_FIELDS.some((field) => isPresent(fields[field]))) return null;
  for (const field of IMAGE_FIELDS) {
    const value = fields[field];
    if (value == null) continue;
    if (Array.isArray(value)) {
      const swapped: string[] = [];
      for (const item of value) {
        const replacement = typeof item === 'string' ? replacements.get(item.trim()) : undefined;
        if (!replacement) return null;
        swapped.push(replacement);
      }
      fields[field] = swapped;
    } else if (typeof value === 'string') {
      if (!value.trim()) continue;
      const replacement = replacements.get(value.trim());
      if (!replacement) return null;
      fields[field] = replacement;
    } else {
      return null;
    }
  }
  return fields as T;
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

/** Uma foto do pedido e a geração limpa da conta com que ela bateu. */
export interface OwnMatch {
  inputUrl: string;
  generationId: string;
  outputOrder: number;
  /** nossa cópia (link público permanente do armazenamento): é ela que vai ao modelo sem censura */
  outputUrl: string;
  distance: number;
  thumbDiff: number;
}

interface KnownFingerprint extends Fingerprint {
  generationId: string;
  outputOrder: number;
}

export class OwnMediaProvenance {
  private readonly logger = new Logger(OwnMediaProvenance.name);
  private readonly lastBackfill = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cada foto bate com uma geração limpa desta conta? Devolve a lista de casamentos (na ordem das fotos) ou null
   * quando alguma não bate, a lista está vazia ou há mídia que não dá para conferir. Nunca lança.
   */
  async matchOwnClean(
    userId: string,
    imageUrls: readonly string[] | null,
    rule: MatchRule = DETOUR_MATCH,
  ): Promise<OwnMatch[] | null> {
    if (!imageUrls || imageUrls.length === 0) return null;
    try {
      // uma por vez: cada uma é decodificada em memória
      const inputs: Fingerprint[] = [];
      for (const url of imageUrls) {
        const fingerprint = await fingerprintUrl(url);
        if (!fingerprint) return null;
        inputs.push(fingerprint);
      }

      let known = await this.cleanFingerprints(userId);
      let found = inputs.map((input) => bestMatch(input, known, rule));
      if (found.some((item) => !item)) {
        // gerações de antes desta tabela: impressão feita agora, só das que nasceram de texto (no máximo 1x a cada
        // 30 min por conta neste processo, para quem sempre manda foto de fora não baixar a galeria toda hora)
        if (!this.backfillDue(userId)) return null;
        const added = await this.backfillTextOnly(userId);
        if (added === 0) return null;
        known = await this.cleanFingerprints(userId);
        found = inputs.map((input) => bestMatch(input, known, rule));
        if (found.some((item) => !item)) return null;
      }

      const matches: OwnMatch[] = [];
      for (let i = 0; i < imageUrls.length; i++) {
        const hit = found[i]!;
        const output = await this.prisma.generationOutput.findFirst({
          where: { generationId: hit.item.generationId, order: hit.item.outputOrder },
          select: { url: true },
        });
        if (!output?.url || !/^https:\/\//i.test(output.url)) return null;
        matches.push({
          inputUrl: imageUrls[i],
          generationId: hit.item.generationId,
          outputOrder: hit.item.outputOrder,
          outputUrl: output.url,
          distance: hit.distance,
          thumbDiff: Math.round(hit.thumbDiff * 10) / 10,
        });
      }
      return matches;
    } catch (error) {
      this.logger.warn(`[OWN_MEDIA] user=${userId}: conferência da origem falhou (${(error as Error).message})`);
      return null;
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
          parameters: true,
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
        parameters: generation.parameters,
      });
      let clean = origin === 'clean';
      if (origin === 'check_inputs') {
        clean =
          inputUrls.length === generation.inputImages.length &&
          (await this.matchOwnClean(generation.userId, inputUrls, LINEAGE_MATCH)) !== null;
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
            thumb: fingerprint.thumb,
            aspect: fingerprint.aspect,
            cleanLineage: clean,
          },
          update: {
            dhash: fingerprint.dhash,
            thumb: fingerprint.thumb,
            aspect: fingerprint.aspect,
            cleanLineage: clean,
          },
        });
      }
    } catch (error) {
      this.logger.warn(`[OWN_MEDIA] gen=${generationId}: impressão não gravada (${(error as Error).message})`);
    }
  }

  private backfillDue(userId: string): boolean {
    const now = Date.now();
    const last = this.lastBackfill.get(userId);
    if (last !== undefined && now - last < BACKFILL_COOLDOWN_MS) return false;
    if (this.lastBackfill.size > 10_000) this.lastBackfill.clear();
    this.lastBackfill.set(userId, now);
    return true;
  }

  /** Impressões limpas da conta cujas saídas ainda estão no armazenamento (sem prazo vencido). */
  private async cleanFingerprints(userId: string): Promise<KnownFingerprint[]> {
    return this.prisma.mediaFingerprint.findMany({
      where: {
        userId,
        cleanLineage: true,
        generation: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_FINGERPRINTS,
      select: { generationId: true, outputOrder: true, dhash: true, thumb: true, aspect: true },
    });
  }

  /** Impressão das gerações só de texto mais novas que ainda não têm. Devolve quantas limpas gravou. */
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
        parameters: true,
        outputs: { select: { url: true, order: true }, orderBy: { order: 'asc' } },
      },
    });

    const jobs = generations.flatMap((generation) =>
      generation.outputs.map((output) => ({
        generationId: generation.id,
        outputOrder: output.order,
        url: output.url,
        clean:
          lineageByOrigin({
            type: GenerationType.TEXT_TO_IMAGE,
            inputImageCount: 0,
            prompt: generation.prompt,
            parameters: generation.parameters,
          }) === 'clean',
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
            thumb: fingerprint.thumb,
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
