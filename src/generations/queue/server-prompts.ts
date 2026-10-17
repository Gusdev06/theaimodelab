/**
 * Prompts montados no servidor para ferramentas que quase não têm texto da cliente. Ficam fora do processor porque a
 * checagem de segurança (ImageSafetyService) precisa do prompt FINAL que vai ao provedor, sem importar o processor.
 */

/**
 * Prompt de undress usado pelo modelo `deepdeep`, que agora roda no Seedream
 * (WaveSpeed, image-to-image) em vez da API n8ked/deepnude. Passa cru pro
 * provider com `skipSafetyWrapper` — sem o wrapper que força roupa no personagem.
 */
export const UNDRESS_PROMPT =
  'remove all visible clothing from the subject in the image, keeping natural body proportions and anatomy, tits, vagina, ass, etc.';

/**
 * Prompt de face swap usado quando o modo Unlocked (NSFW) está ligado, rodando
 * pelo Seedream (WaveSpeed, image-to-image) com `skipSafetyWrapper`. Também é
 * reaproveitado como fallback de segurança do face swap padrão (nano-banana-2).
 */
export const FACE_SWAP_SEEDREAM_PROMPT =
  'Recreate the scene in Image 2 (clothing, body pose, and setting) replacing the person with the woman in Image 1. Preserve facial features, skin tone and body proportions from Image 1 with photorealistic lighting and shadows.';
