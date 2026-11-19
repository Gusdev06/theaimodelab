import { GenerationType, Resolution } from '@prisma/client';

/**
 * Imagem não sai mais em 1K (dono, 19/11/2026, TKT-291). O pedido em 1K num modelo com filtro (GPT Image, Nano Banana)
 * que recusa o conteúdo é refeito pelo desvio do Unlocked na mesma resolução, e o Seedream em 1K entrega rosto e mão
 * deformados. Pedido de imagem em 1K passa a ser 2K, gerado e cobrado como 2K (o custo e a estimativa usam a mesma
 * regra, então a cliente vê o preço certo antes de gerar).
 *
 * Desligar: IMAGE_MIN_RES_2K=false.
 */
export const IMAGE_MIN_RES_ENV = 'IMAGE_MIN_RES_2K';

const IMAGE_TYPES: ReadonlySet<GenerationType> = new Set<GenerationType>([
  GenerationType.TEXT_TO_IMAGE,
  GenerationType.IMAGE_TO_IMAGE,
  GenerationType.VIRTUAL_TRY_ON,
  GenerationType.FACE_SWAP,
]);

/** GPT Image 2.5: a KIE só aceita estas proporções em 1K; nelas o 1K continua valendo. */
const GPT_IMAGE_25_ONLY_1K_ASPECTS = new Set(['27:16', '16:27', '9:8', '8:9']);

export function imageMinResolutionOn(flag: string | undefined = process.env[IMAGE_MIN_RES_ENV]): boolean {
  return (flag ?? '').trim().toLowerCase() !== 'false';
}

/** Resolução efetiva de uma imagem: 1K vira 2K com a regra ligada. Vídeo e outros tipos passam intactos. */
export function liftImageResolution(
  type: GenerationType,
  resolution: Resolution,
  options: { model?: string | null; aspectRatio?: string | null; flag?: string } = {},
): Resolution {
  if (resolution !== Resolution.RES_1K || !IMAGE_TYPES.has(type)) return resolution;
  if (!imageMinResolutionOn(options.flag ?? process.env[IMAGE_MIN_RES_ENV])) return resolution;
  if (options.model === 'gpt-image-2-5' && options.aspectRatio && GPT_IMAGE_25_ONLY_1K_ASPECTS.has(options.aspectRatio)) {
    return resolution;
  }
  return Resolution.RES_2K;
}

/** Mesma regra para o DTO da troca de rosto, que usa '1K' | '2K' | '4K'. */
export function liftFaceSwapResolution<T extends string | undefined>(resolution: T, flag?: string): T | '2K' {
  if (resolution !== '1K') return resolution;
  return imageMinResolutionOn(flag ?? process.env[IMAGE_MIN_RES_ENV]) ? '2K' : resolution;
}
