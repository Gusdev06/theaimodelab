import { BadRequestException } from '@nestjs/common';

/**
 * Mapeia o nome do modelo da API para o modelVariant usado na tabela credit_costs.
 * NBP = gemini-3-pro-image-preview (Nano Banana Pro)
 * NB2 = gemini-3.1-flash-image-preview (Nano Banana 2)
 * THEAIMODELAB_FAST = theaimodelab-fast (theaimodelab-provider)
 * THEAIMODELAB_QUALITY = theaimodelab-quality (theaimodelab-provider)
 * VEO_FAST = veo3_fast (KIE API)
 * VEO_MAX = veo3 (KIE API)
 */
const MODEL_TO_VARIANT: Record<string, string> = {
  // Images
  'gemini-3-pro-image-preview': 'NBP',
  'gemini-3.1-flash-image-preview': 'NB2',
  'nano-banana-pro': 'NBP',
  'nano-banana-2': 'NB2',
  // Sem censura
  'sem-censura': 'SEM_CENSURA',
  // GPT Image 2 / 2.5 Flare (Kie API) — mesmo provider, families diferentes
  'gpt-image-2': 'GPT_IMAGE_2',
  'gpt-image-2-5': 'GPT_IMAGE_2_5',
  // The AI Model Lab provider (video)
  'theaimodelab-fast': 'THEAIMODELAB_FAST',
  'theaimodelab-quality': 'THEAIMODELAB_QUALITY',
  'veo-3.1-fast-generate-001': 'THEAIMODELAB_FAST', // backward compat
  'veo-3.1-generate-001': 'THEAIMODELAB_QUALITY', // backward compat
  // KIE API (Veo 3.1)
  veo3_fast: 'VEO_FAST',
  veo3: 'VEO_MAX',
  // KIE API (Grok Imagine)
  'grok-imagine': 'GROK_IMAGINE',
  // KIE API (Gemini Omni Video)
  'gemini-omni-video': 'GEMINI_OMNI',
  // KIE API (Bytedance Seedance 2.0 / 2.5)
  'bytedance-seedance-2': 'SEEDANCE_2',
  'bytedance-seedance-2-5': 'SEEDANCE_2_5',
  // KIE API (Kling V3 Turbo — image-to-video)
  'kling-v3-turbo': 'KLING_V3_TURBO',
  // ComfyDeploy (WanImageToVideo — NSFW/legacy)
  'comfydeploy-wan': 'COMFYDEPLOY_WAN',
  // WaveSpeed (LTX 2.3 Spicy — image-to-video, NSFW)
  'wavespeed-ltx-spicy': 'WAVESPEED_LTX_SPICY',
  // WaveSpeed (Seedance 2.0 Fast Spicy — image-to-video, NSFW)
  'wavespeed-seedance-spicy': 'WAVESPEED_SEEDANCE_SPICY',
  // WaveSpeed (MiniMax H3 — text/image/reference to video, áudio nativo)
  'wavespeed-minimax-h3': 'WAVESPEED_MINIMAX_H3',
  // KIE API (Seedream Lite) — unificado: T2I se sem images, I2I se com images
  'seedream-5-lite': 'SEEDREAM_LITE',
  // Deepdeep API (n88ed) — image-to-image, requer imagem de input
  deepdeep: 'DEEPDEEP',
};

export function getModelVariant(
  model: string | undefined | null,
): string | null {
  if (!model) return null;
  return MODEL_TO_VARIANT[model] ?? null;
}

export const MODEL_VARIANT_MISMATCH = 'MODEL_VARIANT_MISMATCH';

/**
 * Variante de cobrança derivada SÓ do modelo (TKT-097).
 *
 * Antes, `dto.model_variant ?? getModelVariant(dto.model)` deixava o cliente
 * escolher a tabela de preço (e a elegibilidade de grátis/ilimitado) de um
 * modelo e rodar outro: `model: 'veo3'` + `model_variant: 'GROK_IMAGINE'`
 * cobrava 536 créditos por um vídeo de US$ 2,00. Agora o `model_variant` do
 * cliente é só conferido: se divergir do que o servidor deriva, 400
 * MODEL_VARIANT_MISMATCH. Modelo fora do mapa → null (nunca o valor do cliente).
 */
export function resolveModelVariant(
  model: string | undefined | null,
  clientVariant?: string | null,
): string | null {
  const serverVariant = getModelVariant(model);
  if (clientVariant && serverVariant && clientVariant !== serverVariant) {
    throw new BadRequestException({
      code: MODEL_VARIANT_MISMATCH,
      message: `model_variant "${clientVariant}" não corresponde ao modelo "${model}" (esperado: ${serverVariant}).`,
      statusCode: 400,
    });
  }
  if (clientVariant && !serverVariant) {
    // Modelo sem variante no mapa: o cliente não pode inventar uma tabela de preço.
    throw new BadRequestException({
      code: MODEL_VARIANT_MISMATCH,
      message: `model_variant "${clientVariant}" não é aceito para o modelo "${model ?? 'desconhecido'}".`,
      statusCode: 400,
    });
  }
  return serverVariant;
}
