/**
 * Pedido "só de qualidade" numa edição com foto (TKT-373, 23/11/2026).
 *
 * No Unlocked, a cliente manda a foto e escreve só "Upscale", "Dar nitidez a la imagen" ou "Limpiar imagen y dar
 * nitidez". O texto chegava cru ao Seedream (com o bloco de ultra-realismo no fim) e na proporção do seletor da tela:
 * o modelo refazia a cena e devolvia outra cara, outro enquadramento e a foto esticada, cobrando 235 créditos por vez.
 * Medido em 14 dias: todos os pedidos curtos desse tipo eram dessa cliente (7 gerações, 1.710 créditos), e ela reclamou
 * no suporte. Aqui o pedido é reconhecido e trocado por uma edição que preserva a pessoa, a pose e o enquadramento.
 *
 * O reconhecimento é estrito de propósito: o texto inteiro tem que ser pedido de qualidade (mais palavras de enchimento).
 * Qualquer outra palavra ("de rodillas", "sin ropa", "fundo de praia") mantém o pedido como veio. Funções puras.
 */

/** Prompt fixo da ferramenta Upscale (generations.service.ts, generateUpscale). */
export const UPSCALE_TOOL_PROMPT =
  'Enhance image resolution to 4K quality while preserving all original details exactly. Improve sharpness, reduce compression artifacts, and enhance clarity without changing any visual elements. Maintain the exact same composition, colors, lighting, and all details.';

/** Edição que só melhora a qualidade: a pessoa, a pose e o quadro ficam iguais. */
export const QUALITY_EDIT_PROMPT =
  'Edit this exact image. Make only this change: improve the image quality, with higher sharpness, clarity and fine detail, and remove blur, noise and compression artifacts. ' +
  'Keep everything else exactly the same: the same person with the same face, facial features and identity, the same expression, hair, skin tone, body shape and pose, ' +
  'the same clothing or lack of it, the same background, lighting and colors, and the exact same framing, crop, orientation and aspect ratio. ' +
  'Do not add, remove, move, rotate, zoom or restyle anything. Photorealistic result.';

const MAX_QUALITY_REQUEST_CHARS = 120;

// Termos de qualidade (pt/es/en), já sem acento. Pelo menos um tem que aparecer.
const QUALITY_TERMS = new RegExp(
  '\\b(?:' +
    [
      'up\\s?scal\\w*',
      'upres',
      'up\\s?res',
      'nitid\\w*',
      'sharp\\w*',
      'enhanc\\w*',
      'realz\\w*',
      'realce',
      'melhor(?:ar|e|a)',
      'mejor(?:ar|e|a)',
      'improve\\w*',
      'qualidade',
      'calidad',
      'quality',
      'resoluc\\w*',
      'resolucao',
      'resolution',
      'definic\\w*',
      'definicao',
      'definition',
      'detalhes?',
      'detalles?',
      'details?',
      'full\\s?hd',
      'u?hd',
      '[248]k',
      'limp(?:ar|iar|a|ia|e|ie)',
      'clean\\s?up',
      'clean',
      'denoise',
      'ruidos?',
      'noise',
      'granulad\\w*',
      'grain\\w*',
      'desenfo(?:c|qu)\\w*',
      'desfo(?:c|qu)\\w*',
      'borros\\w*',
      'borrao',
      'embacad\\w*',
      'blur\\w*',
      'deblur',
      'unblur',
      'enfoc\\w*',
      'focar',
      'foco',
      'focus',
      'crisp\\w*',
      'clarity',
      'claridad',
      'clareza',
      'clear(?:er)?',
      'pixelad\\w*',
      'pixelated',
    ].join('|') +
    ')\\b',
  'g',
);

// Enchimento que pode sobrar sem mudar o sentido de "só melhorar a qualidade".
const FILLER_WORDS = new Set(
  [
    'solo', 'so', 'apenas', 'somente', 'just', 'only',
    'a', 'o', 'os', 'as', 'el', 'la', 'los', 'las', 'the', 'an', 'un', 'una', 'um', 'uma',
    'imagen', 'imagem', 'image', 'img', 'foto', 'photo', 'picture', 'pic', 'pict',
    'esta', 'essa', 'este', 'esse', 'this', 'it', 'her', 'dela', 'ella', 'ela',
    'dar', 'dale', 'de', 'da', 'do', 'del', 'make', 'give', 'add', 'poner', 'colocar', 'por', 'put',
    'deixa', 'deixe', 'deixar', 'deja', 'deje', 'dejar', 'leave', 'lo', 'le', 'lhe', 'me', 'mi', 'my', 'minha', 'meu',
    'more', 'mas', 'mais', 'mejor', 'melhor', 'better', 'mucho', 'muito', 'much', 'very', 'muy', 'super', 'ultra',
    'y', 'e', 'and', 'con', 'com', 'with', 'sin', 'sem', 'without', 'no', 'nao',
    'favor', 'please', 'pls', 'plz', 'pf', 'porfa', 'porfavor', 'plis',
    'quiero', 'quero', 'i', 'want', 'need', 'preciso', 'necesito', 'que', 'quede', 'fique', 'se', 'vea', 'veja', 'look',
    'poco', 'pouco', 'bit', 'little', 'alta', 'alto', 'high', 'higher', 'max', 'maxima', 'maximo', 'maximum',
    'tirar', 'quitar', 'remove', 'eliminar', 'remover', 'reduce', 'reducir', 'reduzir',
    'en', 'em', 'in', 'to', 'al', 'ao', 'na', 'no', 'aumentar', 'increase', 'subir', 'aumenta',
    'version', 'versao', 'nivel', 'level', 'mismo', 'mesmo', 'same', 'igual', 'tal', 'cual', 'como', 'esta',
  ],
);

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * O pedido inteiro é "melhorar a qualidade desta foto" (nitidez, upscale, HD, limpar, tirar o desfoque)? Pedido longo
 * ou com qualquer outra intenção devolve false. O prompt fixo da ferramenta Upscale também conta.
 */
export function isQualityOnlyEditRequest(prompt: string | null | undefined): boolean {
  const raw = (prompt ?? '').trim();
  if (!raw) return false;
  if (raw === UPSCALE_TOOL_PROMPT) return true;
  if (raw.length > MAX_QUALITY_REQUEST_CHARS) return false;
  const text = normalize(raw);
  if (!text) return false;
  const withoutQuality = text.replace(QUALITY_TERMS, ' ');
  if (withoutQuality === text) return false;
  return withoutQuality
    .split(' ')
    .filter(Boolean)
    .every((word) => FILLER_WORDS.has(word));
}

/** UNLOCKED_QUALITY_EDIT_LOCK: ligado por padrão; "off", "false" ou "0" devolve o comportamento antigo. */
export function qualityEditLockEnabled(flag: string | undefined | null): boolean {
  const value = (flag ?? '').trim().toLowerCase();
  return !(value === 'off' || value === 'false' || value === '0');
}
