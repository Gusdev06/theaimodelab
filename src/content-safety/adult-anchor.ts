import { flatten } from './minor-guard';

/**
 * Âncora de adulto dos modelos sem filtro (regra do dono, 06/11): nesses modelos toda pessoa gerada é adulta, com
 * qualquer palavra que a cliente use. Duas coisas acontecem com o texto que vai ao PROVEDOR (o pedido guardado na
 * geração fica como a cliente escreveu):
 *  1. a gíria de juventude que a trava libera ("novinha", "ninfeta", "colegial", "schoolgirl", "jovencita") é trocada
 *     por "mulher adulta": o modelo de imagem nunca lê a gíria. "Colegial" vira adulta de uniforme (fantasia);
 *  2. a regra de idade é anexada ao fim de todo prompt, inclusive dos que não têm gíria nenhuma.
 * Não substitui a trava (minor-guard.ts): idade abaixo de 18, criança, série e lugar de escola são recusados antes de
 * chegar aqui. Função pura: sem rede, sem banco. `ADULT_ANCHOR_ENABLED=false` desliga (a trava continua igual).
 */

export const ADULT_ANCHOR_VERSION = 'adulto-2026-11-06';

/**
 * Idade APARENTE com folga sobre os 18: modelo de imagem puxa para mais novo quando o pedido fala de juventude, e a
 * regra é a imagem parecer adulta, não a idade escrita. Vai entre colchetes e dito como regra visual: nos modelos de vídeo
 * com voz (MiniMax H3, Seedance) o que vem entre aspas é fala, e a âncora não pode virar fala da personagem.
 */
export const ADULT_ANCHOR =
  '[Visual rule, not dialogue: every person shown is clearly an adult (apparent age 20 or older), with adult facial features and adult body proportions.]';

/** Começo da âncora: prompt reaproveitado que já a traz não ganha outra. */
const ANCHOR_MARK = 'every person shown is clearly an adult';

export function adultAnchorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ADULT_ANCHOR_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * Gíria de juventude na escrita normal, sobre o texto achatado (minúsculo, sem acento, mesmas posições do original):
 *  - `cloth`: peça de roupa + colegial ("saia colegial", "uniforme de colegiala") → a peça fica, a gíria vira "escolar";
 *  - `theme`: fantasia/estilo + colegial ("fantasia de colegial") → "uniforme escolar";
 *  - `dressed`: "dressed as a schoolgirl" → "wearing a school-uniform costume";
 *  - `outfit`: "schoolgirl outfit/uniform/costume" → "school-uniform";
 *  - `word`: a gíria como pessoa.
 */
const YOUTH_SLANG_IN_PROMPT =
  /(?<![\p{L}\p{N}])(?:(?<cloth>(?:uniformes?|saias?|roupas?|camisas?|blusas?|ropas?|faldas?)\s+(?:de\s+)?)(?<clothSlang>colegia[a-z]*)|(?<theme>(?:fantasia|fantasiad[ao]s?|vestid[ao]s?|disfrazad[ao]s?|estilo|look|traje|disfraz|cosplay|visual|tema)\s+(?:de\s+|como\s+)?)(?<themeSlang>colegia[a-z]*)|(?<dressed>(?:dress(?:ed|ing)?(?:\s+up)?|cosplay(?:ing)?)\s+(?:as|like)\s+(?:an?\s+)?school ?girls?)|(?<outfit>school ?girls?)(?=\s+(?:outfit|uniform|costume|skirt|look|style|cosplay|attire|dress|roleplay)(?![a-z]))|(?<word>novi+nh[a-z]*|novin|ninfet[a-z]*|nymph(?:et|ette)[a-z]*|colegia[a-z]*|kolegial[a-z]*|colejial[a-z]*|school ?girl[a-z]*|jovencit[a-z]*))(?![\p{L}\p{N}])/gu;

/** A gíria como pessoa, no idioma dela. "novinho" fica: quase sempre é "novinho em folha". */
function adultPerson(slang: string): string | null {
  const plural = /s$/.test(slang);
  if (/^novi+nho/.test(slang)) return null;
  if (/^(?:novi|ninfet)/.test(slang)) return plural ? 'jovens adultas' : 'jovem adulta';
  if (/^nymph/.test(slang)) return plural ? 'young adult women' : 'young adult woman';
  if (/^school/.test(slang)) return plural ? 'adult women wearing school-uniform costumes' : 'adult woman wearing a school-uniform costume';
  if (/^jovencito/.test(slang)) return plural ? 'hombres adultos jóvenes' : 'hombre adulto joven';
  if (/^jovencit/.test(slang)) return plural ? 'mujeres adultas jóvenes' : 'mujer adulta joven';
  // colegial (pt) e colegiala (es)
  if (/^(?:colegiala|kolegiala|colejiala)/.test(slang)) return plural ? 'mujeres adultas con uniforme escolar' : 'mujer adulta con uniforme escolar';
  return plural || /is$/.test(slang) ? 'mulheres adultas de uniforme escolar' : 'mulher adulta de uniforme escolar';
}

/**
 * Gíria que fala da IDADE da pessoa ("novinha", "ninfeta", "jovencita", "nymphet"), escrita normalmente. "Colegial" e
 * "schoolgirl" ficam de fora de propósito: são fantasia (roupa), não idade. Num pedido COM foto, a fantasia veste a
 * pessoa da foto e segue; a gíria de idade descreve a pessoa da foto, e a troca por "mulher adulta" não muda quem está
 * nela. A forma disfarçada nunca chega aqui: a trava já barrou.
 */
const AGE_SLANG = /(?<![\p{L}\p{N}])(?:novi+nh[a-z]*|novin|novynh[a-z]*|ninfet[a-z]*|nymph(?:et|ette)[a-z]*|jovencit[a-z]*)(?![\p{L}\p{N}])/u;

export function hasAgeSlang(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.length > 0 && AGE_SLANG.test(flatten(text));
}

export interface NeutralizedPrompt {
  text: string;
  /** gírias trocadas, como estavam escritas (para o log; nunca o prompt inteiro) */
  replaced: string[];
}

/** Troca a gíria de juventude por adulta no texto que vai ao provedor. O resto do texto fica igual. */
export function neutralizeYouthSlang(prompt: string): NeutralizedPrompt {
  if (!prompt) return { text: prompt ?? '', replaced: [] };
  const flat = flatten(prompt);
  // o achatamento mantém as posições; se não mantiver (caractere fora do plano básico), não arrisca cortar errado
  if (flat.length !== prompt.length) return { text: prompt, replaced: [] };
  const replaced: string[] = [];
  let out = '';
  let cursor = 0;
  YOUTH_SLANG_IN_PROMPT.lastIndex = 0;
  for (const match of flat.matchAll(YOUTH_SLANG_IN_PROMPT)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const groups = match.groups ?? {};
    let replacement: string | null;
    if (groups.clothSlang) replacement = prompt.slice(start, start + (groups.cloth ?? '').length).replace(/\s+de\s+$/i, ' ') + 'escolar';
    else if (groups.themeSlang) replacement = prompt.slice(start, start + (groups.theme ?? '').length) + 'uniforme escolar';
    else if (groups.dressed) replacement = 'wearing a school-uniform costume';
    else if (groups.outfit) replacement = 'school-uniform';
    else replacement = adultPerson(groups.word ?? '');
    if (replacement === null) continue;
    out += prompt.slice(cursor, start) + replacement;
    cursor = end;
    replaced.push(prompt.slice(start, end));
  }
  if (!replaced.length) return { text: prompt, replaced };
  // "a schoolgirl" virou "a adult woman": acerta o artigo
  return { text: (out + prompt.slice(cursor)).replace(/\b([Aa]) (adult wom[ae]n wearing )/g, '$1n $2'), replaced };
}

/**
 * O prompt como vai a um provedor SEM filtro: gíria de juventude trocada por adulta e a regra de idade no fim. Com
 * `maxLength`, o pedido é cortado antes da âncora (a âncora nunca é o que sobra de fora). Prompt vazio fica vazio: a
 * âncora não inventa pedido onde não havia texto.
 */
export function adultSafePrompt(prompt: string | null | undefined, maxLength?: number): string {
  const source = (prompt ?? '').trim();
  if (!source || !adultAnchorEnabled()) return maxLength ? source.slice(0, maxLength) : source;
  const base = neutralizeYouthSlang(source).text;
  if (base.includes(ANCHOR_MARK)) return maxLength ? base.slice(0, maxLength) : base;
  const tail = `\n\n${ADULT_ANCHOR}`;
  const room = maxLength ? Math.max(0, maxLength - tail.length) : base.length;
  return (base.length > room ? base.slice(0, room).trimEnd() : base) + tail;
}
