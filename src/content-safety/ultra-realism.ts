/**
 * Ultra-realismo nos prompts de foto do motor sem censura (decisão do dono, 13/11/2026: "sempre use ultrarrealismo até
 * nos prompts da plataforma, a não ser que sejam mangá etc"). Mesmo texto e mesma lista do site (lib/ultra-realism.ts
 * do theaimodelab-web): prompt que já tem o bloco (montado no site) não o ganha de novo. Pedido estilizado (anime, mangá, hentai, desenho, 3D, ilustração, pintura,
 * quadrinho, chibi, cel shading, Pixar, esboço, aquarela, drawing, line art, 2D, arte digital, pixel/vector art, manhwa,
 * webtoon, Ghibli, Disney, massinha, toon) fica sem ele.
 * Ligado por ULTRA_REALISM_PROMPTS=on (lido por quem chama); vazia ou off = nada muda. Funções puras.
 */

export const ULTRA_REALISM_BLOCK =
  'Ultra-realistic photo, visible skin pores, fine peach fuzz, natural skin imperfections, true-to-life skin tones, sharp eyes with catchlights, no beauty filter, no airbrushing, no plastic skin.';

/** Palavra inteira com acento ("mangá", "ilustração"): o \b do JS não conhece letra acentuada. */
const word = (source: string) => new RegExp(`(?<![\\p{L}\\d])(?:${source})(?![\\p{L}\\d])`, 'iu');

/** Pedido estilizado em pt/es/en; "Not photorealistic" é a trava de traço dos estilos desenhados do construtor. */
const STYLIZED_MARKERS: readonly RegExp[] = [
  word('anime|mang[aá]s?|hentai|chibi|pixar|cgi|3d'),
  word('cartoons?|cartoonish|desenhos?|dibujos?|caricatur\\p{L}*'),
  word('render(?:s|ed|ing)?|renderizad[oa]s?'),
  word('illustrat\\p{L}*|ilustra\\p{L}*|paint(?:ing|ings|ed|erly)|pinturas?|pintad[oa]s?'),
  word('comics?|quadrinhos?|historietas?|c[oó]mics?'),
  word('cel[\\s-]?shad\\p{L}*'),
  word('sketch\\p{L}*|esbo[cç]os?|bocetos?'),
  word('watercolou?rs?|aquarelas?|acuarelas?'),
  // 13/11 (revisão): traço, animação, 2D, arte digital/vetorial/pixel, quadrinho coreano, estúdios de animação e massinha
  word('draw(?:n|ing|ings)?|desenhad[oa]s?|dibujad[oa]s?|line[\\s-]?art|lineart|ink(?:ed)?\\s+drawing'),
  word('animated|animations?|anima[cç](?:[aã]o|[oõ]es)|animaci[oó]n(?:es)?|animad[oa]s?'),
  word('2d|digital\\s+(?:art|painting|illustration)|arte\\s+digital|concept\\s+art'),
  word('pixel[\\s-]?art|arte\\s+(?:em\\s+)?pixel|vector(?:\\s+art|ial)?|vetor(?:ial)?|arte\\s+vetorial'),
  word('manhwa|manhua|webtoons?|doujin(?:shi)?|toons?|vtuber'),
  word('ghibli|disney|dreamworks'),
  word('claymation|clay\\s+(?:figure|model|art)|stop[\\s-]?motion|massinha|plastilina'),
  word('styli[sz]ed|estilizad[oa]s?|low[\\s-]?poly'),
  word('not\\s+(?:photorealistic|a\\s+photo(?:graph)?)'),
];

export function isStylizedPrompt(text: string): boolean {
  return STYLIZED_MARKERS.some((marker) => marker.test(text));
}

/** O texto já leva o bloco (montado aqui ou na API). */
export function hasUltraRealism(text: string): boolean {
  return /ultra-realistic photo,\s*visible skin pores/i.test(text);
}

export function ultraRealismEnabled(flag: string | undefined | null): boolean {
  const value = (flag ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1';
}

/**
 * O bloco para somar a um prompt de foto, ou '' (flag desligada, pedido estilizado ou o bloco já presente). Quem chama
 * decide o lugar: antes do texto da cliente, para que o corte do teto caia nela e nunca no bloco nem na trava de idade.
 */
export function ultraRealismFor(enabled: boolean, ...texts: readonly string[]): string {
  if (!enabled) return '';
  const joined = texts.join(' ');
  if (isStylizedPrompt(joined) || hasUltraRealism(joined)) return '';
  return ULTRA_REALISM_BLOCK;
}
