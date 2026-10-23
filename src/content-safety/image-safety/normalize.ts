import { createHash } from 'crypto';
import * as sharp from 'sharp';
import { NormalizedImage, SafetyProviderUnavailableError } from './types';

/**
 * Preparo da imagem para o Rekognition (limites fixos da AWS): até 5 MB em bytes, só JPEG ou PNG, lado mínimo de
 * 80 px. Tudo vira JPEG de até 1920 px no lado maior (sem ampliar), orientado pelo EXIF e sem transparência (fundo
 * branco). GIF e WebP animados viram até 3 imagens: o 1º quadro e 2 do meio.
 *
 * Arquivo que não é imagem (ou formato fora da lista, ou HEIC sem codec no sharp pré-compilado) lança
 * SafetyProviderUnavailableError('normalize', 'invalid_media'): a orquestração encerra na hora, sem esperar.
 */

export const REKOGNITION_MAX_BYTES = 5 * 1024 * 1024;
export const REKOGNITION_MAX_SIDE = 1920;
export const REKOGNITION_MIN_SIDE = 80;

/** Formatos aceitos na entrada. SVG e PDF ficam de fora: o renderizador pode buscar recurso externo. */
const ACCEPTED_FORMATS: ReadonlySet<string> = new Set([
  'jpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'heif',
  'tiff',
]);

const FORMAT_MIME: Readonly<Record<string, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heif: 'image/heif',
  tiff: 'image/tiff',
};

/** Tentativas de codificação até caber em 5 MB: qualidade primeiro, depois lado menor. */
const ENCODE_LADDER: ReadonlyArray<{ maxSide: number; quality: number }> = [
  { maxSide: REKOGNITION_MAX_SIDE, quality: 85 },
  { maxSide: REKOGNITION_MAX_SIDE, quality: 75 },
  { maxSide: REKOGNITION_MAX_SIDE, quality: 65 },
  { maxSide: 1600, quality: 65 },
  { maxSide: 1280, quality: 60 },
];

/** Teto de tempo do sharp por imagem (arquivo patológico não prende o job). */
const SHARP_TIMEOUT_SECONDS = 20;
const WHITE = { r: 255, g: 255, b: 255 };

/** Pixels decodificados (8 bits por canal, sem transparência). */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function invalidMedia(): SafetyProviderUnavailableError {
  return new SafetyProviderUnavailableError('normalize', 'invalid_media');
}

/** Quadros de uma animação que vão para a checagem: o 1º e 2 do meio (a 1/3 e 2/3), sem repetir. */
export function animationFrameIndexes(pages: number): number[] {
  if (!Number.isInteger(pages) || pages <= 1) return [0];
  const indexes = [0, Math.floor(pages / 3), Math.floor((2 * pages) / 3)];
  return [...new Set(indexes.map((index) => Math.min(index, pages - 1)))];
}

/** Instante (ms) de um quadro de GIF/WebP pela soma dos atrasos anteriores; null sem a informação. */
function frameTimeMs(
  delays: number[] | undefined,
  index: number,
): number | null {
  if (!delays || delays.length < index) return null;
  let total = 0;
  for (let i = 0; i < index; i++) {
    const delay = delays[i];
    if (typeof delay !== 'number' || !Number.isFinite(delay)) return null;
    total += delay;
  }
  return total;
}

/** Decodifica uma página: orienta pelo EXIF, tira a transparência e reduz para caber em 1920 px. */
async function decodePage(
  input: Buffer,
  page: number | null,
): Promise<RawImage> {
  const options: sharp.SharpOptions = page === null ? {} : { page, pages: 1 };
  const { data, info } = await sharp(input, options)
    .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
    .rotate()
    .flatten({ background: WHITE })
    .resize({
      width: REKOGNITION_MAX_SIDE,
      height: REKOGNITION_MAX_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

/** Tamanho final: cabe em `maxSide` (só amplia com `enlarge`) e o lado menor chega a 80 px (ampliando ou com borda). */
function targetSize(
  width: number,
  height: number,
  maxSide: number,
  enlarge: boolean,
): { width: number; height: number; padWidth: number; padHeight: number } {
  let scale = maxSide / Math.max(width, height);
  if (!enlarge) scale = Math.min(scale, 1);
  let scaledWidth = Math.max(1, Math.round(width * scale));
  let scaledHeight = Math.max(1, Math.round(height * scale));
  const shortSide = Math.min(scaledWidth, scaledHeight);
  if (shortSide < REKOGNITION_MIN_SIDE) {
    // amplia até o lado menor ter 80 px sem passar do lado maior permitido; o que faltar vira borda branca
    const longSide = Math.max(scaledWidth, scaledHeight);
    const growth = Math.min(
      REKOGNITION_MIN_SIDE / shortSide,
      maxSide / longSide,
    );
    if (growth > 1) {
      scaledWidth = Math.max(1, Math.round(scaledWidth * growth));
      scaledHeight = Math.max(1, Math.round(scaledHeight * growth));
    }
  }
  return {
    width: scaledWidth,
    height: scaledHeight,
    padWidth: Math.max(0, REKOGNITION_MIN_SIDE - scaledWidth),
    padHeight: Math.max(0, REKOGNITION_MIN_SIDE - scaledHeight),
  };
}

/**
 * Codifica pixels já decodificados como JPEG aceito pelo Rekognition: até 1920 px no lado maior, lado menor de pelo
 * menos 80 px e menos de 5 MB (qualidade 85, depois 75, 65 e lado menor). `enlarge` amplia até 1920 (passada
 * recortada); sem ele, só reduz. `maxBytes` só serve para baixar o teto (padrão: o limite do Rekognition).
 */
export async function encodeRekognitionJpeg(
  raw: RawImage,
  options: { enlarge?: boolean; maxBytes?: number } = {},
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const maxBytes =
    options.maxBytes && options.maxBytes > 0
      ? Math.min(options.maxBytes, REKOGNITION_MAX_BYTES)
      : REKOGNITION_MAX_BYTES;
  for (const step of ENCODE_LADDER) {
    const size = targetSize(
      raw.width,
      raw.height,
      step.maxSide,
      options.enlarge === true,
    );
    let pipeline = sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: raw.channels },
    }).timeout({ seconds: SHARP_TIMEOUT_SECONDS });
    if (size.width !== raw.width || size.height !== raw.height) {
      pipeline = pipeline.resize({
        width: size.width,
        height: size.height,
        fit: 'fill',
      });
    }
    if (size.padWidth > 0 || size.padHeight > 0) {
      const left = Math.floor(size.padWidth / 2);
      const top = Math.floor(size.padHeight / 2);
      pipeline = pipeline.extend({
        left,
        right: size.padWidth - left,
        top,
        bottom: size.padHeight - top,
        background: WHITE,
      });
    }
    const { data, info } = await pipeline
      .toColourspace('srgb')
      .jpeg({ quality: step.quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.length < maxBytes) {
      return { jpeg: data, width: info.width, height: info.height };
    }
  }
  throw invalidMedia();
}

/**
 * Normaliza a mídia de entrada ou de resultado para o Rekognition. `sha256` de cada imagem devolvida é o do arquivo
 * ORIGINAL (cache do veredito e lista de bloqueio exata). Animação: até 3 imagens com `frame` (índice da página).
 */
export async function toRekognitionJpeg(
  input: Buffer,
  mimeType: string | null,
): Promise<NormalizedImage[]> {
  if (!Buffer.isBuffer(input) || input.length === 0) throw invalidMedia();

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input).metadata();
  } catch {
    throw invalidMedia();
  }
  const format = metadata.format ? String(metadata.format) : '';
  if (!ACCEPTED_FORMATS.has(format)) throw invalidMedia();

  const sha256 = sha256Hex(input);
  const sourceMimeType = mimeType ?? FORMAT_MIME[format] ?? null;
  const pages = metadata.pages ?? 1;
  const animated = pages > 1;
  const indexes = animated ? animationFrameIndexes(pages) : [0];

  const images: NormalizedImage[] = [];
  for (const index of indexes) {
    let encoded: { jpeg: Buffer; width: number; height: number };
    try {
      const raw = await decodePage(input, animated ? index : null);
      encoded = await encodeRekognitionJpeg(raw);
    } catch (error) {
      if (error instanceof SafetyProviderUnavailableError) throw error;
      throw invalidMedia();
    }
    const image: NormalizedImage = {
      jpeg: encoded.jpeg,
      width: encoded.width,
      height: encoded.height,
      sha256,
      sourceMimeType,
    };
    if (animated) {
      image.frame = { index, timeMs: frameTimeMs(metadata.delay, index) };
    }
    images.push(image);
  }
  return images;
}
