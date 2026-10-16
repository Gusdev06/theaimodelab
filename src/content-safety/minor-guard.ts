/**
 * Guarda de conteúdo com MENORES — camada da própria plataforma, independente do filtro de cada provedor de IA.
 *
 * Por que existe: o único bloqueio de menores que havia era o código de erro do provedor (Google) mapeado em
 * content-safety.error.ts. Nos modelos sem censura (WaveSpeed Spicy, ComfyDeploy, Unlocked) a proteção dependia
 * 100% do filtro de terceiros. Numa plataforma +18 isso é inegociável: qualquer pedido que faça referência a
 * menor de idade é recusado ANTES de chegar a qualquer provedor, em qualquer tipo de geração (com ou sem nudez).
 * A TAML é 100% +18 (regra do dono), então não existe caso legítimo de gerar criança: o bloqueio é amplo de
 * propósito. Mas guarda que bloqueia prompt adulto legítimo acaba desligada, então os falsos positivos conhecidos
 * ("minor scratches", a modelo chamada Nina, "cor secundária", "5 years of experience") ficam de fora e estão
 * travados no teste (__tests__/minor-guard.spec.ts). Função pura: sem rede, sem banco.
 */

export interface MinorAssessment {
  blocked: boolean;
  /** categoria do que disparou (nunca o texto inteiro) */
  reason?: 'term' | 'age';
  /** o termo ou a idade que disparou, para o registro de abuso */
  match?: string;
}

/** Termos que, sozinhos, indicam menor de idade (pt / en / es). Palavra inteira, comparados já normalizados. */
const MINOR_TERMS: readonly string[] = [
  // en
  'child', 'children', 'kid', 'kids', 'kiddo', 'minors', 'a minor girl', 'a minor boy', 'minor girl', 'minor boy',
  'underage', 'under age', 'teen', 'teens', 'teenager', 'teenagers', 'teenage', 'preteen', 'pre teen', 'tween', 'tweens',
  'toddler', 'toddlers', 'infant', 'infants', 'little girl', 'little girls', 'little boy', 'little boys', 'young girl',
  'young girls', 'young boy', 'young boys', 'schoolgirl', 'schoolgirls', 'schoolboy', 'schoolboys', 'school girl',
  'school boy', 'school uniform', 'jailbait', 'prepubescent', 'pubescent', 'junior high', 'middle school',
  'middle schooler', 'elementary school', 'grade school', 'kindergarten', 'high schooler', 'high school girl',
  'high school boy', 'loli', 'lolis', 'lolita', 'lolicon', 'shota', 'shotacon', 'barely legal', 'pedo', 'pedophile',
  'paedophile', 'pedophilia', 'cp',
  // pt
  'crianca', 'criancas', 'criancinha', 'criancinhas', 'menor de idade', 'menores de idade', 'menorzinha', 'menorzinho',
  'infantil', 'infantis', 'adolescente', 'adolescentes', 'pre adolescente', 'preadolescente', 'novinha', 'novinhas',
  'novinho', 'novinhos', 'garotinha', 'garotinhas', 'garotinho', 'garotinhos', 'menininha', 'menininhas', 'menininho',
  'menininhos', 'colegial', 'colegiais', 'uniforme escolar', 'ensino fundamental', 'ensino medio', 'pedofilia',
  'pedofilo', 'pedofila', 'infancia',
  // es ("niña/niño" com ñ é tratado à parte: sem o ñ colide com o nome Nina)
  'ninos', 'ninas', 'nene', 'nenes', 'menor de edad', 'menores de edad', 'preadolescentes', 'chiquilla', 'chiquillas',
  'chiquillo', 'chiquillos', 'colegiala', 'colegialas', 'uniforme de colegio', 'escuela primaria', 'escuela secundaria',
  'estudiante de secundaria', 'infante', 'infantes',
];

/** Idades por extenso de 1 a 17 (en / pt / es): "fifteen years old", "quinze anos", "quince años". */
const SPELLED_UNDER_18: readonly string[] = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'um', 'dois', 'tres', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze',
  'catorze', 'quinze', 'dezesseis', 'dezessete',
  'uno', 'dos', 'cuatro', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'quince', 'dieciseis', 'diecisiete',
];

// depois da normalização "años" e "anos" viram "anos"; "año" vira "ano"
const AGE_UNIT = '(?:years?\\s*old|yrs?\\s*old|y\\s*o|yo|yrs?|years?|anos|ano|ans)';
/**
 * Não é idade de pessoa: "10 anos atrás", "5 years ago", "5 years of experience", "10 anos de casada".
 * Mas "15 years of age" / "15 anos de idade" / "15 años de edad" é idade e continua bloqueando.
 */
const NOT_AGE_AFTER = '(?!\\s*(?:atras|depois|antes|ago|later|before|from now|mais tarde|despues)\\b)(?!\\s*(?:of|de)\\s+(?!age\\b|idade\\b|edad\\b))';

const NUMERIC_AGE = new RegExp(`\\b(\\d{1,2})\\s*-?\\s*${AGE_UNIT}\\b${NOT_AGE_AFTER}`, 'g');
/** só prefixos que são idade de fato ("aged 15", "idade 15", "edad 15"); "com 15" e "de 12" eram tatuagem e pack */
const AGE_PREFIX = /\b(?:age|aged|idade|edad)\s*(?:of\s*|de\s*)?(\d{1,2})\b(?!\s*(?:k|mm|cm|%|fps|x|:|\/))/g;
const SPELLED_AGE = new RegExp(`\\b(${SPELLED_UNDER_18.join('|')})\\s*-?\\s*${AGE_UNIT}\\b${NOT_AGE_AFTER}`, 'g');
/** niña/niño/niñas/niños com o ñ no texto original (sem o ñ seria o nome Nina) */
const NINO_WITH_TILDE = /(?:^|[^a-záéíóúñ])niñ[oa]s?(?=$|[^a-záéíóúñ])/i;

/** minúsculas, sem acento, leetspeak de dígito/símbolo desfeito, pontuação vira espaço. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/1/g, 'i').replace(/0/g, 'o').replace(/[$5]/g, 's').replace(/7/g, 't')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Para a busca de idade: sem acento e minúsculo, mas SEM o leetspeak (os dígitos são a idade). */
function normalizeKeepDigits(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}

const TERM_PATTERNS = MINOR_TERMS.map((term) => ({ term, re: new RegExp(`(?:^|\\s)${term.replace(/\s+/g, '\\s+')}(?=$|\\s)`) }));

export function assessText(text: string | null | undefined): MinorAssessment {
  if (!text || typeof text !== 'string') return { blocked: false };
  if (NINO_WITH_TILDE.test(text.toLowerCase())) return { blocked: true, reason: 'term', match: 'niño/niña' };
  const words = ` ${normalize(text)} `;
  for (const { term, re } of TERM_PATTERNS) {
    if (re.test(words)) return { blocked: true, reason: 'term', match: term };
  }
  const digits = normalizeKeepDigits(text);
  for (const re of [NUMERIC_AGE, AGE_PREFIX]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(digits))) {
      const age = Number(m[1]);
      if (Number.isFinite(age) && age > 0 && age < 18) return { blocked: true, reason: 'age', match: `${age}` };
    }
  }
  SPELLED_AGE.lastIndex = 0;
  const spelled = SPELLED_AGE.exec(words);
  if (spelled) return { blocked: true, reason: 'age', match: spelled[1] };
  return { blocked: false };
}

/** Campos que nunca são texto livre do usuário (imagens em base64, URLs, mime, ids, tokens). */
const SKIP_KEY = /(image|base64|data|url|uri|mime|video|audio|file|mask|frame|thumbnail|token|signature|hash|^id$|_id$|Id$)/i;
const LOOKS_BINARY_OR_URL = /^(?:data:|https?:\/\/|blob:)|^[A-Za-z0-9+/=]{200,}$/;

/** Junta os textos livres de um corpo de requisição (prompt, negative_prompt, script…) até 4 níveis. */
export function collectTexts(body: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || body == null) return out;
  if (typeof body === 'string') {
    if (body.length <= 8_000 && !LOOKS_BINARY_OR_URL.test(body.trim())) out.push(body);
    return out;
  }
  if (Array.isArray(body)) {
    for (const item of body.slice(0, 50)) collectTexts(item, depth + 1, out);
    return out;
  }
  if (typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (SKIP_KEY.test(key)) continue;
      collectTexts(value, depth + 1, out);
    }
  }
  return out;
}

export function assessBody(body: unknown): MinorAssessment {
  for (const text of collectTexts(body)) {
    const result = assessText(text);
    if (result.blocked) return result;
  }
  return { blocked: false };
}
