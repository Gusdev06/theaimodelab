/**
 * Pedido "só de qualidade" numa edição com foto (TKT-373, 23/11/2026).
 *
 * No Unlocked, a cliente manda a foto e escreve só "Upscale", "Dar nitidez a la imagen" ou "Limpiar imagen y dar
 * nitidez". O texto chegava cru ao Seedream (com o bloco de ultra-realismo no fim) e na proporção do seletor da tela:
 * o modelo refazia a cena e devolvia outra cara, outro enquadramento e a foto esticada, cobrando 235 créditos por vez.
 * Medido em 14 dias: todos os pedidos curtos desse tipo eram dessa cliente (7 gerações, 1.710 créditos), e ela reclamou
 * no suporte. Aqui o pedido é reconhecido e trocado por uma edição que preserva a pessoa, a pose e o enquadramento.
 *
 * O reconhecimento é estrito de propósito, porque errar para o lado do "sim" joga fora o pedido da cliente:
 * - todas as palavras têm que ser de qualidade, de gramática (verbo, artigo, "a foto", "por favor") ou de defeito;
 * - qualidade ("nitidez", "HD", "upscale") não pode vir depois de negação/redução ("sem nitidez", "reduzir a nitidez");
 * - defeito ("blur", "ruído", "desfoque", "pixelado") só vale depois de um verbo de tirar ("tirar o desfoque"), nunca
 *   sozinho nem com "mais/add" ("add grain", "desfocar a foto" seguem crus);
 * - nada que fale da pessoa ("ela", "her", "a ella"): pedido de qualidade fala da foto.
 * Funções puras.
 */

/** Prompt fixo da ferramenta Upscale (generations.service.ts, generateUpscale). */
export const UPSCALE_TOOL_PROMPT =
  'Enhance image resolution to 4K quality while preserving all original details exactly. Improve sharpness, reduce compression artifacts, and enhance clarity without changing any visual elements. Maintain the exact same composition, colors, lighting, and all details.';

/** Edição que só melhora a qualidade: a pessoa, a pose, o estilo e o quadro ficam iguais. */
export const QUALITY_EDIT_PROMPT =
  'Edit this exact image. Make only this change: improve the image quality, with higher sharpness, clarity and fine detail, and remove blur, noise and compression artifacts. ' +
  'Keep everything else exactly the same: the same person with the same face, facial features and identity, the same expression, hair, skin tone, body shape and pose, ' +
  'the same clothing or lack of it, the same background, lighting and colors, and the exact same framing, crop, orientation and aspect ratio. ' +
  'Do not add, remove, move, rotate, zoom or restyle anything. Keep the original style and medium of the image.';

const MAX_QUALITY_REQUEST_CHARS = 120;

const whole = (source: string) => new RegExp(`^(?:${source})$`);

/** Pedir mais qualidade (pt/es/en, sem acento). */
const QUALITY = whole(
  [
    'up\\s?scal\\w*',
    'upres',
    'nitid\\w*',
    'sharp(?:en|er|ness|ened|ening)?',
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
    'fullhd',
    'u?hd',
    '[248]k',
    'clarity',
    'claridad',
    'clareza',
    'clearer',
    'crisp\\w*',
    'restaur\\w*',
    'foco',
    'focus',
    'focar',
    'enfocar',
    'nitido',
    'nitida',
  ].join('|'),
);

/** Verbos que já são "deixar melhor" sozinhos e também tiram o defeito que vem depois ("limpar o ruído"). */
const CLEAN = whole(
  'limp(?:ar|iar|a|ia|e|ie)|clean|cleanup|denoise|deblur|unblur',
);

/** Defeito: só vale como objeto de "tirar/limpar" ("tirar o desfoque"). */
const DEFECT = whole(
  [
    'blur\\w*',
    'borros\\w*',
    'borrad\\w*',
    'borrao',
    'desfo(?:c|qu)\\w*',
    'desenfo(?:c|qu)\\w*',
    'embacad\\w*',
    'ruidos?',
    'noise',
    'noisy',
    'granulad\\w*',
    'grain\\w*',
    'pixelad\\w*',
    'pixelated',
    'artefatos?',
    'artefactos?',
    'artifacts?',
    'compression',
    'compressao',
    'compresion',
  ].join('|'),
);

/** Tirar, reduzir ou negar: antes de defeito é bom; antes de qualidade inverte o pedido. */
const REMOVE = new Set([
  'tirar',
  'tira',
  'tire',
  'quitar',
  'quita',
  'quite',
  'remove',
  'remover',
  'removes',
  'eliminar',
  'elimina',
  'reduce',
  'reducir',
  'reduzir',
  'reduz',
  'reduza',
  'sem',
  'sin',
  'without',
  'no',
  'nao',
  'menos',
  'less',
  'fix',
  'corrigir',
  'corrige',
  'corregir',
  'corrige',
  'arreglar',
  'arregla',
  'consertar',
  'conserta',
]);

/** Pedir mais ou pôr: antes de qualidade é bom ("mais nítida"); antes de defeito pede o defeito ("add blur"). */
const ADD = new Set([
  'dar',
  'dale',
  'da',
  'make',
  'give',
  'add',
  'poner',
  'pon',
  'colocar',
  'coloca',
  'put',
  'deixa',
  'deixe',
  'deixar',
  'deja',
  'deje',
  'dejar',
  'leave',
  'more',
  'mas',
  'mais',
  'aumentar',
  'aumenta',
  'increase',
  'subir',
  'sube',
  'higher',
  'alta',
  'alto',
  'high',
  'max',
  'maxima',
  'maximo',
  'maximum',
  'super',
  'ultra',
  'full',
]);

/** Gramática neutra que pode sobrar. Nada de pessoa (ela, her, ella): pedido de qualidade fala da foto. */
const NEUTRAL = new Set([
  'solo',
  'so',
  'apenas',
  'somente',
  'just',
  'only',
  'a',
  'o',
  'os',
  'as',
  'el',
  'la',
  'los',
  'las',
  'lo',
  'the',
  'an',
  'un',
  'una',
  'um',
  'uma',
  'imagen',
  'imagem',
  'image',
  'img',
  'foto',
  'photo',
  'picture',
  'pic',
  'pict',
  'esta',
  'essa',
  'este',
  'esse',
  'this',
  'it',
  'dessa',
  'desta',
  'desse',
  'deste',
  'nessa',
  'nesta',
  'nesse',
  'neste',
  'de',
  'do',
  'del',
  'por',
  'y',
  'e',
  'and',
  'con',
  'com',
  'with',
  'en',
  'em',
  'in',
  'to',
  'al',
  'ao',
  'na',
  'of',
  'me',
  'mi',
  'my',
  'minha',
  'meu',
  'favor',
  'please',
  'pls',
  'plz',
  'pf',
  'pfv',
  'pfvr',
  'porfa',
  'porfis',
  'porfavor',
  'plis',
  'quiero',
  'quero',
  'i',
  'want',
  'need',
  'preciso',
  'necesito',
  'que',
  'quede',
  'fique',
  'se',
  'vea',
  'veja',
  'look',
  'mucho',
  'muito',
  'much',
  'very',
  'muy',
  'poco',
  'pouco',
  'bit',
  'little',
  'better',
  'mejor',
  'melhor',
  'version',
  'versao',
  'nivel',
  'level',
  'toda',
  'todo',
  'inteira',
  'inteiro',
  'whole',
  'entire',
]);

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * O pedido inteiro é "melhorar a qualidade desta foto" (nitidez, upscale, HD, limpar, tirar o desfoque)? Pedido longo,
 * com qualquer outra intenção, com negação da qualidade ou pedindo o defeito devolve false. O prompt fixo da ferramenta
 * Upscale também conta.
 */
export function isQualityOnlyEditRequest(
  prompt: string | null | undefined,
): boolean {
  const raw = (prompt ?? '').trim();
  if (!raw) return false;
  if (raw === UPSCALE_TOOL_PROMPT) return true;
  if (raw.length > MAX_QUALITY_REQUEST_CHARS) return false;
  const words = normalize(raw).split(' ').filter(Boolean);
  if (!words.length) return false;

  let asked = false;
  // o último verbo de direção visto: 'remove' (tirar/sem/reduzir) ou 'add' (dar/mais/pôr)
  let direction: 'remove' | 'add' | null = null;
  for (const word of words) {
    if (CLEAN.test(word)) {
      asked = true;
      direction = 'remove';
      continue;
    }
    if (REMOVE.has(word)) {
      direction = 'remove';
      continue;
    }
    if (QUALITY.test(word)) {
      if (direction === 'remove') return false;
      asked = true;
      continue;
    }
    if (DEFECT.test(word)) {
      if (direction !== 'remove') return false;
      asked = true;
      continue;
    }
    if (ADD.has(word)) {
      direction = 'add';
      continue;
    }
    if (/^(?:\d+x|x\d+)$/.test(word)) continue;
    if (NEUTRAL.has(word)) continue;
    return false;
  }
  return asked;
}

/** UNLOCKED_QUALITY_EDIT_LOCK: ligado por padrão; "off", "false" ou "0" devolve o comportamento antigo. */
export function qualityEditLockEnabled(
  flag: string | undefined | null,
): boolean {
  const value = (flag ?? '').trim().toLowerCase();
  return !(value === 'off' || value === 'false' || value === '0');
}
