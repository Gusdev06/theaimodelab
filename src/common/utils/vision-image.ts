import sharp from 'sharp';

/** Acima disso a imagem é reduzida antes de ir pro modelo de visão (Gemini aceita ~20MB por request). */
export const VISION_SHRINK_ABOVE_BYTES = 4 * 1024 * 1024;
const VISION_MAX_DIM = 2048;

/**
 * Deixa qualquer imagem num tamanho que o modelo de visão aceita, sem rejeitar
 * upload grande: acima de `VISION_SHRINK_ABOVE_BYTES` redimensiona pra ≤2048px
 * e reencoda em JPEG. Abaixo, passa como veio. O modelo só precisa "ver" a
 * imagem — não reproduzir em alta.
 */
export async function fitImageForVision(
  buf: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (buf.length <= VISION_SHRINK_ABOVE_BYTES) return { buffer: buf, mimeType };
  const buffer = await sharp(buf, { animated: false })
    .rotate()
    .resize(VISION_MAX_DIM, VISION_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { buffer, mimeType: 'image/jpeg' };
}
