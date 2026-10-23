import { canonical, checkAdultOnly, hasAdultTerms } from './adult-only-rules';

/**
 * Guarda de conteúdo com MENORES — camada da própria plataforma, independente do filtro de cada provedor de IA.
 *
 * Por que existe: o único bloqueio de menores que havia era o código de erro do provedor (Google) mapeado em
 * content-safety.error.ts. Nos modelos sem censura (WaveSpeed Spicy, ComfyDeploy, Unlocked) a proteção dependia
 * 100% do filtro de terceiros. Numa plataforma +18 isso é inegociável: qualquer pedido que faça referência a
 * menor de idade é recusado ANTES de chegar a qualquer provedor, em qualquer tipo de geração (com ou sem nudez).
 *
 * A conferência de cada texto é a trava do construtor de modelo do site (adult-only-rules.ts, cópia de
 * lib/influencer-safety.ts com o corpus de 1.099 casos do red team) no modo de pedido livre (`free`, piso 18):
 * forma canônica contra ofuscação, idade por número, por extenso, ordinal, comparativo e ano de nascimento, sem
 * confundir duração, contagem ("2 women") nem índice ("images 1, 2", "seed": 1). Por cima dela, esta camada:
 *  - lê os alfabetos que os clientes usam (hebraico, chinês/japonês, cirílico, árabe, tailandês, coreano) e
 *    recusa, sem registrar como menor, o alfabeto que ninguém confere ('script');
 *  - pega os termos centrais de francês, alemão, italiano, holandês e polonês;
 *  - não conta o que é negação, remoção ou condição ("no kids", "remove the children", "kids, if present: remove",
 *    "mother of 2 kids", "avoid: underage") — só quando o termo aparece escrito por extenso (ofuscado nunca é exceção);
 *  - deixa "cor secundária" e "personagem secundário" passarem, mas não "de secundaria" ou "ensino secundário".
 * Calibrada contra prompts reais do histórico (só contagens). Função pura: sem rede, sem banco.
 */

export interface MinorAssessment {
  blocked: boolean;
  /**
   * categoria do que disparou (nunca o texto inteiro): 'term'/'age' = menor de idade; 'size' = texto grande demais
   * para conferir; 'script' = alfabeto que a trava não lê (não é indício de menor)
   */
  reason?: 'term' | 'age' | 'size' | 'script';
  /** o termo ou a idade que disparou, para o registro de abuso */
  match?: string;
}

/** Idade legal de toda geração na API (o construtor de modelo usa 25 como piso da personagem). */
const AGE_FLOOR = 18;

/** Termo encontrado parece idade ("16", "under 18", "born in 2010")? Só muda a categoria do registro. */
const AGE_LIKE = /\d|\b(?:under|menos|abaixo|menor que|born|nascid|naci|class of|turma)\b/i;

/**
 * Maior texto conferido. Prompt de verdade é muito menor; acima disso o pedido é RECUSADO (reason 'size'), nunca
 * liberado sem leitura: espaço na frente e corte do provedor (ex.: slice(0, 5000)) não podem esconder o pedido.
 */
const MAX_TEXT_SCAN = 50_000;
/** Rodadas de "achou termo → era negação/remoção → apaga e confere de novo". Acabou sem decidir: recusa. */
const MAX_ROUNDS = 24;

/* ------------------------------------------------------------------ preparo do texto */

/**
 * Jargão técnico de prompt que a leitura de idade confundiria com idade: proporção "9:16", "1080p", "4k", "85mm",
 * "f/1.8", "ISO 400", "24fps", "5s", "50%", "3/4" (vista de três quartos, nota 8/10) e "2D/3D".
 */
const TECHNICAL_TOKENS: readonly RegExp[] = [
  /\b\d{1,2}(?:[.,]\d+)?\s*[:x×]\s*\d{1,2}(?:[.,]\d+)?\b/gi, // proporção 9:16, 16x9, 2.39:1, 0:05
  /\b\d{3,4}\s*[pi]\b/gi, // 1080p, 720p, 1080i
  /\b\d{1,2}\s*k\b/gi, // 4k, 8k
  /\b\d{1,4}(?:[.,]\d+)?\s*mm\b/gi, // 85mm
  /\bf\s*\/\s*\d{1,2}(?:[.,]\d+)?\b/gi, // f/1.8
  /\biso\s*\d{2,5}\b/gi, // ISO 400
  /\b\d{1,3}(?:[.,]\d+)?\s*fps\b/gi, // 24fps, 29.97 fps
  // 5s, 1.5 seconds, 10 segundos; "under 16s" fica (é "menores de 16" no inglês britânico, não duração)
  /(?<!\b(?:under|u|sub|below)[\s-]*)\b\d{1,3}(?:[.,]\d+)?\s*(?:s|secs?|seconds?|segundos?)\b/gi,
  /\b\d{1,3}(?:[.,]\d+)?\s*%/g, // 50%
  /\b\d{1,2}\s*\/\s*\d{1,2}\b/g, // 3/4, 8/10
  /\b[1-4]\s*d\b/gi, // 2D, 3D
];

/** Palavra de índice: o número depois dela é posição ou contagem ("images 1, 2 and 3", "slot 2", "step 1", "תמונה 2"). */
const INDEX_WORDS =
  'images?|imagem|imagens|imagen|imagenes|imágenes|imgs?|immagini|immagine|fotos?|photos?|pictures?|pics?|refs?|references?|referências?|referencias?|' +
  'slots?|panels?|painel|paineis|painéis|clips?|steps?|passos?|pasos?|etapas?|priority|prioridade|prioridad|frames?|quadros?|scenes?|cenas?|escenas?|' +
  'shots?|tomas?|takes?|layers?|camadas?|options?|opção|opções|opcao|opcoes|opción|opciones|opcion|versions?|versão|versões|versao|versoes|versión|' +
  'versiones|variations?|variação|variações|variacoes|variaciones|figures?|figuras?|blocks?|blocos?|bloques?|parts?|partes?|sections?|seções|secoes|' +
  'secciones|items?|itens|ítems|slides?|cards?|characters?|personagem|personagens|personaje|personajes|subjects?|inputs?|outputs?|videos?|vídeos?|cuts?|' +
  'cortes?|rounds?|levels?|níveis|niveis|lines?|linhas?|líneas?|lineas?|rows?|columns?|colunas?|pages?|páginas?|paginas?|chapters?|capítulos?|capitulos?|' +
  'episodes?|episódios?|episodios?|seasons?|temporadas?|numbers?|número|numero|n[º°]|no\\.|nr\\.?|num\\.|#|תמונה|תמונות|מספר';
const INDEX_NUMBERS = new RegExp(
  `((?:^|[^\\p{L}\\p{N}])(?:${INDEX_WORDS})\\s*[\\[(]?\\s*)(\\d{1,2}(?:\\s*(?:,|and|e|y|&|to|a|ou|or|-|–|—)\\s*\\d{1,2})*)`,
  'giu',
);

/** Chave técnica de JSON/YAML ("seed": 1, count: 4, "total_target_duration_seconds": 13): o valor nunca é idade. */
const TECHNICAL_KEY =
  /^(?:seed|steps?|count|cfg|guidance|scale|strength|duration|fps|width|height|quantity|quantidade|cantidad|number|num|n|id|index|indice|order|ordem|orden|priority|prioridade|layer|slot|image|imagem|reference|ref|frame|shot|scene|clip|take|version|variant|level|intensity|intensidade|weight|peso|opacity|ratio|aspect|size|tamanho|x|y|z|angle|angulo|rotation|zoom|distance|distancia|top|left|right|bottom|margin|padding|total|max|min|limit|amount|volume|speed|velocidade|loop|loops|repeat|batch|samples|outputs|seconds|segundos|minutes|start|end|inicio|fim|time|tempo|timestamp|hour|minute|second|day|stage|phase|fase|part|section|round|attempt|retry|rank|score|nota|rating|stars|estrelas|block|bloco|step_number|fps_target)$/;
const KEY_VALUE = /(?<![\p{L}\p{N}_])(["']?)([\p{L}_][\p{L}\p{N}_ -]{0,40})\1\s*[:=]\s*(["']?)(\d{1,3}(?:[.,]\d+)?)\3(?=\s*(?:[,}\]\n;]|$))/gu;

/** Marcador de lista no começo da linha ("1)", "2.", "(3)", "- 4:"), não idade. */
const LINE_LIST_MARKER = /(^|\n)(\s*[-•*]?\s*[([]?)(\d{1,2})(?=\s*[)\].:\-–—]\s)/g;
/** Número entre parênteses ou colchetes: só é lista quando a sequência começa em 1 ("(1) … (2) …"). */
const BRACKETED_NUMBER = /[([]\s*(\d{1,2})\s*[)\]]/g;

/**
 * Expressão de adulto que a leitura confundiria: "de quatro" é posição (não 4 anos) e "azul bebê", "baby pink" são cor
 * (não bebê nem roupa infantil).
 */
const ADULT_PHRASES: ReadonlyArray<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}])de\s+(?:quatro|4)(?![\p{L}\p{N}])(?!\s*(?:anos?|aninhos?|years?))/giu, 'em quatro apoios'],
  [/(?<![\p{L}\p{N}])(azul|rosa|celeste|verde|amarelo|amarillo|lil[aá]s?|lila|branco|blanco)[\s-]+beb[eêé](?![\p{L}\p{N}])/giu, '$1 claro'],
  [/(?<![\p{L}\p{N}])baby[\s-]+(blue|pink|yellow|green|purple|lilac)(?![\p{L}\p{N}])/giu, 'light $1'],
  // faixa que mede alguma coisa ("2 to 3 meters", "1.5 to 2 meters", "8–9 seconds", "10-12 cm"): não é faixa de idade
  [
    /(?<![\p{L}\p{N}])\d{1,3}(?:[.,]\d+)?\s*(?:-|–|—|to|a|até|ate|ou|or)\s*\d{1,3}(?:[.,]\d+)?\s*(?:seconds?|secs?|segundos?|s|minutes?|minutos?|mins?|hours?|horas?|meters?|metres?|metros?|m|cm|mm|km|feet|ft|foot|inches|inch|in|polegadas?|pulgadas?|kg|kgs|lbs?|pounds?|quilos?|kilos?|%|degrees|graus|grados|frames?|fps)(?![\p{L}\p{N}])/giu,
    ' ',
  ],
];

/**
 * Lista do que evitar DENTRO do prompt ("negative_prompt": ["minor", "teenager"], "Negative prompt: child, teen"): sai
 * antes da leitura, como o campo negative_prompt. Só lista de itens curtos (até 4 palavras): frase depois do cabeçalho
 * ("Negative prompt: blurry. A teen girl…") continua sendo lida.
 */
const NEGATIVE_JSON = /(["'])(?:negative_?prompts?|negatives?|negativeprompt|avoid|evitar|prompt_negativo)\1\s*:\s*(\[[^\]]{0,4000}\]|"[^"\n]{0,2000}")/giu;
const NEGATIVE_LINE = /(^|\n)([^\S\n]*(?:negative\s+prompts?|negative|negatives|prompt\s+negativo|avoid|evitar|evite)\s*[:：]\s*)([^\n]*)/giu;

function shortItems(list: string): boolean {
  const items = list.split(/[,;|]/).map((item) => item.replace(/["'[\]{}()]/g, ' ').trim()).filter(Boolean);
  return items.length > 0 && items.every((item) => item.split(/\s+/).length <= 4);
}

function withoutNegativeLists(text: string): string {
  return text
    .replace(NEGATIVE_JSON, (all: string, _quote: string, value: string) => (shortItems(value) ? ' '.repeat(all.length) : all))
    .replace(NEGATIVE_LINE, (all: string, start: string, head: string, items: string) =>
      // sem ponto final no meio (frase nova depois do cabeçalho) e só itens curtos
      !/[.!?]\s+\S/.test(items) && shortItems(items) ? start + head + ' '.repeat(items.length) : all,
    );
}

function prepare(source: string): string {
  let text = withoutNegativeLists(source.normalize('NFKC'));
  // as faixas ("8–9 seconds") antes do jargão técnico: tirar só "9 seconds" deixaria "approximately 8–" sozinho
  text = ADULT_PHRASES.reduce((acc, [re, replacement]) => acc.replace(re, replacement), text);
  text = TECHNICAL_TOKENS.reduce((acc, re) => acc.replace(re, ' '), text);
  text = text.replace(INDEX_NUMBERS, (_all, lead: string, numbers: string) => lead + ' '.repeat(numbers.length));
  text = text.replace(KEY_VALUE, (all: string, _q: string, key: string, _q2: string, value: string) => {
    const name = key.trim().toLowerCase();
    return name.includes('_') || TECHNICAL_KEY.test(name) ? all.slice(0, all.length - value.length - _q2.length) + ' ' + _q2 : all;
  });
  text = text.replace(LINE_LIST_MARKER, (_all, start: string, lead: string, number: string) => start + lead + ' '.repeat(number.length));
  const bracketed = [...text.matchAll(BRACKETED_NUMBER)].map((match) => Number(match[1]));
  const sequence = bracketed.length >= 2 && bracketed.includes(1) && bracketed.every((value) => value >= 0 && value <= bracketed.length + 1);
  if (sequence) text = text.replace(BRACKETED_NUMBER, (all) => all.replace(/\d+/, (digits) => ' '.repeat(digits.length)));
  return text;
}

/* ------------------------------------------------------------------ outros alfabetos */

/** Algarismos de qualquer alfabeto em 0-9 (árabe-índico, tailandês…), para a leitura de idade nos outros alfabetos. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x39) return char;
    for (let zero = code; zero > code - 10; zero--) {
      if (!/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) return String(code - zero);
    }
    return char;
  });
}

/** Número chinês/japonês pequeno ("十二" = 12, "十五" = 15, "七" = 7). */
function hanNumber(value: string): number | null {
  const DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const ten = value.indexOf('十');
  if (ten === -1) return value.length === 1 && DIGITS[value] !== undefined ? DIGITS[value] : null;
  const tens = ten === 0 ? 1 : (DIGITS[value.slice(0, ten)] ?? null);
  const units = ten === value.length - 1 ? 0 : (DIGITS[value.slice(ten + 1)] ?? null);
  return tens === null || units === null ? null : tens * 10 + units;
}

interface ScriptGuard {
  letters: RegExp;
  terms: RegExp;
  /** idade escrita: devolve a idade (ou null) a partir do casamento */
  age: RegExp;
}

/** Alfabetos que aparecem nos pedidos reais (hebraico, chinês, tailandês, cirílico, árabe). */
const SCRIPT_GUARDS: readonly ScriptGuard[] = [
  {
    // hebraico: prefixos colados (ה, ו, ש, ב, ל, מ, כ) antes do termo; "בת 15" / "בן 15" / "בגיל 15" = idade
    letters: /\p{Script=Hebrew}/u,
    terms:
      /(?<!\p{Script=Hebrew})[והשבלמכ]{0,3}(ילד(?:ה|ים|ות|ון|ונת|ונים|ותי|ותית)?|נער(?:ה|ים|ות|ונת)?|קטינ(?:ה|ים|ות)|קטין|תינוק(?:ת|ות)?|פעוט(?:ה|ים|ות)?|מתבגר(?:ת|ים|ות)?|תיכוניסט(?:ית|יות|ים)?|תלמיד(?:ה|ות|ים)?|בית ספר|יסודי|חטיבת ביניים|גן ילדים|לוליטה|לולי|פדופיל(?:ית|ים)?)(?!\p{Script=Hebrew})/u,
    age: /(?<!\p{Script=Hebrew})[וה]?(?:בת|בן|גיל|בגיל)\s*(\d{1,2})(?!\d)/u,
  },
  {
    // chinês e japonês (sem espaço entre palavras: o termo vale em qualquer lugar)
    letters: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
    terms:
      /(萝莉|蘿莉|ロリ|ショタ|正太|幼女|幼童|女童|男童|儿童|兒童|児童|小孩|孩童|小女孩|小男孩|未成年|未满十八|未滿十八|初中生|高中生|小学生|小學生|中学生|中學生|高校生|学生妹|學生妹|女学生|女學生|女子高生|女子中学生|女子小学生|女高中生|校服|セーラー服|ランドセル|婴儿|嬰兒|赤ちゃん|青少年|恋童|戀童|童颜|童顏|娃娃脸|娃娃臉|少女|子供|子ども|こども|幼い)/u,
    age: /(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:岁|歲|周岁|週歲|歳|才)/u,
  },
  {
    // russo e ucraniano (radical: o termo vale com qualquer terminação)
    letters: /\p{Script=Cyrillic}/u,
    terms:
      /(?<!\p{L})(девочк|девчонк|девчушк|школьниц|школьник|школьная форм|ребен|ребён|детск|дети|детей|детям|детьми|деточк|малолет|несовершеннолет|подрост|тинейдж|лоли|педоф|младен|мальчик|дочк|дочь|дочер|падчериц|первоклас|старшеклас|дівчинк|дитин|діти|дітей|школярк|підліт|неповнолітн)/u,
    age: /(?<!\d)(\d{1,2})\s*-?\s*(?:лет|летн\p{L}*|год|года|годик\p{L}*|рок|роки|років|річн\p{L}*)(?!\p{L})/u,
  },
  {
    // árabe: artigo e conjunção colados antes do termo
    letters: /\p{Script=Arabic}/u,
    terms:
      /(?<!\p{L})[وفبلك]?(?:ال)?(طفل|طفلة|أطفال|اطفال|قاصر|قاصرة|قاصرات|مراهق|مراهقة|مراهقات|مراهقين|تلميذ|تلميذة|تلميذات|رضيع|رضيعة|طفولي|طفولية|لوليتا|بيدوفيل)(?!\p{L})/u,
    age: /(?:(?<!\d)(\d{1,2})\s*(?:سنة|سنوات|سنين|عام|أعوام|اعوام|عاما|عامًا|سنه))|(?:(?:عمرها|عمره|بعمر|بسن|عمر|سن)\s*(\d{1,2})(?!\d))/u,
  },
  {
    // tailandês: "อายุ 15" (idade 15) e "15 ขวบ" (anos de criança)
    letters: /\p{Script=Thai}/u,
    terms: /(เด็ก|นักเรียน|วัยรุ่น|ผู้เยาว์|ทารก|โลลิ|มัธยม|ประถม)/u,
    age: /(?:อายุ\s*(\d{1,2}))|(?:(\d{1,2})\s*ขวบ)/u,
  },
  {
    // coreano
    letters: /\p{Script=Hangul}/u,
    terms: /(로리|소녀|여고생|여중생|초등학생|중학생|고등학생|미성년|아동|어린이|아기|교복|여학생|남학생|유아)/u,
    age: /(\d{1,2})\s*(?:살|세)(?!\p{Script=Hangul})/u,
  },
];

/**
 * Pedido com letras de outro alfabeto: confere a lista do alfabeto; alfabeto sem lista é recusado sem leitura
 * ('script', não conta como menor). Letras que só PARECEM latinas (homógrafos) já viraram latinas na forma canônica.
 */
function checkScripts(source: string): MinorAssessment | null {
  // caminho rápido: texto só com alfabeto latino, pontuação, número e emoji (quase todo prompt)
  if (!/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(source)) return null;
  // letra de alfabeto próprio (o "ˈ" da pronúncia e outras letras modificadoras são de uso comum, não alfabeto)
  const foreign = [...canonical(source).matchAll(/\p{L}/gu)]
    .map((match) => match[0])
    .filter((char) => !/[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(char));
  if (!foreign.length) return null;
  // só os sinais de vogal do hebraico e do árabe saem (no tailandês e no japonês o sinal faz parte da palavra)
  const text = asciiDigits(source.normalize('NFKC').toLowerCase())
    .replace(/־/g, ' ')
    .replace(/[֑-ֽֿ-ׇً-ٰٟـ]/g, '');
  for (const guard of SCRIPT_GUARDS) {
    if (!foreign.some((char) => guard.letters.test(char))) continue;
    const term = guard.terms.exec(text);
    if (term) return { blocked: true, reason: 'term', match: term[1] ?? term[0] };
    const age = guard.age.exec(text);
    if (age) {
      const raw = age.slice(1).find((part) => part !== undefined) ?? '';
      const value = /^\d+$/.test(raw) ? Number(raw) : hanNumber(raw);
      if (value !== null && value >= 1 && value < AGE_FLOOR) return { blocked: true, reason: 'age', match: age[0].trim() };
    }
  }
  const unread = foreign.find((char) => !SCRIPT_GUARDS.some((guard) => guard.letters.test(char)));
  return unread ? { blocked: true, reason: 'script', match: unread } : null;
}

/* ------------------------------------------------------------------ termos de outras línguas latinas */

/** Francês, alemão, italiano, holandês e polonês, mais irmão pequeno no masculino (pt/en/es). Texto sem acento. */
const LATIN_EXTRA = new RegExp(
  '(?<![a-z0-9])(' +
    [
      'little brothers?', 'baby brothers?', 'irmaozinhos?', 'maninhos?', 'hermanitos?', 'carnalito',
      'fillettes?', 'petites? filles?', 'jeunes? filles?', 'enfants?', 'gamines?', 'ecolieres?', 'ecoliers?', 'collegiennes?', 'collegiens?', 'lyceennes?',
      'lyceens?', 'ados', 'mineures?', 'madchen', 'schulmadchen', 'schulerin(?:nen)?', 'minderjahrig\\w*', 'kleinkind\\w*', 'kindlich\\w*', 'jugendlich\\w*',
      'teenagerin\\w*', 'bambin[aeio]', 'ragazzin[aeio]', 'minorenn[ei]', 'scolarett[ae]', 'scolar[aeio]', 'bimb[ae]', 'meisjes?', 'schoolmeisjes?', 'tieners?',
      'kinderen', 'dziewczynk\\w*', 'nastolat\\w*', 'nieletni\\w*',
    ]
      .map((term) => term.replace(/ /g, '\\s+'))
      .join('|') +
    ')(?![a-z0-9])',
  'g',
);

/* ------------------------------------------------------------------ negação, remoção e condição */

/** Mesmo texto, minúsculo e sem acento, com cada caractere na MESMA posição (para achar e apagar o termo). */
function flatten(text: string): string {
  let out = '';
  for (const char of text) {
    const base = char.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    out += base.length === char.length ? base : char.length === 1 ? (base[0] ?? ' ') : ' '.repeat(char.length);
  }
  return out;
}

const NEGATORS = new Set([
  'no', 'not', 'without', 'sem', 'sin', 'nao', 'never', 'nunca', 'nenhum', 'nenhuma', 'ningun', 'ninguna', 'ninguno', 'zero', 'none', 'nobody', 'ninguem',
  'nadie', 'nor', 'nem', 'ni', 'nada', 'avoid', 'avoiding', 'evitar', 'evite', 'evita', 'exclude', 'excluding', 'excluir', 'exclua', 'excluya', 'sans', 'ohne',
  'senza',
]);
/**
 * Verbo de tirar ("remove all kids from the image"): só é exceção em pedido sem conteúdo adulto. Foto com criança em
 * pedido de nudez é recusada mesmo com "remova a criança" (o modelo trabalha a foto inteira).
 */
const REMOVAL_VERBS = new Set([
  'remove', 'removing', 'remova', 'remover', 'removam', 'retire', 'retirar', 'retirem', 'tire', 'tirar', 'quite', 'quitar', 'quita', 'elimina', 'eliminar',
  'elimine', 'eliminate', 'eliminating', 'borra', 'borrar', 'borre', 'erase', 'erasing', 'delete', 'deleting', 'deletar', 'apague', 'apagar', 'crop',
  'cleaned', 'clean',
]);
/** Verbo que, negado logo antes ("do not include", "não coloque", "never show"), nega o termo. */
const ACTION_VERBS = new Set([
  'include', 'including', 'add', 'adding', 'show', 'showing', 'put', 'place', 'generate', 'create', 'draw', 'depict', 'feature', 'have', 'contain', 'render',
  'insert', 'appear', 'incluir', 'inclua', 'incluya', 'adicione', 'adicionar', 'agregue', 'agregar', 'mostre', 'mostrar', 'muestre', 'coloque', 'colocar',
  'ponga', 'poner', 'gere', 'gerar', 'genere', 'generar', 'crie', 'criar', 'cree', 'crear', 'desenhe', 'dibuje', 'insira', 'inserir', 'inserte', 'use', 'usar',
  'tenha', 'tenga', 'apareca', 'aparecer', 'aparezca', 'be', 'ser', 'recreate', 'reproduce', 'invent', 'inventar', 'invente', 'keep', 'manter', 'mantenha',
  'mantener', 'mantenga', 'preserve', 'preservar', 'retain', 'leave', 'deixar', 'deixe', 'dejar', 'deje', 'crop', 'make',
]);
const NEGATING_AUX = new Set(['not', 'dont', 'never', 'nao', 'nunca', 'no', 'sin', 'sem', 'without', 'cannot', 'cant', 'shouldnt', 'mustnt', 'wont']);
/**
 * Palavra que pode ficar entre a negação e o termo ("without ANY OTHER children", "remove all MEN AND kids"). Lugar
 * ("no fundo", "in the background") fica de fora de propósito: em português "no fundo crianças" é "ao fundo".
 */
const SKIPPABLE = new Set([
  'a', 'an', 'the', 'any', 'all', 'every', 'each', 'other', 'others', 'some', 'one', 'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'el', 'la', 'los', 'las', 'un',
  'una', 'unos', 'unas', 'de', 'do', 'da', 'dos', 'das', 'del', 'of', 'e', 'y', 'and', 'or', 'ou', 'qualquer', 'quaisquer', 'cualquier', 'cualquiera', 'todos',
  'todas', 'todo', 'toda', 'outra', 'outras', 'outro', 'outros', 'otra', 'otras', 'otro', 'otros', 'mais', 'more', 'extra', 'additional', 'adicional',
  'adicionais', 'adicionales', 'also', 'tambem', 'tampoco', 'les', 'des', 'du', 'der', 'die', 'den', 'dem', 'il', 'lo', 'gli', 'i', 'le', 'young', 'small',
  'little', 'pequenas', 'pequenos', 'real', 'reais', 'reales', 'only', 'just', 'solo', 'apenas', 'somente', 'completely', 'fully', 'entirely', 'totally',
  'carefully', 'completamente', 'totalmente', 'these', 'those', 'estes', 'estas', 'esses', 'essas', 'estos', 'esos', 'esas', 'aquellos', 'aquelas', 'new',
  'novo', 'nova', 'novos', 'novas', 'nuevo', 'nueva', 'nuevos', 'nuevas', 'another', 'single', 'unico', 'unica',
]);
const PEOPLE = new Set([
  'people', 'persons', 'person', 'men', 'man', 'women', 'woman', 'adults', 'adult', 'everyone', 'everybody', 'someone', 'anyone', 'bystanders', 'humans',
  'human', 'figures', 'crowd', 'strangers', 'pessoas', 'pessoa', 'homens', 'homem', 'mulheres', 'mulher', 'adultos', 'adultas', 'adulto', 'adulta', 'gente',
  'hombres', 'hombre', 'mujeres', 'mujer', 'personas', 'persona', 'multidao', 'multitud', 'estranhos', 'extras', 'animals', 'animais', 'animales', 'pets',
  'dogs', 'cats', 'cachorros', 'perros', 'gatos', 'guys', 'boys', 'girls', 'friends', 'amigos', 'amigas',
]);
const MINOR_VOCAB =
  /^(?:child(?:ren)?|childlike|kids?|bab(?:y|ies)|toddlers?|infants?|newborns?|teens?|teenage|teenagers?|minors?|underage(?:d)?|criancas?|bebes?|nin[oa]s?|menor(?:es)?|adolescentes?|filh[oa]s?|hij[oa]s?|enfants?|kinder|kinderen|bambini|minorenni)$/;
/** Palavra que acompanha o termo num item da lista do que evitar ("teenage appearance", "childlike features"). */
const LIST_DESCRIPTORS = new Set([
  'appearance', 'look', 'looks', 'looking', 'features', 'face', 'faces', 'body', 'bodies', 'proportions', 'style', 'vibe', 'vibes', 'aesthetic', 'traits',
  'characteristics', 'figure', 'figures', 'aparencia', 'apariencia', 'aspecto', 'rosto', 'cara', 'corpo', 'cuerpo', 'traços', 'tracos', 'rasgos', 'like',
]);
const PARENT_WORDS = new Set([
  'has', 'had', 'have', 'having', 'tem', 'teve', 'tenho', 'tinha', 'tiene', 'tuvo', 'tengo', 'tenia', 'mother', 'mom', 'mum', 'mae', 'madre', 'mama', 'mamae',
  'father', 'dad', 'pai', 'padre', 'papa', 'parent', 'parents', 'pais', 'padres',
]);
const SMALL_COUNT = /^(?:\d{1,2}|two|three|four|five|six|dois|duas|tres|quatro|cinco|seis|dos|cuatro)$/;
/** Cabeçalho de lista do que evitar: "avoid: cartoon, underage", "negative prompt: child, teen", "não inclua: …". */
const AVOID_HEADER =
  /(?:^|[^a-z])(?:avoid(?:ing)?|evit(?:ar|e|a)|exclud(?:e|ing)|exclu(?:ir|a|ya)|negative(?:\s+prompts?)?|negativos?|prompt\s+negativo|do\s+not\s+include|don'?t\s+include|nao\s+inclua|no\s+incluyas?|no\s+incluir)\s*:?/g;
/** Depois do termo: condição ("if present", "se houver", "si hay") ou remoção ("are removed", "kids: remove"). */
const REMOVAL_AFTER =
  /^\(?\s*(?:if\s+(?:present|any|visible|there\s+(?:are|is)\s+any)|se\s+(?:houver|tiver|existir|existirem|aparecer|aparecerem|estiverem)|caso\s+(?:haja|existam|existir|aparecam)|si\s+(?:hay|los\s+hay|las\s+hay|aparecen|existen|aparece))\b|^(?:(?:are|is|be|being|get|gets|was|were|have\s+been|has\s+been|had\s+been|must\s+be|should\s+be|will\s+be|to\s+be|sao|serao|foram|foi|devem\s+ser|deve\s+ser|seran|son|fueron|fue|deben\s+ser|debe\s+ser)\s+)?(?:(?:completely|fully|entirely|totally|completamente|totalmente)\s+)?(?:removed|erased|deleted|eliminated|excluded|gone|removid[oa]s?|retirad[oa]s?|apagad[oa]s?|eliminad[oa]s?|excluid[oa]s?|quitad[oa]s?|borrad[oa]s?)\b|^[:\-–—]\s*(?:(?:completely|fully|entirely|totally|carefully|just|only|completamente|totalmente|apenas|solo)\s+)?(?:remove|remova|remover|eliminar|elimine|quitar|quite|borrar|borre|apagar|apague|retirar|retire|erase|delete)\b/;
/** Condição com o termo no meio ("if a child is present, remove only the child"): exceção só se o que vem é tirar a criança. */
const CONDITIONAL_LEAD = new Set(['if', 'se', 'si', 'caso', 'when', 'quando', 'cuando', 'whenever']);
const CONDITIONAL_PRESENT =
  /^\s*(?:is|are|appears?|exists?|shows\s+up|esta|estao|estiver|estiverem|aparece|aparecem|aparecer|houver|hay|existe|existem|estan)\s+(?:present|presente|presentes|visible|visivel|visiveis|visibles|in\s+(?:the\s+)?(?:frame|image|photo|picture|scene)|na\s+(?:foto|imagem|cena)|en\s+(?:la\s+)?(?:foto|imagen|escena))?[\s,]*(?:then\s+)?(?:remove|erase|delete|remova|remover|retire|apague|elimine|eliminar|quite|quitar|borre|borrar)\b(?<rest>[^.;\n]{0,60})/;
/** Roupa e corpo: "if a child is present, remove her clothes" NUNCA é exceção. */
const CLOTHING_OR_BODY =
  /(?<![a-z])(?:cloth\w*|roupa\w*|ropa\w*|dress\w*|vestid\w*|shirt|camis\w*|bikini\w*|biquini\w*|underwear|lingerie|bra|panties|calcinha\w*|top|skirt|saia|falda|pants|calca|jeans|shorts|outfit|uniform\w*|towel|toalha|blanket|her|his|its|their|sua|seu|su|el\s+vestido)(?![a-z])/;

const words = (text: string) => text.split(/[^\p{L}\p{N}']+/u).map((word) => word.replace(/'/g, '')).filter(Boolean);

/**
 * A oração antes do termo nega o termo: negação logo antes, só com artigo/quantificador/pessoa/outro termo no meio.
 * `sameKind` pula outros termos do mesmo tipo ("no illustration, cartoon or CGI").
 */
function negatedBefore(clause: string, sameKind: (word: string) => boolean = (word) => MINOR_VOCAB.test(word)): 'negation' | 'removal' | null {
  const list = words(clause);
  let skipped = 0;
  for (let index = list.length - 1; index >= 0 && skipped <= 8; index--) {
    const word = list[index];
    if (NEGATORS.has(word)) return 'negation';
    if (REMOVAL_VERBS.has(word)) return 'removal';
    if (ACTION_VERBS.has(word)) return negatedAction(list, index) ? 'negation' : null;
    if (SKIPPABLE.has(word) || PEOPLE.has(word) || sameKind(word)) {
      skipped++;
      continue;
    }
    return null;
  }
  return null;
}

/** Entre a negação e o verbo só cabe auxiliar, pronome, conjunção e outro verbo da mesma ordem. */
const VERB_FILLERS = new Set([
  'do', 'does', 'did', 'to', 'should', 'must', 'will', 'would', 'can', 'could', 'her', 'him', 'them', 'it', 'me', 'you', 'the', 'a', 'an', 'any', 'or', 'and',
  'e', 'ou', 'y', 'o', 'in', 'out', 'up', 'ever', 'also', 'please', 'se', 'lhe', 'la', 'lo', 'le', 'los', 'las', 'les', 'os', 'as', 'there', 'deve', 'debe',
  'pode', 'puede',
]);

/**
 * O verbo de ação está negado: "do not include", "never show", "do not make her appear underage", "do not keep,
 * crop-in, or recreate any kid". "no blur, make the kids naked" NÃO é negação (o "no" é de outra coisa).
 */
function negatedAction(list: readonly string[], verbIndex: number): boolean {
  for (let back = verbIndex - 1, steps = 0; back >= 0 && steps < 6; back--, steps++) {
    const word = list[back];
    if (NEGATING_AUX.has(word)) return true;
    if (ACTION_VERBS.has(word) || VERB_FILLERS.has(word)) continue;
    return false;
  }
  return false;
}

/** "mother of 2 kids", "has had 2 kids", "mãe de 3 filhos": as crianças não estão na cena. */
function familySize(clause: string): boolean {
  const list = words(clause);
  const last = list.length - 1;
  if (last < 1 || !SMALL_COUNT.test(list[last])) return false;
  return list.slice(Math.max(0, last - 3), last).some((word) => PARENT_WORDS.has(word));
}

/** Item de uma lista "avoid:/negative prompt:" que só tem o termo (e outros termos do mesmo tipo). */
function inAvoidList(clause: string, rest: string, sameKind: (word: string) => boolean = (word) => MINOR_VOCAB.test(word)): boolean {
  let header = -1;
  for (const match of clause.matchAll(AVOID_HEADER)) header = (match.index ?? 0) + match[0].length;
  if (header === -1) return false;
  const between = clause.slice(header);
  // cada item da lista é curto e o termo abre um item novo
  const items = between.split(/[,/|]|\band\b|\bor\b|\be\b|\bou\b|\by\b/);
  if (items.some((item) => words(item).length > 4)) return false;
  if (words(items[items.length - 1]).some((word) => !SKIPPABLE.has(word) && !sameKind(word))) return false;
  // o item do termo termina sem outra palavra ("teen girl nude" não é item de lista de evitar; "teenage appearance" é)
  const own = rest.split(/[,;.!?\n/|]/)[0];
  return words(own).every((word) => SKIPPABLE.has(word) || LIST_DESCRIPTORS.has(word) || sameKind(word));
}

/** Depois do termo, pulando outros termos de menor e conectores, vem condição ou remoção. */
function removedAfter(rest: string): boolean {
  let tail = rest;
  // pula outros termos de menor e conectores; depois de "or/and" cabe um item curto ("kids or jewelry are removed")
  let shortItem = 1;
  let afterConjunction = false;
  for (;;) {
    const lead = /^[\s,/&]*(?:(and|or|e|ou|y|o)\b|([\p{L}]+))?/u.exec(tail);
    if (!lead || !lead[0].length) break;
    const word = lead[1] ?? lead[2];
    if (word && !lead[1] && !MINOR_VOCAB.test(word)) {
      if (afterConjunction && shortItem > 0 && !REMOVAL_AFTER.test(tail.trimStart())) {
        shortItem--;
        afterConjunction = false;
        tail = tail.slice(lead[0].length);
        continue;
      }
      tail = tail.slice(lead[0].length - word.length);
      break;
    }
    afterConjunction = Boolean(lead[1]);
    tail = tail.slice(lead[0].length);
  }
  const trimmed = tail.trimStart();
  const match = REMOVAL_AFTER.exec(trimmed);
  if (!match) return false;
  // "kids: remove her clothes" tira a roupa, não a criança
  return !CLOTHING_OR_BODY.test(trimmed.slice(match[0].length).split(/[.;!?\n]/)[0].slice(0, 60));
}

/** O que vem logo depois do termo é roupa ou corpo dele ("remove the kids' clothes"): a remoção não é da criança. */
const OWN_CLOTHING_OR_BODY =
  /^\s*(?:'s|s'|')?\s*(?:cloth\w*|outfits?|dress\w*|shirts?|pants|underwear|bras?|panties|bikinis?|uniforms?|bod(?:y|ies)|skin|roupa\w*|ropa\w*|vestid\w*|biquini\w*|corpo\w*|cuerpo\w*|pele|piel)(?![a-z])/;

/** "if a child is present, remove only the child": condição de presença seguida de tirar a criança (nunca a roupa). */
function conditionalRemoval(clause: string, rest: string): boolean {
  const list = words(clause);
  let index = list.length - 1;
  while (index >= 0 && SKIPPABLE.has(list[index])) index--;
  if (index < 0 || !CONDITIONAL_LEAD.has(list[index])) return false;
  const match = CONDITIONAL_PRESENT.exec(rest);
  return Boolean(match && !CLOTHING_OR_BODY.test(match.groups?.rest ?? ''));
}

/** O termo de comparação de idade ("under 18", "menos de 18") vem negado ("no one under 18", "ninguém menor de 18"). */
const COMPARATIVE_AGE = /^(?:under|below|sub|menos de|menor(?:es)? (?:de|que)|abaixo de|younger than|less than|por debajo de)\b/;

/**
 * Toda ocorrência escrita do termo é negação, lista do que evitar, tamanho de família ou (em pedido sem conteúdo
 * adulto) remoção/condição? Então devolve o texto com elas apagadas (para conferir o resto); senão, null. Termo que
 * só aparece ofuscado ("k.i.d.s") nunca é exceção. Foto com criança em pedido de nudez é recusada mesmo com
 * "remova a criança": o modelo trabalha a foto inteira.
 */
function maskIfExempt(text: string, term: string, isAge: boolean, adultRequest: () => boolean): string | null {
  const flat = flatten(text);
  const wanted = canonical(term).replace(/[^a-z0-9 ]+/g, ' ').trim();
  if (!wanted) return null;
  if (isAge && !COMPARATIVE_AGE.test(wanted)) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${wanted.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\p{P}]+')}(?![\\p{L}\\p{N}])`, 'gu');
  const spans: Array<[number, number]> = [];
  for (const match of flat.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!occurrenceExempt(flat, start, end, isAge, adultRequest)) return null;
    spans.push([start, end]);
  }
  if (!spans.length) return null;
  return blank(text, spans);
}

/** A ocorrência em [start, end) do texto achatado é negação, lista do que evitar, família ou remoção permitida. */
function occurrenceExempt(flat: string, start: number, end: number, isAge: boolean, adultRequest: () => boolean): boolean {
  const clause = flat.slice(Math.max(0, start - 160), start).split(/[.!?;\n]/).pop() ?? '';
  const rest = flat.slice(end, end + 120);
  const kind = OWN_CLOTHING_OR_BODY.test(rest) ? null : negatedBefore(clause);
  if (kind === 'negation') return true;
  if (!isAge && (familySize(clause) || inAvoidList(clause, rest))) return true;
  // remoção e condição só valem em pedido sem conteúdo adulto (a leitura de conteúdo adulto só roda neste caso)
  if (kind === 'removal' || (!isAge && (removedAfter(rest) || conditionalRemoval(clause, rest)))) return !adultRequest();
  return false;
}

function blank(text: string, spans: ReadonlyArray<[number, number]>): string {
  let out = text;
  for (const [start, end] of spans) out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  return out;
}

/** Termos de menor escritos por extenso (texto achatado), para tirar de uma vez os que são exceção. */
const LITERAL_MINOR =
  /(?<![\p{L}\p{N}])(?:child(?:ren)?|childlike|kids?|bab(?:y|ies)|toddlers?|infants?|newborns?|teens?|teenage|teenagers?|minors?|underaged?|criancas?|bebes?|nin[oa]s?|menor(?:es)?(?:\s+de\s+idade)?|adolescentes?|enfants?|filh[oa]s?|hij[oa]s?)(?![\p{L}\p{N}])/gu;

/**
 * Apaga de uma vez cada ocorrência de termo de menor que é exceção ("no kids", "avoid: underage", "mother of 2
 * kids"). Prompt longo de edição traz dez negações; sem isto, cada uma custaria uma conferência inteira a mais.
 * Ocorrência que não é exceção fica e é pega pela conferência.
 */
function premaskExempt(text: string, adultRequest: () => boolean): string {
  const flat = flatten(text);
  const spans: Array<[number, number]> = [];
  for (const match of flat.matchAll(LITERAL_MINOR)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (occurrenceExempt(flat, start, end, false, adultRequest)) spans.push([start, end]);
  }
  return spans.length ? blank(text, spans) : text;
}

/* ------------------------------------------------------------------ estilo desenhado e "secundária" */

/** Estilo desenhado: aí pista infantil de corpo/estilo (petite, cute, pigtails) também barra (regra do construtor). */
const DRAWN_STYLE =
  /(?<![a-z])(?:anime|hentai|manga|manhwa|cartoon|toon|chibi|waifu|pixar|disney|dreamworks|pin ?up|comic|ilustra\w*|illustration|desenho|dibujo|caricatura|cel ?shad\w*|3d render|3d model|cgi|vtuber)(?![a-z])/g;

/** Palavra de estilo (desenhado ou o que costuma vir junto na lista do que evitar: "no illustration, painting or CGI"). */
const STYLE_WORD =
  /^(?:anime|hentai|manga|manhwa|cartoons?|cartoonish|toon|toons|chibi|waifu|pixar|disney|dreamworks|pin|up|pinup|comic|comics|ilustra\w*|illustrations?|illustrated|desenhos?|dibujos?|caricatura|cel|shading|3d|2d|render|renders|rendered|renderings?|model|cgi|vtuber|look|style|estilo|painting|paintings|drawing|drawings|art|artwork|digital|plastic|doll|fake|smooth|airbrushed|filter|filters|effect|effects|vibes?)$/;

/** Estilo que é desenho por definição (hentai, waifu, chibi, "anime girl", "estilo anime"): vale até com "realistic". */
const STRONG_DRAWN =
  /(?<![a-z])(?:hentai|waifu|chibi|manga|manhwa|vtuber|ecchi|cel ?shad\w*|anime (?:girl|style|character|art|woman|waifu|aesthetic|version|illustration)|cartoon (?:girl|character|style|version)|(?:in|em|en) (?:anime|cartoon|manga|comic) style|estilo (?:anime|cartoon|desenho|manga|hq|quadrinhos))(?![a-z])/g;
/**
 * Pedido de foto realista: aí "cartoon", "CGI", "illustration", "3D render" são quase sempre a lista do que evitar
 * (medido nos prompts reais), não o estilo pedido.
 */
const REALISM =
  /(?<![a-z])(?:photo ?realis\w*|hyper ?realis\w*|ultra ?realis\w*|realistic|realista|realism|realismo|photograph\w*|fotograf\w*|raw photo|real photo|foto real|smartphone|iphone|selfie|dslr|mirrorless|bokeh|pores|poros|film grain|candid|amateur photo|ugc)(?![a-z])/;

function hasUnnegated(flat: string, pattern: RegExp): boolean {
  const styleKind = (word: string) => STYLE_WORD.test(word);
  for (const match of flat.matchAll(pattern)) {
    const start = match.index ?? 0;
    const clause = flat.slice(Math.max(0, start - 160), start).split(/[.!?;\n]/).pop() ?? '';
    const rest = flat.slice(start + match[0].length, start + match[0].length + 60);
    if (negatedBefore(clause, styleKind) === null && !inAvoidList(clause, rest, styleKind)) return true;
  }
  return false;
}

/** Desenhado de verdade: estilo de desenho pedido, sem negação, e (fora os estilos que são desenho por definição) sem pedido de foto realista. */
function isDrawnStyle(text: string): boolean {
  const flat = flatten(text);
  if (hasUnnegated(flat, STRONG_DRAWN)) return true;
  if (REALISM.test(flat)) return false;
  return hasUnnegated(flat, DRAWN_STYLE);
}

/**
 * "secundária" é português comum (cor, luz, personagem); em espanhol "secundaria" é a escola. Passa só quando cada
 * ocorrência vem logo depois de uma palavra da lista; "de secundaria", "chicas secundaria" e "ensino secundário" barram.
 */
const SECUNDARIA_TERM = /^secundari[ao]s?$/;
const SECUNDARIA_OK = new Set([
  'cor', 'cores', 'color', 'colores', 'luz', 'luzes', 'luces', 'iluminacao', 'iluminacion', 'personagem', 'personagens', 'personaje', 'personajes', 'papel',
  'papeis', 'rol', 'roles', 'cena', 'cenas', 'escena', 'escenas', 'plano', 'planos', 'fonte', 'fontes', 'fuente', 'fuentes', 'tom', 'tons', 'tono', 'tonos',
  'sombra', 'sombras', 'camera', 'camara', 'angulo', 'elemento', 'elementos', 'objeto', 'objetos', 'detalhe', 'detalhes', 'detalle', 'detalles', 'foco',
  'acao', 'accion', 'efeito', 'efeitos', 'efecto', 'efectos', 'opcao', 'opcion', 'linha', 'linea', 'paleta', 'tonalidade', 'tonalidad', 'nota', 'notas',
  'imagem', 'imagen', 'imagens', 'imagenes', 'referencia', 'referencias', 'figura', 'figuras', 'forma', 'formas', 'camada', 'capa', 'textura', 'texturas',
  'via', 'vias', 'saida', 'salida', 'entrada', 'fase', 'etapa', 'tarefa', 'tarea', 'funcao', 'funcion', 'tela', 'pantalla', 'janela', 'ventana', 'area',
  'zona', 'regiao', 'region', 'rua', 'calle', 'estrada', 'carretera', 'cor-de', 'importancia', 'prioridade', 'prioridad', 'atriz', 'actriz', 'ator', 'actor',
  'modelo', 'modelos', 'pose', 'poses', 'posicao', 'posicion', 'expressao', 'expresion', 'roupa', 'ropa', 'peca', 'pieza', 'arma', 'mao', 'mano',
]);

function maskSecundaria(text: string): string | null {
  const flat = flatten(text);
  const spans: Array<[number, number]> = [];
  for (const match of flat.matchAll(/(?<![\p{L}\p{N}])secundari[ao]s?(?![\p{L}\p{N}])/gu)) {
    const start = match.index ?? 0;
    const previous = words(flat.slice(Math.max(0, start - 40), start)).pop();
    if (!previous || !SECUNDARIA_OK.has(previous)) return null;
    spans.push([start, start + match[0].length]);
  }
  if (!spans.length) return null;
  let out = text;
  for (const [start, end] of spans) out = out.slice(0, start) + ' '.repeat(end - start) + out.slice(end);
  return out;
}

/* ------------------------------------------------------------------ conferência */

export function assessText(text: string | null | undefined): MinorAssessment {
  if (!text || typeof text !== 'string') return { blocked: false };
  const source = text.trim();
  if (!source) return { blocked: false };
  if (source.length > MAX_TEXT_SCAN) return { blocked: true, reason: 'size' };

  const script = checkScripts(source);
  if (script) return script;

  let working = prepare(source);
  // pedido de conteúdo adulto: aí "remova a criança" não é exceção (só negação e lista do que evitar)
  let adult: boolean | undefined;
  const adultRequest = () => (adult ??= hasAdultTerms(working));
  // outras línguas latinas: cada ocorrência negada/removida sai do texto; a primeira que não é exceção barra
  {
    const flat = flatten(working);
    const spans: Array<[number, number]> = [];
    for (const match of flat.matchAll(LATIN_EXTRA)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!occurrenceExempt(flat, start, end, false, adultRequest)) return { blocked: true, reason: 'term', match: match[1] };
      spans.push([start, end]);
    }
    if (spans.length) working = blank(working, spans);
  }

  working = premaskExempt(working, adultRequest);

  // "16F", "16 f", "[F16]": idade com sexo, mesmo colado ao resto da frase ("16F nude")
  const sexAge = /(?<![\p{L}\p{N}])(1[0-7])\s?f(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])f\s?(1[0-7])(?![\p{L}\p{N}])/u.exec(flatten(working));
  if (sexAge) return { blocked: true, reason: 'age', match: sexAge[0] };

  const drawn = isDrawnStyle(working);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const verdict = checkAdultOnly(working, { adult: true, drawn, lookalike: false, floor: AGE_FLOOR, free: true });
    if (verdict.ok) return { blocked: false };
    // no pedido livre só sobram estes motivos ('lookalike' desligado, 'override' e 'adultOnCommerce' não se aplicam)
    if (verdict.reason !== 'minor' && verdict.reason !== 'childlike' && verdict.reason !== 'drawnTerm') return { blocked: false };
    const term = verdict.term;
    const isAge = AGE_LIKE.test(term);
    const masked = SECUNDARIA_TERM.test(canonical(term).trim()) ? maskSecundaria(working) : maskIfExempt(working, term, isAge, adultRequest);
    if (masked === null || masked === working) return { blocked: true, reason: isAge ? 'age' : 'term', match: term.slice(0, 80) };
    working = masked;
  }
  return { blocked: true, reason: 'term', match: 'conferência sem conclusão' };
}

/**
 * O texto pede para TIRAR criança da imagem ("remove the children", "kids, if present: remove", "if a child is present,
 * remove only the child")? É a mesma leitura (e o mesmo vocabulário) da exceção de remoção da conferência, usada pela
 * regra E6 da segurança de imagem: pedido de remoção + rosto de provável menor na foto. Negação ("no kids"), lista do
 * que evitar, tamanho de família e remoção negada ("do not remove the kids") não contam; tirar a roupa da criança não é
 * tirar a criança (isso a conferência barra). Só o termo escrito por extenso conta, como na exceção. Função pura.
 */
export function mentionsMinorRemoval(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  const source = text.trim();
  if (!source) return false;
  const flat = flatten(prepare(source.slice(0, MAX_TEXT_SCAN)));
  for (const match of flat.matchAll(LITERAL_MINOR)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const clause = flat.slice(Math.max(0, start - 160), start).split(/[.!?;\n]/).pop() ?? '';
    const rest = flat.slice(end, end + 120);
    // mesma ordem da conferência: negação, lista do que evitar e família vêm antes da remoção
    const kind = OWN_CLOTHING_OR_BODY.test(rest) ? null : negatedBefore(clause);
    if (kind === 'negation' || familySize(clause) || inAvoidList(clause, rest)) continue;
    if (kind === 'removal') {
      if (!removalVerbNegated(clause)) return true;
      continue;
    }
    if (removedAfter(rest) || conditionalRemoval(clause, rest)) return true;
  }
  return false;
}

/** O verbo de remoção logo antes do termo vem negado ("do not remove the kids", "nunca apague as crianças"). */
function removalVerbNegated(clause: string): boolean {
  const list = words(clause);
  for (let index = list.length - 1; index >= 0; index--) {
    if (REMOVAL_VERBS.has(list[index])) return negatedAction(list, index);
  }
  return false;
}

/* ------------------------------------------------------------------ corpo da requisição */

/**
 * Campos que nunca são texto livre do usuário (tipo de arquivo, tokens, assinaturas, ids). Imagens e vídeos não
 * entram por nome de campo: o valor é URL ou base64 e cai em `looksBinaryOrUrl`.
 */
const SKIP_KEY = /(mime|token|signature|hash|^id$|_id$|Id$)/i;
/**
 * Prompt negativo lista o que o modelo deve EVITAR ("child, teen, underage" é boa prática, não pedido): não é lido
 * como pedido de menor.
 */
const NEGATIVE_KEY = /negative/i;
/** Campos de texto livre: são lidos sempre, mesmo que o valor comece com URL ou pareça base64. */
const TEXT_KEY = /(prompt|text|script|caption|description|instruction|message|title|name|tag|style|lyrics|query)/i;
const URL_PREFIX = /^(?:data:|https?:\/\/|blob:)/i;

/** URL, ou base64 de arquivo de verdade: longo, sem espaço e com maiúscula, minúscula e dígito (texto não é assim). */
function looksBinaryOrUrl(value: string): boolean {
  const trimmed = value.trim();
  if (URL_PREFIX.test(trimmed) && !/\s/.test(trimmed)) return true;
  if (trimmed.length < 1000 || /\s/.test(trimmed)) return false;
  const head = trimmed.slice(0, 1000);
  return /^[A-Za-z0-9+/=_-]+$/.test(head) && /[A-Z]/.test(head) && /[a-z]/.test(head) && /\d/.test(head);
}

const MAX_DEPTH = 6;
const MAX_ARRAY = 200;
/** Teto do corpo inteiro (a guarda roda antes da validação do DTO, sobre corpo de até 200 MB). Acima: recusa. */
const MAX_STRINGS = 256;
const MAX_TOTAL_CHARS = 120_000;
/** Campo de idade solto ({"age": 15}, {"idade": "14"}): vira "age 15" para a conferência de idade. */
const AGE_KEY = /^(?:age|aged|idade|edad|years_?old|anos)$/i;

class BodyTooLarge extends Error {}

/** Junta os textos livres de um corpo de requisição (prompt, script…) até 6 níveis; o prompt negativo fica de fora. */
export function collectTexts(body: unknown, depth = 0, out: string[] = [], textField = false): string[] {
  if (body == null) return out;
  if (depth > MAX_DEPTH) throw new BodyTooLarge();
  if (typeof body === 'string') {
    if (textField || !looksBinaryOrUrl(body)) {
      out.push(body);
      if (out.length > MAX_STRINGS) throw new BodyTooLarge();
    }
    return out;
  }
  if (Array.isArray(body)) {
    if (body.length > MAX_ARRAY) throw new BodyTooLarge();
    for (const item of body) collectTexts(item, depth + 1, out, textField);
    return out;
  }
  if (typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (SKIP_KEY.test(key) || NEGATIVE_KEY.test(key)) continue;
      if (AGE_KEY.test(key) && (typeof value === 'number' || (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)))) {
        out.push(`age ${String(value).trim()}`);
        continue;
      }
      collectTexts(value, depth + 1, out, TEXT_KEY.test(key));
    }
  }
  return out;
}

export function assessBody(body: unknown): MinorAssessment {
  let texts: string[];
  try {
    texts = collectTexts(body);
  } catch (error) {
    if (error instanceof BodyTooLarge) return { blocked: true, reason: 'size' };
    throw error;
  }
  let total = 0;
  for (const text of texts) {
    total += text.length;
    if (total > MAX_TOTAL_CHARS) return { blocked: true, reason: 'size' };
  }
  for (const text of texts) {
    const result = assessText(text);
    if (result.blocked) return result;
  }
  return { blocked: false };
}
