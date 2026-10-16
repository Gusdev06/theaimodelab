/**
 * CÓPIA da trava do site (FUNVMAKE/web/lib/influencer-safety.ts, v3 de 15/10/2026, red team de 8 lentes e corpus de
 * 1.099 casos em __tests__/safety-corpus.json). Mudou lá, muda aqui. Adaptações para a API (sem elas, o comportamento
 * é o do construtor, conferido pelo corpus):
 *  - `floor`: piso de idade (padrão 25 como no construtor; a API usa 18, a idade legal de toda geração);
 *  - `free`: pedido livre de geração. Medido em 16/10 contra os 50.433 prompts reais do backup de 11/10, o modo do
 *    construtor recusava 11,8% das gerações ("tiny blemishes", "fazendo uma pose", "only one woman", "seed": 1,
 *    "turned three-quarters"). No modo livre: artigo não é número ("um vestido", "one woman"), número seguido de coisa
 *    contada não é idade ("2 women", "1 metro"), verbo vago ("only", "about", "face") só vale com o número fechando o
 *    trecho, número sozinho só com pessoa ou nome antes, pista infantil de corpo/estilo (petite, tiny, braces) só
 *    barra no desenhado ou com 3 pistas juntas e "early twenties" deixa de barrar (piso 18);
 *  - unidades de idade em francês, alemão, italiano e holandês ("15 ans", "15 Jahre", "15 anni", "15 jaar").
 *
 * Original:
 * Trava dos textos livres do construtor de modelo (nome, nicho e detalhes): a modelo é sempre adulta (25+), nunca
 * "parecida com" uma pessoa real e, no lado de vender, nunca conteúdo adulto. Roda na tela (erro na hora e Gerar
 * desligado), dentro do prompt (texto barrado não entra) e na leitura de escolhas vindas de fora (?look=, ficha
 * guardada). É só a camada da tela: a mesma regra precisa existir na API (TKT-125).
 *
 * O texto passa por uma forma canônica antes da conferência (NFKC, sem caracteres invisíveis, dígitos de qualquer
 * alfabeto em 0-9, indicadores regionais e letras de outros alfabetos trocadas pelas latinas, sem acento, emoji e
 * símbolo tirados de dentro da palavra). Os termos são procurados em várias versões: com espaços, sem separadores
 * ("l.o.l.i", "t:e:e:n"), com letras soltas juntadas ("t e e n"), com troca de número por letra só colada a letra
 * ("l0li", mas não "mãe de 3 filhos") e com letra repetida encurtada ("teeeen"). Revisada em 15/10 por um red team de
 * 8 lentes (gíria pt/en/es, ofuscação, idade, pessoa real, lado de vender, prompts e falso positivo).
 */

export type SafetyReason = 'minor' | 'lookalike' | 'drawnTerm' | 'childlike' | 'adultOnCommerce' | 'override';

export type SafetyVerdict = { ok: true } | { ok: false; reason: SafetyReason; term: string };

export interface SafetyOptions {
  /** estilo desenhado (anime, hentai, 3D, pin-up): palavras que puxam o traço para infantil também barram */
  drawn?: boolean;
  /** objetivo 18+ (a TAML é sempre 18+): criança na cena e pistas infantis barram em qualquer estilo */
  adult?: boolean;
  /** false = não confere pedido de pessoa real (o nome da modelo, que não vai para o prompt) */
  lookalike?: boolean;
  /** rótulo que não vai para o prompt (nome, nicho): no lado de vender só os termos duros contam */
  label?: boolean;
  /** idade mínima escrita no texto (padrão 25, o piso do construtor de modelo; a API usa 18) */
  floor?: number;
  /** pedido livre de geração (API): leitura de idade e pistas infantis calibradas para prompt de verdade */
  free?: boolean;
}

const OK: SafetyVerdict = { ok: true };
const CURRENT_YEAR = new Date().getFullYear();

/* ------------------------------------------------------------------ forma canônica */

/** Letras de outros alfabetos (e variantes latinas) que parecem latinas. */
const CONFUSABLES: Record<string, string> = {
  // cirílico
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', һ: 'h', ԁ: 'd', ӏ: 'l', ѵ: 'v', ԛ: 'q', ԝ: 'w',
  // grego
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y', ω: 'w', ϲ: 'c', ς: 'c', ϳ: 'j',
  // latim estendido, IPA e versaletes (o NFKC não mexe nelas)
  ı: 'i', ȷ: 'j', ɑ: 'a', ɡ: 'g', ɩ: 'i', ɪ: 'i', ʟ: 'l', ɴ: 'n', ɢ: 'g', ʀ: 'r', ʏ: 'y', ʜ: 'h', ʙ: 'b', ᴀ: 'a', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ꜰ: 'f', ᴊ: 'j', ᴋ: 'k',
  ᴍ: 'm', ᴏ: 'o', ᴘ: 'p', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ᴢ: 'z', ꜱ: 's', ɾ: 'r', ɫ: 'l', ł: 'l', đ: 'd', ð: 'd', ø: 'o', ħ: 'h', ŧ: 't', ß: 'ss', æ: 'ae', œ: 'oe', ŋ: 'n',
  // armênio
  օ: 'o', ս: 'u', ց: 'g', հ: 'h', ո: 'n', ա: 'w', զ: 'q', ռ: 'n',
  // cheroqui (maiúsculas que parecem latinas; as minúsculas entram logo abaixo)
  Ꭰ: 'd', Ꭱ: 'r', Ꭲ: 't', Ꭹ: 'y', Ꭺ: 'a', Ꭻ: 'j', Ꭼ: 'e', Ꭽ: 'n', Ꮃ: 'w', Ꮇ: 'm', Ꮋ: 'h', Ꮐ: 'g', Ꮓ: 'z', Ꮪ: 's', Ꮯ: 'c', Ꮲ: 'p', Ꮶ: 'k', Ꮮ: 'l', Ꮩ: 'v', Ᏼ: 'b', Ꮼ: 'e',
};
for (const [char, latin] of Object.entries(CONFUSABLES)) {
  const lower = char.toLowerCase();
  if (lower !== char && !(lower in CONFUSABLES)) CONFUSABLES[lower] = latin;
}

const INVISIBLE = /[\p{Cf}͏ᅟᅠㅤﾠ⠀᠎឴឵]/gu;
/** Emoji e símbolo gráfico (©, ®, ™, tom de pele, seletor de variação, keycap, bandeira por etiqueta). */
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
const REGIONAL = /[\u{1F1E6}-\u{1F1FF}]/gu;
const APOSTROPHES = /[\u2018\u2019\u201B\u2032\u0060\u00B4\u02BC\u02B9]/g;
/** Depois da forma canônica, tudo que não é letra, dígito ou espaço é separador. */
const SEPARATORS = /[^a-z0-9\s]+/g;
/** Primeiro dígito (0) de cada bloco de algarismos não latinos (árabe-índico, devanágari, tailandês…). */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810,
  0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10,
];

function mapDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x39) return char;
    const zero = DIGIT_ZEROS.find((start) => code >= start && code < start + 10);
    return zero === undefined ? char : String(code - zero);
  });
}

function mapConfusables(text: string): string {
  let out = '';
  for (const char of text) out += CONFUSABLES[char] ?? char;
  return out;
}

/** NFKC, sem invisíveis, dígitos e letras trocados, minúsculas, sem acento (os pictográficos ainda estão no texto). */
export function canonical(text: string): string {
  const folded = mapConfusables(mapDigits(text.normalize('NFKC').replace(INVISIBLE, '')).replace(REGIONAL, (char) => String.fromCharCode((char.codePointAt(0) ?? 0) - 0x1f1e6 + 97)));
  return mapConfusables(folded.toLowerCase()).normalize('NFKD').replace(/\p{M}/gu, '').replace(APOSTROPHES, "'");
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '+': 't', '!': 'i', '|': 'l' };
const fromLeet = (run: string) => [...run].map((char) => LEET[char] ?? char).join('');

/**
 * Troca de número/símbolo por letra usada para driblar filtro, só colada a letra: dentro da palavra ("l0li", "t33n"),
 * no começo ("$choolgirl", "+een") e no fim ("novinh4"). Número solto ("mãe de 3 filhos") e "lol!" ficam como estão.
 */
function unLeet(text: string): string {
  return text
    .replace(/(?<=[a-z])[0134578@$+!|]+(?=[a-z])/g, fromLeet)
    .replace(/(?<![a-z0-9])[034578@$+]+(?=[a-z])/g, fromLeet)
    .replace(/(?<=[a-z])[034578$]+(?![a-z0-9])/g, fromLeet);
}

/** Letras soltas em sequência viram palavra: "t e e n" → "teen". */
function joinLetters(text: string): string {
  return text.replace(/(?:^|(?<=\s))(?:[a-z0-9]\s+){2,}[a-z0-9](?=\s|$)/g, (run) => run.replace(/\s+/g, ''));
}

/** Letra repetida 3+ vezes vira 2 ("teeeen" → "teen"). */
const squeeze = (text: string) => text.replace(/([a-z])\1{2,}/g, '$1$1');

/** As versões do texto onde os termos são procurados. */
function variants(text: string): string[] {
  const base = canonical(text);
  const out = new Set<string>();
  // emoji/símbolo no meio da palavra junta ("lin🔥gerie"); entre palavras separa ("loira🔥sexy")
  for (const form of [base.replace(PICTOGRAPHIC, ''), base.replace(PICTOGRAPHIC, ' ')]) {
    for (const leet of [form, unLeet(form)]) {
      const spaced = leet.replace(SEPARATORS, ' ').replace(/\s+/g, ' ').trim();
      const joined = leet.replace(SEPARATORS, '').replace(/\s+/g, ' ').trim();
      for (const value of [spaced, joined, joinLetters(spaced)]) {
        out.add(value);
        out.add(squeeze(value));
      }
    }
  }
  return [...out];
}

/** Só o texto que pode ir ao prompt: sem invisíveis e sem emoji/símbolo. */
function cleanForPrompt(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(PICTOGRAPHIC, '').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ listas (regex sobre o texto canônico) */

/** Termo que aceita espaço entre as letras ("te en", "se xy", "ani tta"); a borda da palavra continua valendo. */
const gapped = (word: string) => [...word].join('\\s?');

/** Menor de idade sexualizado, idade abaixo do piso e roupa íntima infantil: barra sempre, em todo campo e objetivo. */
const MINOR_HARD = [
  'lol+i(?!pop)\\w*',
  gapped('loli'),
  'lolicon',
  'shota\\w*',
  'pedo(?!met)\\w*',
  gapped('pedo'),
  'jail ?bait\\w*',
  'barely ?legal',
  'barely (?:18|eighteen)',
  'just legal',
  'fresh (?:18|eighteen)',
  '(?:18|eighteen) and legal',
  'newly legal',
  'legal ?teens?',
  'under ?aged?',
  'below (?:the )?(?:legal )?age',
  'not (?:yet )?(?:of age|legal|an? adult|adult)',
  'nao (?:e|eh) (?:uma )?(?:adulta|maior de idade)',
  'no es (?:una )?(?:adulta|mayor de edad)',
  'nao (?:tem|atingiu) (?:18|dezoito|a maioridade)',
  'antes da maioridade',
  'quase (?:maior de idade|de maior|adulta)',
  'almost (?:legal|an adult)',
  'nymph(?:et|ette)\\w*',
  'ninfet\\w*',
  gapped('ninfeta'),
  'novi+nh\\w*',
  gapped('novinha'),
  'novin',
  'novynh\\w*',
  'menorzinh\\w*',
  'menorcit\\w*',
  'minor ?looking',
  'menor(?:es)? de (?:idade|edad)',
  'menor (?:d|di) ?idade',
  'menoridade',
  'dimenor',
  'dmenor',
  'di menor',
  'd menor',
  'de menor(?! (?:preco|precos|custo|custos|valor|valores|tamanho|tamano|peso|consumo|risco|prazo|tempo|estatura|volume|quantidade|calibre|porte|intensidade|impacto|qualidade|nivel|grau|densidade|duracao|duracion|price|cost|size))',
  'um menor',
  'un menor',
  'uma menor',
  'una menor(?! (?:detalle|cicatriz|parte))',
  'minors',
  '(?:a|is a|she is a|shes a|he is a|hes a) minor(?! (?:scar|detail|flaw|imperfection|blemish|mark|change|edit|tweak|issue|key|chord|league|role|part))',
  'vitima menor',
  // a própria modelo como criança ("ela é uma menina de 12", "she is a kid")
  '(?:^|(?:ela|she|ella|eu|yo|i|the model|a modelo|la modelo|my model|minha modelo|personagem|character) )(?:e|eh|es|is|sou|soy|am|seria|sera|would be|will be|parece|looks like|seems) (?:uma |una |a |an )?(?:crianca|child|kid|menina|garotinha|nina|minor|menor|toddler|bebe|baby)(?! (?:de \\d{2}|at heart|interior|por dentro|face|faced))',
  '(?:im|i m) (?:a |an )?(?:kid|child|minor|baby|toddler|teen\\w*)',
  'age ?play\\w*',
  'ddlg',
  'little ?space',
  'daddy ?s little (?:girl|princess)',
  'daddys little',
  'child (?:porn\\w*|abuse|sex\\w*|model\\w*)',
  'csam',
  'pre ?teen\\w*',
  'tween\\w*',
  'pubescen\\w*',
  'pre ?pube\\w*',
  'pubert\\w*',
  'puberdade',
  'pubertad\\w*',
  'puber(?:es)?',
  'puberta\\w*',
  'just turned (?:18|19|eighteen|nineteen)',
  '(?:acabou|acaba|acabadinha|recem|recien|mal) (?:de )?(?:fazer|cumplir|completar|fez|completou|cumplio|cumplidos?|completados?|feitos?) (?:os |las |los )?(?:18|19|dezoito|dieciocho|dezenove|diecinueve)',
  '(?:18|19|dezoito|dezenove) (?:acabados|recem|recien) (?:de fazer|feitos|cumplidos)',
  'early (?:20s|20 s|twenties)',
  'in (?:her|his|their) (?:late |early |mid )?teens',
  'veintipocos',
  '(?:20|vinte) e poucos',
  'gen(?:eration|eracao|eracion)? ?(?:alpha|alfa)',
  'sweet ?(?:16|sixteen|dieciseis|dezesseis)',
  'quinceaner\\w*',
  // roupa íntima ou de banho infantil (o gerador pode pôr uma criança vestindo a peça)
  '(?:roupa intima|roupas intimas|moda intima|moda praia|cueca|cuecas|calcinha|calcinhas|underwear|swimwear|swimsuits?|maio|maios|biquinis?|bikinis?|sungas?|traje de bano|trajes de bano|banadores?|ropa interior|lingerie|undies|panties|bras?|briefs|bragas) (?:\\w+ )?(?:infantil|infantis|de crianca|para crianca|de criancas|para criancas|kids?|children s?|childrens|nin[ao]s|para nin[ao]s|de nin[ao]s|teen|juvenil|de menina|de menino|baby|bebe)',
  '(?:kids?|children s?|childrens|baby|toddler|girls|boys|teen|infantil) (?:underwear|swimwear|swimsuits?|bikinis?|lingerie|undies|panties|bras?|briefs|boxers)',
  'papel (?:de|da) (?:filha|filhinha|enteada|sobrinha|neta|menina|garotinha|aluna|colegial|nina|hija|hijita|sobrina)',
  '(?:roleplay|role ?play|role) (?:de|of|as a?) (?:filha|daughter|hija|enteada|stepdaughter|sobrinha|niece|menina|garotinha|aluna|student|estudante|colegial|schoolgirl|little girl)',
];

/** Persona de adolescente ou de escola: barra sempre, menos no rótulo do lado de vender ("Moda teen" é nicho de loja). */
const MINOR_PERSONA = [
  'tee+n\\w*',
  gapped('teen'),
  'adolescen\\w*',
  gapped('adolescente'),
  'adolecen\\w*',
  'adolesen\\w*',
  'adolecent\\w*',
  'adolesent\\w*',
  'aborrescen\\w*',
  'aborrecent\\w*',
  'pre ?adolescen\\w*',
  'juvenil\\w*',
  'jovencisim\\w*',
  'jovenzuel\\w*',
  'jovencit\\w*',
  'jovenzinh\\w*',
  'chiquill\\w*',
  'menininh\\w*',
  'garotinh\\w*',
  'guriazinh\\w*',
  'gurizinh\\w*',
  'minazinh\\w*',
  'mininh\\w*',
  'minininh\\w*',
  'minina',
  'pirralh\\w*',
  'pivete\\w*',
  'fedelh\\w*',
  'molequinh\\w*',
  'moleca\\w*',
  'brotinh\\w*',
  'franguinh\\w*',
  'frangote\\w*',
  'rapariguinh\\w*',
  'miudinh\\w*',
  'catraia\\w*',
  'petiza\\w*',
  'cachopinh\\w*',
  'mocoila\\w*',
  'debutante\\w*',
  'chamac\\w*',
  'chamaquit\\w*',
  'escuincl\\w*',
  'mocos[ao]s?',
  'morrit\\w*',
  'chavit\\w*',
  'chibol\\w*',
  'nenit\\w*',
  'pendejit\\w*',
  'chiquitin\\w*',
  'lil (?:girl|sis)\\w*',
  'little (?:sis|sister)\\w*',
  'baby sis\\w*',
  'kid sisters?',
  'irmazinh\\w*',
  'irma (?:mais nova|cacula)',
  'hermanit\\w*',
  'hermana menor',
  '(?:little|young|small) girls?',
  '(?:little|young|small) boys?',
  'school ?girl\\w*',
  gapped('schoolgirl'),
  'skool ?girl\\w*',
  'school ?gurl\\w*',
  'school ?(?:uniforms?|skirts?|outfits?|blazers?|swimsuits?|bags?|backpacks?|ties?|dress|shoes|socks)',
  'catholic school\\w*',
  'pleated school\\w*',
  'sailor uniforms?',
  'seifuku',
  'high ?school\\w*',
  'middle ?school\\w*',
  'elementary ?school\\w*',
  'grade ?school\\w*',
  'junior high',
  'jr high',
  '(?:\\d{1,2} ?(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth) grade\\w*',
  'freshm[ae]n',
  'sophomores?',
  '(?:senior|junior) year',
  'prom (?:night|queen|dress|date)',
  'homecoming (?:queen|dance)',
  'after ?school',
  'detention',
  'kindergart\\w*',
  'pre ?school\\w*',
  'preescolar',
  'jardin de (?:infancia|infantes|ninos)',
  'jardim de infancia',
  'creche',
  '(?:no|do|ensino) fundamental',
  'infantario',
  'colegia\\w*',
  gapped('colegial'),
  'kolegial\\w*',
  'colejial\\w*',
  'colegio',
  'uniforme (?:escolar|de escola|de colegio|do colegio|da escola|del colegio|de (?:la )?escuela|de prepa|de secundaria)',
  '(?:sixteen|dezesseis|dieciseis|quince|quinze|1[0-9]|[1-9]) (?:candles|velitas|velinhas)',
  '(?:na|da|pela|a|no|do) escola(?! de (?:samba|danca|musica|idiomas|modelos|teatro|arte|artes|moda|beleza|yoga|pilates|surf|gastronomia))',
  '(?:la|de la|en la) escuela(?! de (?:samba|danza|baile|musica|idiomas|modelos|teatro|arte|artes|moda|belleza|yoga|pilates|surf|cocina))',
  '(?:at|in|to|from) school',
  'ensino (?:medio|fundamental|secundario|basico)',
  'escola (?:secundaria|primaria)',
  'escuela (?:secundaria|primaria|preparatoria)',
  'secundari[ao]',
  '(?:de|en la|la) primaria',
  'prepa',
  'preparatoria',
  'bachillerato',
  'liceo',
  'liceu',
  'liceal\\w*',
  'liceana\\w*',
  'terceirao',
  'vestibuland\\w*',
  'caloura\\w*',
  'co ?ed',
  'college girls?',
  'sorority\\w*',
  '\\d{1,2} ?[oa] (?:ano|serie)',
  '(?:primeira|segunda|terceira|quarta|quinta|sexta|setima|oitava|nona) serie',
  '(?:aluna|aluno|estudante|turma|sala|alumna|alumno) d[oe] (?:\\d{1,2} ?[oa]|primeiro|segundo|terceiro|quarto|quinto|sexto|setimo|oitavo|nono)(?: ano)?',
  'hogwarts',
  'hermione',
  'stranger things',
  'sailor moon',
  'hannah montana',
];

/** Criança na cena ou modelo com papel de criança: barra no 18+ (no lado de vender, "mãe com o bebê" é UGC normal). */
const CHILD_TERMS = [
  'child\\w*',
  gapped('child'),
  'kids?(?! gloves| leather| skin)',
  'kiddo',
  'kiddie\\w*',
  'kiddy',
  'kidz',
  'toddlers?',
  'infants?',
  'newborns?',
  'recem nascid\\w*',
  'recien nacid\\w*',
  'crianc\\w*',
  gapped('crianca'),
  'menin\\w*',
  // sem o til, só plural e diminutivo ("Nina" é nome de adulta)
  'ninit[ao]s?',
  'nin[ao]s',
  'chiquit[ao]s?',
  'filhinh\\w*',
  'filhota\\w*',
  'hijit\\w*',
  'mocinh\\w*',
  'netinh\\w*',
  'afilhad\\w*',
  'cacul\\w*',
  'maninha\\w*',
  'priminh\\w*',
  'student\\w*',
  'estudant\\w*',
  'estudiant\\w*',
  'escolar\\w*',
  'infantil\\w*',
  'aluna\\w*',
  'aluno\\w*',
  'aluninh\\w*',
  'alumn[ao]s?',
  'alumnit\\w*',
  'stepdaughters?',
  'enteada\\w*',
  'enteado\\w*',
  'hijastr\\w*',
  'babysit\\w*',
  'primaria',
  'kinder',
  'garotada',
  'molecada',
  'gurizada',
  'miudos',
  'parquinho',
  'brinquedoteca',
  'infancia',
  'sala de aula',
  '(?:hora do )?recreio',
  'amamenta\\w*',
  'dando de mamar',
  '(?:trocando|troca|trocar) (?:a |de )?fralda\\w*',
  'fralda\\w*',
  'mamadeira\\w*',
  'bebe no colo',
  'nene\\w*',
  // papel de família no 18+ ("filha da vizinha", "sobrinha"); "é filha de italianos" (origem) passa
  'filhas?(?! de (?:\\w+os|\\w+as|pais|imigrantes|um|uma|fazendeiros|militares|medicos|artistas|nobres))',
  'sobrinh\\w*',
  '(?<!la |de |es |que )netas?',
  '(?:avo|vovo|abuelo|grandpa|grandfather) (?:e|y|and) (?:neta|nieta|granddaughter)\\w*',
  '(?:maestra|professora|profesora|teacher) (?:de|do|da|of)? ?(?:primaria|jardim|jardin|kinder\\w*|infantil|criancas|ninos|kids|preschool)',
  '(?:mae|madre|mother|pai|padre|father|dad|daddy|papai) (?:e|y|and) (?:filh\\w*|hij\\w*|daughter\\w*)',
];

/** Segunda pessoa criança ("segurando o bebê", "con un bebé", "with her daughter"): barra no 18+. */
const CHILD_COMPANION_PT_ES =
  '(?:o|os|a|as|do|da|dos|das|no|na|meu|minha|meus|minhas|seu|sua|seus|suas|teu|tua|nosso|nossa|um|uma|com|segurando|carregando|abracando|amamentando|ninando|cuidando|un|una|el|la|los|las|mi|mis|tu|tus|su|sus|con|del|al|sosteniendo|cargando|abrazando|amamantando|cuidando)\\s+(?:pequen[ao]s?\\s+|novo\\s+|nova\\s+)?(?:bebes?|bebezinh\\w*|bebit[ao]s?|nenes?|nenezinh\\w*|nenem|filhas?|filhos?|hijas?|hijos?|sobrinh\\w*|sobrin[ao]s?|netas?|netos?|nietas?|nietos?|enteadas?|enteados?|hijastr[ao]s?|criancas?|ninos?|ninas?)';
const CHILD_COMPANION_EN =
  '(?:a|an|the|her|his|my|their|our|your|with|holding|carrying|hugging|cuddling|nursing|and)\\s+(?:little\\s+|small\\s+|newborn\\s+|young\\s+)?(?:bab(?:y|ies)(?! (?:blue|pink|doll|dolls|oil|powder|hairs?|hair|bangs|fringe|curls|bump|face|tees?|shampoo|lotion|soft|shower|wipes|skin|smooth))|toddlers?|newborns?|infants?|daughters?|nieces?|granddaughters?|stepdaughters?|sons?)';

/** Pistas que deixam a personagem com cara de criança: barram no 18+ (qualquer estilo) e nos estilos desenhados. */
const CHILDLIKE_CUES = [
  'kawai+\\w*',
  gapped('kawaii'),
  'moe',
  'chibi',
  'twin ?tails?',
  'pig ?tails?',
  'two ponytails',
  'dos coletas',
  'coletas',
  'coletitas',
  'chiquinhas',
  'marias? chiquinhas?',
  '(?<!leather |black |red |brown |couro |de couro )braces(?! over)',
  'aparelho (?:nos dentes|dental|nos dente|ortodontico)',
  'de aparelho(?! (?:celular|de som|eletronico|de ginastica))',
  'teddy ?bears?',
  'ursinh\\w*',
  '(?:bicho|bichinho|bichinhos|urso|ursinho|animal|animais|brinquedo|brinquedos) de pelucia',
  '(?<!de )peluches?',
  'pacifiers?',
  'chupeta\\w*',
  'chupete\\w*',
  'petite',
  // "tiny waist", "tiny lace panties", "tiny diamond belly piercing": peça ou detalhe de adulta (até 2 palavras no meio)
  'tiny(?! (?:\\w+ ){0,2}(?:waist|bikinis?|shorts|tops?|dress|skirt|thong|bras?|string|g ?string|panties|lingerie|swimsuit|bodysuit|outfit|clothes|robe|tattoos?|heart|gold|diamond|earrings?|freckles?|moles?|nose|stud|hoops?|piercings?|necklace|rings?|pendant|scars?|birthmark|beauty mark|dimples?|chain|bag|purse|tan lines?|smile lines?|set))',
  'innocent\\w*',
  'inocent\\w*',
  'baby ?faced?',
  'carita de (?:bebe|nena|nina|nene)',
  'cara de (?:bebe|nena|nina|crianca|menina|nene)',
  'carinha de bebe',
  'rost(?:o|inho) de (?:crianca|menina|bebe|nene)',
  'jeito de (?:crianca|menina|bebe)',
  'estilo bebe',
  'bebezinha',
  'nenem',
  'anina(?:d[ao]s?|miento)',
  'flat ?chest\\w*',
  'flat as a board',
  'pecho plano',
  'plana como (?:una )?tabla',
  'reta como uma tabua',
  'peito reto',
  'cuerpo de (?:nena|nina)',
  'corp(?:o|inho) de (?:crianca|menina|nena)',
  'tiernit\\w*',
  'cutesy',
  'uwu',
  'smol',
  'cheerleader\\w*',
  'lider de torcida',
  'porrista\\w*',
  'disney princess\\w*',
  'princesa (?:da )?disney',
  'little princess',
  'dentes de leite',
  'baby teeth',
  'lollipops?',
  'pirulitos?',
];
/** Só nos estilos desenhados (no realista "cute smile" é de adulta). */
const DRAWN_CUES = ['cute', 'cutie', 'fofa', 'fofinh\\w*', 'tierna\\w*', 'adorable', 'gracinha'];

/**
 * Pistas infantis que barram sozinhas também no pedido livre (rosto, corpo e objeto de criança). As outras (petite,
 * tiny, braces, pigtails, innocent, lollipop…) descrevem adulta na maioria dos prompts reais: no modo livre só barram
 * no estilo desenhado ou com 3 delas juntas.
 */
const CHILDLIKE_STRONG = new Set([
  'baby ?faced?',
  'carita de (?:bebe|nena|nina|nene)',
  'cara de (?:bebe|nena|nina|crianca|menina|nene)',
  'carinha de bebe',
  'rost(?:o|inho) de (?:crianca|menina|bebe|nene)',
  'jeito de (?:crianca|menina|bebe)',
  'estilo bebe',
  'bebezinha',
  'nenem',
  'anina(?:d[ao]s?|miento)',
  'cuerpo de (?:nena|nina)',
  'corp(?:o|inho) de (?:crianca|menina|nena)',
  'dentes de leite',
  'baby teeth',
  'pacifiers?',
  'chupeta\\w*',
  'chupete\\w*',
]);
/** Do piso de 25 do construtor ("early twenties" = 20 a 23 anos): no pedido livre (piso 18) é idade adulta. */
const FLOOR_25_TERMS = new Set(['early (?:20s|20 s|twenties)', 'veintipocos', '(?:20|vinte) e poucos']);

/** Lado de vender: nada de conteúdo adulto (a modelo de vendas é sempre vestida). */
const ADULT_TERMS = [
  '\\w*lingerie\\w*',
  gapped('lingerie'),
  '\\w*lenceri\\w*',
  'calcinha\\w*',
  'bragas',
  'en braga',
  'sutia\\w*',
  'sujetador\\w*',
  'sin (?:sosten|sujetador|brasier|bra)',
  'sem sutia',
  'braless',
  'no bra',
  '(?:only|just|lace|in (?:her|a)|wearing (?:just |only )?a|de) bras?',
  'bra and panties',
  'bralette\\w*',
  'bustier\\w*',
  'fio ?dental',
  'roupa de baixo',
  'cuequinh\\w*',
  'baby ?doll\\w*',
  'langeri\\w*',
  'lingeri\\w*',
  'calsinh\\w*',
  'pack do pe\\w*',
  'pezinho\\w*',
  'foot ?pics?',
  'fotos? (?:dos|de) pes',
  'vibrador\\w*',
  'vibrators?',
  'dildos?',
  'sex ?toys?',
  'brinquedos? sexua\\w*',
  'hilo dental',
  'tangas?',
  'tanguinha\\w*',
  'thong\\w*',
  '\\w*biquini\\w*',
  '\\w*bikini\\w*',
  gapped('bikini'),
  'trikini',
  'monokini',
  'sungas?',
  'swim ?suits?',
  'swimwear',
  'bathing suits?',
  'traje de bano',
  'banador\\w*',
  'cuecas?',
  'roupa intima',
  'roupas intimas',
  'ropa interior',
  'underwear',
  'undies',
  'knickers',
  'intimates',
  'panties',
  'panty',
  'g ?strings?',
  'boxer briefs?',
  'babydoll\\w*',
  'negligee\\w*',
  'nightie\\w*',
  'cinta ?liga\\w*',
  'garter\\w*',
  'liguero\\w*',
  'fishnet\\w*',
  'meias? arrastao',
  'thigh ?high stockings?',
  'meias? 7 ?8',
  '(?:lace|de renda) (?:bodysuit|body|bra|bralette)',
  'body de renda',
  'pasties',
  'nipple covers?',
  '\\w*topless\\w*',
  gapped('topless'),
  'shirtless',
  'sem camisa',
  'sin camisa',
  'torso (?:nu|desnudo)',
  'wrapped in a (?:\\w+ )?towel',
  '(?:enrolada|enrolado) (?:na|numa|em uma|em) toalha',
  '(?:envuelta|envuelto) en una toalla',
  'de toalha',
  '(?:open|unbuttoned|untied) (?:\\w+ )?(?:robe|bathrobe|shirt|blouse)',
  'robe aberto',
  'roupao aberto',
  'bata abierta',
  'nude\\w*',
  gapped('nude'),
  'nudez',
  'nudity',
  'nakedness',
  'nudis\\w*',
  'nuas?',
  'nus',
  'nuzinh\\w*',
  '(?:homem|mulher|modelo|corpo|ela|ele|todo|toda|totalmente|completamente|ficar|fica|ficou|posando|pose|foto|fotos|ensaio) nu',
  // "nu" sozinho é nudez; "cartão Nu", "Nu Skin" são marca
  '(?<!(?:cartao|conta|app|banco|nubank|roxinho) )nu(?! (?:skin|bank|conta|app|cartao|metal|ultravioleta|invest))',
  'nu (?:artistico|total|frontal|integral)',
  'semi ?nu\\w*',
  'seminu\\w*',
  'semi ?desnud\\w*',
  'semidesnud\\w*',
  'pelad\\w*',
  'desnud\\w*',
  'encuerad\\w*',
  'empelotad\\w*',
  'en pelotas',
  '\\w*naked\\w*',
  gapped('naked'),
  'sem roupas?',
  'despid[ao]s?',
  'sin ropa',
  'without (?:any )?cloth\\w*',
  'no clothes',
  'wearing nothing',
  'undress\\w*',
  'unclothed',
  '(?:seios?|peitos?) (?:a mostra|de fora|nus)',
  'tits?',
  'tetas?',
  'boobs?',
  'nipples?',
  'mamilos?',
  'pezon\\w*',
  'areola\\w*',
  'genital\\w*',
  'nsfw',
  'not safe for work',
  'x ?rated',
  'explicit\\w*',
  'explicit[ao]s?',
  'uncensored',
  'sem censura',
  'sin censura',
  'adult content',
  'conteudo adulto',
  'contenido (?:para )?adultos?',
  '(?:conteudo|contenido|content|fotos?|videos?) (?:18|mais de 18)',
  '\\w*se+xy\\w*',
  gapped('sexy'),
  'sexi\\w*',
  'sex',
  'sexo',
  'puta\\w*',
  'sacanage\\w*',
  'bunda\\w*',
  'bundao',
  'popozud\\w*',
  'rabud\\w*',
  'molhadinh\\w*',
  'excitad[ao]s?',
  'gozando',
  'gozada',
  'orgasm\\w*',
  'masturba\\w*',
  'boquete\\w*',
  'transando',
  'transar',
  'trepando',
  'foder\\w*',
  'fuck\\w*',
  'sexual\\w*',
  'sex appeal',
  'sensua\\w*',
  'seduct\\w*',
  'seduc\\w*',
  'sedutor\\w*',
  'erotic\\w*',
  'erotica',
  'fetich\\w*',
  'fetish\\w*',
  'kinky',
  'lewd',
  'steamy',
  'racy',
  'sultry',
  'naughty',
  'horny',
  'tesao',
  'tesud\\w*',
  'cachond\\w*',
  'safad\\w*',
  'gostoson\\w*',
  'gostosao',
  '(?:mulher|garota|mina|modelo|gata|morena|loira|ruiva|novinha) gostosa',
  'provocant\\w*',
  'provocativ\\w*',
  'insinuant\\w*',
  'sugestiv\\w*',
  'suggestive',
  'fogos[ao]s?',
  '(?:foto|fotos|conteudo|pose|ensaio|video) (?:hot|picante|caliente)',
  'chica caliente',
  'spicy (?:content|photo|pic|pics|pose|shoot)',
  'boudoir',
  'porn\\w*',
  gapped('porn'),
  'xxx',
  'onlyfans',
  'only ?fans',
  gapped('onlyfans'),
  'fan ?vue',
  'fansly',
  'privacy',
  'hentai',
  gapped('hentai'),
  'ecchi',
  'ahegao',
  'oppai',
  'fan ?service',
  'gravure',
  'futanari',
  'stripper\\w*',
  'strip ?tease',
  'stripping',
  'pole danc(?:er|ers)',
  'dancarina de pole',
  'camgirl\\w*',
  'cam girls?',
  'webcam models?',
  'acompanhante de luxo',
  'garota de programa',
  'garoto de programa',
  'sugar ?bab(?:y|ies)',
  'sugar ?dadd(?:y|ies)',
  'prostitut\\w*',
  'escort girls?',
  'dominatrix',
  'bdsm',
  'bondage\\w*',
  'latex',
  'cleavages?',
  'decote profundo',
  'decotao',
  'escote (?:pronunciado|profundo)',
  '(?:deep|plunging) necklines?',
  'side ?boob\\w*',
  'under ?boob\\w*',
  // roupa transparente (garrafa transparente é produto)
  '(?:roupa|ropa|blusa|vestido|camisa|camiseta|saia|falda|regata|top(?! coat)|lingerie|calcinha|sutia|bra|dress|shirt|t ?shirt|skirt|blouse|bodysuit|body(?! (?:lotion|splash|oil|cream|creme|hidratante|wash))) (?:\\w+ ){0,2}transparent\\w*',
  'transparent\\w* (?:top(?! coat)|dress|shirt|t ?shirt|skirt|lingerie|bra|blouse|roupa|blusa|vestido|camisa|camiseta|saia|falda|regata|bodysuit|body(?! (?:lotion|splash|oil|cream)))',
  'see ?through (?:top|dress|shirt|t ?shirt|skirt|lingerie|bra|blouse|bodysuit|outfit|clothes|robe|nightgown)',
  'sheer (?:top|dress|blouse|shirt|lingerie|bodysuit|robe|nightgown)',
  'mesh (?:top|dress|bodysuit)',
  'translucent (?:dress|top|shirt|blouse)',
  'wet (?:t ?shirt|shirt)',
  'camis(?:a|eta) (?:molhada|mojada)',
  // pose e ato
  '(?:fica|ficar|ficando|ficou|posando|pose|ela|esta) de quatro',
  'de quatro (?:na|no|em|sobre) (?:cama|chao|sofa|lencol|colchao)',
  'on all fours',
  'legs? spread\\w*',
  'pernas abertas',
  'piernas abiertas',
  'bent over',
  'arching (?:her |his )?back',
  'rebolando',
  'twerk\\w*',
  'perrean\\w*',
  'bumbum empinado',
  'bunda empinada',
  'culo empinado',
  'empinando',
  'biting (?:her |his )?lips?',
  'mordendo o labio',
  '(?:tira|tirando|tirar) a roupa',
  '(?:se )?despindo',
  'quitandose la ropa',
  'remove all clothing',
  'removing (?:her|his) clothes',
];

/** Texto que tenta desligar a trava do prompt ("ignore the fully clothed instruction"). Barra sempre. */
const OVERRIDE_TERMS = [
  'ignore (?:the |all |any |every |previous |prior |above |these |those |my |your )*(?:instructions?|rules?|prompt|restrictions?|filters?|guard\\w*|safety|lock|text|age|limits?)',
  'ignore (?:the )?(?:fully clothed|age|adult|25|safe for work|sfw)\\w*',
  'disregard\\w*',
  'desconsider\\w*',
  'ignor[ae]r? (?:a |as |o |os |la |las |el |los |toda |todas |todo |todos )?(?:instruc\\w*|regra\\w*|regla\\w*|trava\\w*|idade|edad|prompt|filtro\\w*)',
  'override\\w*',
  'jailbreak\\w*',
  'no age (?:limit|restriction|rule)s?',
  'sem (?:a )?(?:trava|regra|limite) de idade',
  'without (?:the )?age (?:rule|limit|lock|filter)s?',
];

/* ------------------------------------------------------------------ exceções (tiradas do texto antes da lista) */

/** Produto e cor que o lado de vender usa: saem do texto antes da lista adulta. */
const COMMERCE_ALLOW = [
  // nude de cor/maquiagem/moda
  '(?:batom|batons|labial|labiales|gloss|lips?|lipsticks?|esmalte|esmaltes|unha|unhas|una|unas|nails?|manicure|polish|base|foundation|sombra|sombras|eyeshadows?|paleta|palette|blush|make|makeup|maquiagem|maquillaje|tom|tons|tono|tonos|cor|cores|color|colors|colour|sapato|sapatos|scarpin|salto|saltos|sandalia|sandalias|sandals?|pumps|heels|shoes|zapatos|tacones|bolsa|bolso|bags?|vestido|dress|meia ?calca|meiacalca|meia|meias|tights|calca|blusa|saia|falda|top) (?:\\w+ ){0,2}nude\\w*',
  'nude\\w* (?:lipsticks?|lips?|makeup|tones?|colou?rs?|colou?red|heels|shoes|nails?|palette|blush|gloss|eyeshadows?|foundation|polish|manicure|pumps|sandals?|bags?|dress|tights|toned?|beige|shades?|look)',
  'naked (?:palette|eyeshadows?|lips?|lipsticks?)',
  'paleta naked',
  'lenceria (?:de|para) (?:el |la )?(?:hogar|casa|cama|mesa|bano)',
  'lenceria de cama',
  '(?:luvas?|guantes?|gloves?|tinta|pintura|paint|colchao|colchon|mattress|travesseiro|almohada|pillow|baloes|balao|globos?|balloons?|bexigas?) (?:\\w+ )?latex',
  'latex (?:gloves?|paint|pva|mattress|pillow|balloons?)',
  '(?:pelicula|filtro|tela|vidro|capa|capinha) (?:de )?privacy',
  'privacy (?:screen|filter|protector|policy|glass|film|settings?|mode)',
  'fio dental (?:com fluor|encerado|dental|e escova)',
  '(?:segurando|passando|passar|use|usar|com) (?:um |o )?fio dental(?! (?:biquini|cavado|na praia))',
  '(?:escova|creme dental|pasta de dente|enxaguante) e fio dental',
  '(?:sosteniendo|usando|pasar|pasando) (?:el |un )?hilo dental',
  'hilo dental (?:con fluor|encerado)',
  '(?:jogar|jogo de|joguinho de|futebol|bola|chuteira|chuteiras|campo|time|fut|society|varzea) (?:\\w+ ){0,3}pelada',
  'pelada (?:de domingo|de sabado|de fim de semana|com os amigos|no campo|de futebol|de quinta|semanal)',
  '(?:papas|almendras|mani|naranja|naranjas|tomates?|camarones|camaron|pollo|cabeza|peras?|manzanas?|frutas?|batata|batatas|amendoim|castanhas?|camarao|camaroes) pelad[ao]s?',
  'pelad[ao]s? (?:de |con |y )?(?:papas|almendras|mani|naranja|tomates?|camarones)',
  '(?:pes|pe|bracos|ombros|paredes|parede|maos|olho|olhos) nu[as]?s?',
  'a olho nu',
  '(?:top coat|esmalte|base|gloss|capinha|capa|case|caixa|embalagem|pote|garrafa|copo|bolsa|bag|bottle|glass|box|packaging|window|janela) (?:\\w+ ){0,2}transparent\\w*',
  'transparent\\w* (?:top coat|body (?:lotion|splash)|bags?|bottles?|cases?|boxes|packaging|glass)',
  'see ?through (?:bag|window|glass|case|bottle|packaging|box|the window)',
  '(?:sports?|esportivo|deportivo) bras?',
  'sutia esportivo',
  'top esportivo',
];

/** Coisas de adulta que parecem termo infantil: saem do texto antes das listas do 18+. */
const ADULT_ALLOW = [
  'kid (?:gloves|leather|skin)',
  'kidskin',
  // curso de adulta (medicina, direito, mestrado…); "college student" e "universitária" sozinhos ficam abaixo do piso de 25
  '(?:estudante|estudiante|student|aluna|aluno) (?:de |of )?(?:medicina|direito|derecho|law|medicine|medical|enfermagem|enfermeria|nursing|arquitetura|arquitectura|architecture|engenharia|ingenieria|engineering|psicologia|psychology|odontologia|dentistry|veterinaria|economia|economics|administracao|administracion|business|moda|fashion|design|artes|arts|mestrado|doutorado|doctorado|phd|masters?|mba|pos ?graduacao|pos ?grado|postgrado|posgrado)',
  '(?:grad|phd|medical|law|mba|masters|nursing|doctoral|postgraduate) students?',
  'aluna de (?:yoga|pilates|danca|pole|teatro|canto|ingles|idiomas|academia)',
  '(?:algemas|roupao|robe|chinelos?|pantufas|pantuflas|bata|manta|cobertor|tecido|casaco|jaqueta) (?:\\w+ ){0,1}(?:de )?(?:pelucia|peluche)',
];

/** Rosto da própria modelo e frases que não são pedido de pessoa real. */
const LOOKALIKE_ALLOW = [
  'same face as (?:the |a |my |minha |da |na |in the |her |his )?(?:base|photo|foto|reference|referencia|ref|modelo|model|original|first|primeira|previous|anterior|image|imagem|pack|look|herself|himself|ela mesma|before|last)\\w*',
  '(?:el|al|lo) doble de',
  // grife com nome de gente é estilo de marca, não rosto
  'michael kors', 'kate spade', 'vera wang', 'carolina herrera', 'stella mccartney', 'calvin klein', 'tommy hilfiger', 'ralph lauren', 'christian dior',
  'christian louboutin', 'tory burch', 'marc jacobs', 'victoria ?s secret', 'louis vuitton', 'coco chanel', 'yves saint laurent', 'giorgio armani',
  'dolce (?:e |and |& )?gabbana', 'oscar de la renta', 'alexander mcqueen', 'jimmy choo', 'manolo blahnik', 'ana hickmann', 'maria filo',
  'jessica rabbit',
  'betty boop',
  'lara croft',
  'harley quinn',
  'wonder woman',
  'mulher maravilha',
  'cat ?woman',
  'mulher gato',
  'poison ivy',
  'tinker ?bell',
  'sininho',
  'snow white',
  'branca de neve',
  'sleeping beauty',
  'bela adormecida',
  'black widow',
  'viuva negra',
  'mona lisa',
];

/** Pedido de rosto de pessoa real que vale sempre. */
const LOOKALIKE_STRONG = [
  'sosia',
  'lookalike',
  'look alike',
  'doppel ?ganger',
  'deep ?fake\\w*',
  'face ?swap\\w*',
  'troca de rosto',
  'clone (?:of|da|de|do)',
  'same face as',
  'twin (?:sister )?of',
  'doble de',
  '(?:gemea|gemelo|gemela) (?:da|de|do|del)',
];

/** Famosas (e famosos) mais pedidas: o nome sozinho já barra. A lista completa fica na API. */
const CELEBRITIES = [
  'anitta', gapped('anitta'), 'shakira', gapped('shakira'), 'rihanna', gapped('rihanna'), 'beyonce', gapped('beyonce'), 'zendaya', gapped('zendaya'),
  'kardashian\\w*', 'jenner', 'kylie jenner', 'kendall jenner', 'hadid', 'bella hadid', 'gigi hadid', 'hailey bieber', 'ariana grande', 'billie eilish', 'selena gomez',
  'taylor swift', 'margot robbie', 'sydney sweeney', 'scarlett johansson', 'emma watson', 'emma stone', 'gal gadot', 'megan fox', 'dua lipa', 'jenna ortega',
  'angelina jolie', 'jennifer lopez', 'j ?lo', 'jennifer lawrence', 'jennifer aniston', 'natalie portman', 'emilia clarke', 'ana de armas', 'penelope cruz',
  'salma hayek', 'sofia vergara', 'eiza gonzalez', 'karol g', 'becky g', 'kenia os', 'belinda peregrin', 'paulina rubio', 'natti natasha', 'rosalia vila',
  'lali esposito', 'tini stoessel', 'danna paola', 'emilia mernes', 'maria becerra', 'nicki nicole', 'cazzu', 'wanda nara', 'china suarez', 'eugenia suarez',
  'ester exposito', 'ursula corbero', 'bruna marquezine', 'marquezine', 'marina ruy barbosa', 'juliana paes', 'paolla oliveira', 'gisele bu(?:e)?ndchen', 'bu(?:e)?ndchen',
  'sabrina sato', 'larissa manoela', 'mc mirella', 'mc melody', 'mc pipokinha', 'mc ludmilla', 'ludmilla oliveira', 'ivete sangalo', 'sangalo', 'claudia leitte',
  'virginia fonseca', 'xuxa meneghel', 'isis valverde', 'grazi massafera', 'massafera', 'deborah secco', 'mel maia', 'jade picon', 'gkay', 'viih tube', 'boca rosa',
  'bianca andrade', 'mari maria', 'marina sena', 'luisa sonza', 'ana castela', 'andressa urach', 'rafa kalimann', 'juliette freire', 'maisa silva', 'bruna biancardi',
  'millie bobby brown', 'sadie sink', 'mckenna grace', 'xochitl gomez', 'mackenzie ziegler', 'maddie ziegler', 'lil tay', 'bella ramsey', 'sophia valverde',
  'olivia rodrigo', 'sabrina carpenter', 'doja cat', 'nicki minaj', 'cardi b', 'ice spice', 'megan thee stallion', 'addison rae', 'charli d ?amelio', 'dixie d ?amelio',
  'jojo siwa', 'anya taylor joy', 'florence pugh', 'madison beer', 'emily ratajkowski', 'ratajkowski', 'kate upton', 'alexandra daddario', 'pokimane',
  'belle delphine', 'delphine', 'mia khalifa', 'khalifa', 'lana rhoades', 'rhoades', 'riley reid', 'abella danger', 'mia malkova', 'malkova', 'sasha grey',
  'angela white', 'lisa ann', 'eva elfie', 'amouranth', 'corinna kopf', 'sophie rain', 'bhad bhabie', 'danielle bregoli', 'piper perri', 'london keyes',
  'paris hilton', 'wednesday addams', 'eleven (?:from|de|of) stranger things',
];
/** Mesmos nomes sem espaço, para "@kyliejenner" e "#taylorswift" (só os longos: os curtos dariam falso positivo). */
const GLUED_CELEBRITIES = CELEBRITIES.filter((name) => /^[a-z ]+$/.test(name) && name.includes(' '))
  .map((name) => name.replace(/ /g, ''))
  .filter((name) => name.length >= 8);

/** Emojis de criança e bebê. */
const CHILD_EMOJI = /[\u{1F467}\u{1F466}\u{1F9D2}\u{1F476}\u{1F37C}\u{1F6BC}]/u;

/* ------------------------------------------------------------------ busca */

function compile(terms: readonly string[], flags = ''): RegExp {
  // " ?" = espaço opcional ("baby ?face" pega "babyface" e "baby face"); os outros espaços aceitam vários
  const body = terms.map((term) => term.replace(/ \?/g, '\\s*').replace(/ /g, '\\s+')).join('|');
  return new RegExp(`(?:^|[^a-z0-9])(${body})(?=$|[^a-z0-9])`, flags);
}

const LISTS = {
  minorHard: compile(MINOR_HARD),
  // pedido livre: sem os termos do piso 25, "little space" só colado (o termo de ageplay; "a little space between" é
  // espaço) e "pedo" sem "pedonal/pedonale" (zona de pedestres em espanhol/italiano)
  minorHardFree: compile(
    MINOR_HARD.filter((term) => !FLOOR_25_TERMS.has(term)).map((term) =>
      term === 'little ?space' ? 'littlespace' : term === 'pedo(?!met)\\w*' ? 'pedo(?!met|n)\\w*' : term,
    ),
  ),
  minorPersona: compile(MINOR_PERSONA),
  child: compile([...CHILD_TERMS, CHILD_COMPANION_PT_ES, CHILD_COMPANION_EN]),
  childlike: compile(CHILDLIKE_CUES),
  childlikeStrong: compile(CHILDLIKE_CUES.filter((term) => CHILDLIKE_STRONG.has(term))),
  childlikeWeak: compile(CHILDLIKE_CUES.filter((term) => !CHILDLIKE_STRONG.has(term)), 'g'),
  drawn: compile([...CHILDLIKE_CUES, ...DRAWN_CUES]),
  adult: compile(ADULT_TERMS),
  override: compile(OVERRIDE_TERMS),
  strong: compile(LOOKALIKE_STRONG),
  celebrities: compile(CELEBRITIES),
};
/** Pedido livre (piso 18): universitária é adulta ("college student", "estudante universitária", "universitaria"). */
const ADULT_ALLOW_FREE = [
  ...ADULT_ALLOW,
  '(?:college|university|uni|undergrad\\w*|graduate) students?',
  'student (?:association|union|id|card|housing|loans?|visa|discount|dorm\\w*|apartment|residence|exchange|ambassador)\\w*',
  '(?:estudante|estudantes|estudiante|estudiantes|aluna|alunas|aluno|alunos|alumna|alumnas) (?:universitari\\w*|de faculdade|da faculdade|de la universidad|de universidad)',
];

const ALLOW = {
  commerce: compile(COMMERCE_ALLOW, 'g'),
  adult: compile(ADULT_ALLOW, 'g'),
  adultFree: compile(ADULT_ALLOW_FREE, 'g'),
  adultWithAge: compile([...ADULT_ALLOW, 'estudant\\w*', 'estudiant\\w*', 'student\\w*', 'aluna\\w*', 'aluno\\w*', 'universitari\\w*'], 'g'),
  lookalike: compile(LOOKALIKE_ALLOW, 'g'),
};
/** A mesma lista de frases liberadas, no texto original (com maiúsculas) da leitura de nome. */
const LOOKALIKE_ALLOW_ORIGINAL = compile(LOOKALIKE_ALLOW, 'gi');

function findIn(texts: readonly string[], regex: RegExp): string | null {
  for (const text of texts) {
    const match = text.match(regex);
    if (match) return match[1].trim();
  }
  return null;
}

/** Tira do texto as exceções (o resto da frase continua sendo conferido). */
const without = (texts: readonly string[], allow: RegExp) => texts.map((text) => text.replace(allow, ' '));

/* ------------------------------------------------------------------ idade escrita (abaixo de 25) */

const UNITS = new Set([
  'ano', 'anos', 'aninho', 'aninhos', 'anito', 'anitos', 'year', 'years', 'yr', 'yrs', 'yo', 'yearsold', 'yearold', 'yrsold', 'yrold', 'primaveras', 'abriles', 'summers',
  'springs', 'winters', 'invernos', 'outonos',
  // "16ish", "sixteen-ish"
  'ish',
  // francês, alemão, italiano, holandês ("15 ans", "15 Jahre", "15-jährige", "15 anni", "15 jaar")
  'ans', 'jahre', 'jahren', 'jahrig', 'jahrige', 'jahriges', 'jahriger', 'anni', 'jaar',
]);

const WORD_VALUES: Record<string, number> = {
  // pt ("dos" fica de fora: em português é "dos anos 80"; erros de grafia comuns entram)
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14,
  quinze: 15, dezesseis: 16, dezasseis: 16, dezeseis: 16, desesseis: 16, dezaseis: 16, dezessete: 17, dezassete: 17, dezesete: 17, desessete: 17, dezoito: 18,
  desoito: 18, dezenove: 19, dezanove: 19, desenove: 19, deznove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50,
  // es
  uno: 1, una: 1, un: 1, cuatro: 4, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  // en
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, primeiro: 1, segundo: 2, terceiro: 3, quarto: 4, quinto: 5, sexto: 6,
  setimo: 7, oitavo: 8, nono: 9, decimo: 10, primero: 1, tercero: 3, septimo: 7, octavo: 8, noveno: 9, decimoquinto: 15, decimosexto: 16, decimoseptimo: 17,
  decimoctavo: 18, quinceavo: 15,
};
const ROMAN: Record<string, number> = { xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20, xxi: 21, xxii: 22, xxiii: 23, xxiv: 24 };
const CONNECTORS = new Set(['e', 'y', 'and']);

/** Verbos e rótulos que, seguidos de número, dizem a idade ("she is 16", "tem 15", "edad: 14", "corpinho de 15"). */
const AGE_VERBS = new Set([
  'tem', 'tenho', 'tens', 'tendo', 'tinha', 'ter', 'fez', 'faz', 'faco', 'fiz', 'completou', 'completa', 'completei', 'completando', 'completara', 'fara', 'fazendo',
  'tiene', 'tengo', 'tenia', 'tener', 'tienes', 'cumple', 'cumplio', 'cumpli', 'cumplir', 'cumplido', 'cumplidos', 'cumpliendo', 'cumplira', 'is', 'shes', 'hes', 'im',
  'am', 'are', 'was', 'were', 'turned', 'turns', 'turning', 'turn', 'aged', 'age', 'ages', 'idade', 'edad', 'aparenta', 'aparentando', 'aparentar', 'aparentemente',
  'parece', 'parecendo', 'parecia', 'looks', 'looking', 'appears', 'appearing', 'seems', 'aparencia', 'apariencia', 'apenas', 'only', 'just', 'somente', 'solo',
  'sweet', 'aos', 'nos', 'sus', 'mis', 'seus', 'meus', 'pass', 'so', 'ar',
  // "around 16", "cerca de 17"
  'around', 'about', 'aprox', 'aproximadamente', 'approximately', 'roughly', 'cerca',
  // "corpo de 15", "carinha de 16", "body of 17", "jeito de 15"
  'corpo', 'corpinho', 'body', 'cara', 'carinha', 'rosto', 'rostinho', 'face', 'jeito', 'pinta', 'tracos', 'visual', 'fisico', 'feicoes', 'aspecto', 'aspect',
]);
/** Entre o verbo/rótulo e o número ("tem só 17", "idade aparente: 17", "tem por volta de 17", "parece una de 15"). */
const SKIP = new Set([
  'de', 'of', 'is', 'e', 'es', 'ter', 'tener', 'only', 'just', 'apenas', 'so', 'somente', 'solo', 'uns', 'umas', 'unos', 'unas', 'cerca', 'around', 'about', 'aprox',
  'aproximadamente', 'approximately', 'por', 'volta', 'tipo', 'like', 'quase', 'almost', 'nearly', 'sus', 'seus', 'suas', 'the', 'os', 'as', 'los', 'las', 'la', 'el', 'for',
  'o', 'dos', 'das', 'del', 'recem', 'recien', 'barely', 'already', 'ja', 'ya', 'aparente', 'aparentes', 'una', 'uma', 'like', 'mal',
]);
/** Depois do número, a contagem de outra coisa ("tem 2 filhos", "is 5 feet", "kit com 12 unidades"). */
const COUNT_NOUNS = new Set([
  'filhos', 'filhas', 'filho', 'filha', 'kids', 'children', 'child', 'hijos', 'hijas', 'gatos', 'gatas', 'cats', 'dogs', 'cachorros', 'perros', 'tattoos', 'tatuagens',
  'tatuajes', 'piercings', 'irmaos', 'irmas', 'siblings', 'hermanos', 'hermanas', 'mil', 'k', 'milhoes', 'million', 'millones', 'seguidores', 'seguidoras', 'followers',
  'fotos', 'photos', 'looks', 'outfits', 'pecas', 'piezas', 'pieces', 'vezes', 'veces', 'times', 'dias', 'days', 'meses', 'months', 'semanas', 'weeks', 'horas', 'hours',
  'minutos', 'minutes', 'segundos', 'seconds', 'cm', 'kg', 'kilos', 'quilos', 'lbs', 'pounds', 'libras', 'metros', 'm', 'mm', 'pes', 'feet', 'foot', 'ft', 'inches',
  'inch', 'polegadas', 'pulgadas', 'reais', 'real', 'dolares', 'dollars', 'dolar', 'usd', 'brl', 'eur', 'euros', 'pesos', 'percent', 'porcento', 'produtos', 'products',
  'itens', 'items', 'unidades', 'units', 'unidade', 'unit', 'cores', 'colors', 'colours', 'tons', 'shades', 'sabores', 'flavors', 'opcoes', 'options', 'tamanhos',
  'sizes', 'modelos', 'models', 'estilos', 'styles', 'pares', 'pairs', 'caixas', 'boxes', 'ml', 'l', 'litros', 'liters', 'gramas', 'grams', 'g', 'oz', 'calorias',
  'calories', 'kcal', 'passos', 'steps', 'km', 'quilometros', 'miles', 'milhas', 'reps', 'series', 'sets', 'paginas', 'pages', 'episodios', 'episodes', 'videos',
  'posts', 'likes', 'curtidas', 'views', 'inscritos', 'subscribers', 'marcas', 'brands', 'clientes', 'clients', 'lojas', 'stores', 'idiomas', 'languages', 'linguas',
  'livros', 'books', 'carros', 'cars', 'quartos', 'rooms', 'andares', 'floors', 'vagas', 'empregos', 'jobs', 'premios', 'awards', 'medalhas', 'medals', 'trofeus',
  'x', 'por', 'reales', 'graus', 'grados', 'degrees', 'productos', 'colores', 'vezes', 'cuotas', 'parcelas', 'prestacoes', 'meses',
]);
/** Medida antes do verbo ("her dress size is 8", "waist is 24"): o número é medida, não idade. */
const SIZE_WORDS = new Set([
  'size', 'tamanho', 'talla', 'numero', 'number', 'waist', 'cintura', 'busto', 'bust', 'hips', 'hip', 'quadril', 'cadera', 'height', 'altura', 'weight', 'peso', 'shoe',
  'sapato', 'calcado', 'calca', 'manequim', 'score', 'nota', 'rating', 'level', 'nivel', 'version', 'versao', 'chest', 'peito',
]);
/** Quem fala da própria idade no lado de vender (lá "o kit tem 12" é produto). */
const PERSON_SUBJECTS = new Set([
  'ela', 'ele', 'she', 'he', 'i', 'eu', 'yo', 'me', 'modelo', 'model', 'garota', 'menina', 'girl', 'mulher', 'woman', 'chica', 'mujer', 'influencer', 'criadora',
  'creator', 'personagem', 'personaje', 'character', 'ella', 'moca', 'gata', 'lady', 'que', 'who',
]);
/** "garota de 16", "una chica de 16", "girl of seventeen", "mulher com 17". */
const PERSON_NOUNS = new Set([
  'garota', 'garotinha', 'menina', 'mina', 'minazinha', 'miuda', 'miudinha', 'mulher', 'moca', 'mocinha', 'gata', 'gatinha', 'novinha', 'chica', 'chiquita', 'chava',
  'chavita', 'chamaca', 'morra', 'morrita', 'piba', 'nena', 'nenita', 'mujer', 'muchacha', 'muchachita', 'joven', 'jovem', 'girl', 'gal', 'woman', 'lady', 'babe',
  'chick', 'model', 'modelo', 'influencer', 'influenciadora', 'personagem', 'personaje', 'character', 'aluna', 'aluno', 'estudante', 'estudiante', 'student',
  'vampira', 'elfa', 'deusa', 'goddess', 'elf', 'fada', 'fairy', 'princesa', 'princess', 'bruxa', 'witch', 'menino', 'garoto', 'chico', 'boy', 'guy', 'homem',
  'hombre', 'rapaz', 'moco', 'loira', 'morena', 'ruiva', 'blonde', 'brunette', 'redhead',
]);
/** Festa e aniversário ("festa de 15", "aniversário de 17", "fiesta de quince"). */
const EVENT_NOUNS = new Set(['festa', 'fiesta', 'aniversario', 'cumpleanos', 'birthday', 'bday', 'party', 'debut', 'baile']);
/** "há 10 anos", "por 5 anos" (tempo, não idade); também olha 2 palavras antes ("há mais de 10 anos", "há uns 5 anos"). */
const DURATION_BEFORE = new Set([
  'ha', 'hace', 'for', 'desde', 'durante', 'during', 'over', 'por', 'lleva', 'llevo', 'llevas', 'llevamos', 'llevan', 'leva', 'levo', 'levou', 'levamos', 'garantia',
  'warranty', 'guarantee', 'validade', 'validity', 'cada', 'every', 'todo', 'todos', 'after', 'apos', 'depois', 'within', 'dentro', 'ultimos', 'ultimas', 'last', 'past',
  'proximos', 'proximas', 'next', 'primeiros', 'mais', 'more', 'than', 'em', 'in',
  // skincare: "rejuvenesce 10 anos", "tira 10 anos do rosto"
  'rejuvenesce', 'rejuvenescer', 'rejuvenece', 'rejuvenecer', 'tira', 'tirar', 'quita', 'quitar', 'apaga', 'reduz', 'reduce', 'takes', 'take', 'off',
]);
const BIRTH_WORDS = new Set(['nasceu', 'nascida', 'nascido', 'nasci', 'nacio', 'nacida', 'nacido', 'naci', 'born', 'mundo']);
/** Depois de "N anos de/no/in the": tempo de casa, de carreira, de garantia… */
const DURATION_NOUNS = new Set([
  'experiencia', 'experience', 'carreira', 'carrera', 'career', 'mercado', 'market', 'trabalho', 'work', 'profissao', 'profession', 'casa', 'empresa', 'company', 'loja',
  'store', 'shop', 'tienda', 'marca', 'brand', 'tradicao', 'tradicion', 'tradition', 'historia', 'history', 'garantia', 'warranty', 'guarantee', 'validade', 'uso',
  'vida', 'existencia', 'academia', 'gym', 'treino', 'training', 'pratica', 'practice', 'yoga', 'danca', 'dance', 'moda', 'fashion', 'industria', 'industry', 'negocio',
  'negocios', 'business', 'trajetoria', 'trayectoria', 'estrada', 'perfil', 'profile', 'pagina', 'page', 'canal', 'channel', 'instagram', 'tiktok', 'youtube', 'atuacao',
  'casamento', 'casada', 'casado', 'casados', 'matrimonio', 'marriage', 'married', 'namoro', 'relacionamento', 'relationship', 'servico', 'service', 'segmento', 'area',
  'ramo', 'setor', 'sector', 'oficio', 'modelagem', 'modeling', 'modelling', 'modelando', 'modelo', 'atriz', 'actress', 'fotografa', 'enfermeira', 'nursing', 'job',
  'account', 'conta', 'mercado', 'profissional', 'professional', 'studio', 'estudio', 'salao', 'salon',
]);
const DURATION_AFTER = new Set([
  'ago', 'atras', 'antes', 'depois', 'later', 'mais', 'more', 'menos', 'less', 'younger', 'jovem', 'nova', 'novo', 'seguidos', 'seguidas', 'consecutivos', 'straight',
  'running', 'modelando', 'trabalhando', 'working', 'modeling',
  // "2 years warranty", "3 anos garantia": produto
  'warranty', 'guarantee', 'garantia', 'validade', 'validity', 'contract', 'contrato', 'subscription', 'assinatura', 'plan', 'plano',
]);
const ARTICLES = new Set(['the', 'a', 'o', 'la', 'el', 'her', 'his', 'sua', 'seu', 'su', 'my', 'minha', 'meu', 'mi', 'this', 'esta', 'este', 'essa', 'esse']);
/** "N anos de idade", "16 years of age", "16 anos de olhos verdes": depois do "de" vem a pessoa, não um tempo. */
const AGE_NOUNS_AFTER = new Set([
  'idade', 'edad', 'age', 'vida', 'life', 'olhos', 'ojos', 'eyes', 'cabelo', 'cabelos', 'pelo', 'hair', 'pele', 'piel', 'skin', 'corpo', 'cuerpo', 'body', 'rosto',
  'cara', 'face', 'altura', 'estatura', 'height', 'beleza', 'belleza', 'beauty', 'sorriso', 'sonrisa', 'smile', 'pura', 'puro',
]);
const PREPOSITIONS = new Set(['de', 'of', 'in', 'no', 'na', 'em', 'en', 'del', 'da', 'do', 'dentro', 'como', 'as', 'on', 'at', 'into', 'nesta', 'neste', 'nessa', 'nesse']);

/* ------------------------------------------------------------------ pedido livre (API) */

/**
 * Artigo que também é número ("um vestido", "una con", "one woman") e "once" (11 em espanhol, "uma vez" em inglês):
 * no pedido livre nunca abre uma idade sozinho ("once años" segue valendo pela unidade).
 */
const ARTICLE_NUMBERS = new Set(['um', 'uma', 'un', 'una', 'uno', 'one', 'once']);
/**
 * Verbo ou rótulo vago, inclusive o verbo ser ("the ratio is 2", "there are two of them"): no pedido livre só vale com
 * o número fechando o trecho ("she is 15,", "only 15 and", "around 16 or 17").
 */
const VAGUE_AGE_WORDS = new Set([
  'only', 'just', 'apenas', 'somente', 'solo', 'so', 'about', 'around', 'aprox', 'aproximadamente', 'approximately', 'roughly', 'cerca', 'sweet', 'aos', 'nos',
  'sus', 'mis', 'seus', 'meus', 'pass', 'ar', 'corpo', 'corpinho', 'body', 'cara', 'carinha', 'rosto', 'rostinho', 'face', 'jeito', 'pinta', 'tracos', 'visual',
  'fisico', 'feicoes', 'aspecto', 'aspect', 'faz', 'fazendo', 'faco', 'fiz', 'tendo', 'ter', 'tener', 'fara', 'com', 'is', 'are', 'am', 'was', 'were', 'shes',
  'hes', 'im',
]);
/** Comparativo que é idade mesmo sem fechar o trecho ("under 16 nude", "menor de 18 pelada"); os outros são vagos. */
const STRONG_COMPARATORS = new Set(['under', 'sub', 'u', 'menores', 'menor', 'younger', 'mais']);
/** Coisa contada no singular depois do número ("1 metro", "1 inch", "3 d" de "3D", "1 take"). */
const COUNTED_SINGULAR = new Set([
  'meter', 'metre', 'metro', 'centimetro', 'centimeter', 'centimetre', 'inch', 'polegada', 'pulgada', 'pe', 'pie', 'kilo', 'quilo', 'pound', 'libra', 'mile',
  'milha', 'milla', 'hour', 'hora', 'minute', 'minuto', 'second', 'day', 'dia', 'week', 'semana', 'month', 'mes', 'time', 'vez', 'person', 'pessoa', 'persona',
  'take', 'shot', 'frame', 'step', 'passo', 'paso', 'd', 'piece', 'peca', 'pieza', 'item', 'unit', 'unidade', 'unidad', 'layer', 'camada', 'capa', 'color', 'cor',
  'point', 'ponto', 'punto', 'star', 'estrela', 'estrella', 'scene', 'cena', 'escena', 'image', 'imagem', 'imagen', 'photo', 'foto', 'picture', 'version', 'versao',
  'variation', 'variacao', 'option', 'opcao', 'opcion', 'line', 'linha', 'linea', 'row', 'column', 'coluna', 'side', 'lado', 'quarter', 'third', 'half',
]);
/** Plural sem "s" no fim (o resto do plural pt/es/en termina em "s"). */
const PLURAL_PEOPLE = new Set(['women', 'men', 'people', 'feet', 'teeth', 'children', 'gente', 'folk', 'staff', 'crew']);
/** Rótulo de idade antes de um número sozinho ("age: 16", "idade, 16"). */
const AGE_LABELS = new Set(['age', 'aged', 'ages', 'idade', 'edad', 'yo']);

/** Pedido livre: o número conta alguma coisa ("2 women", "três pessoas", "1 metro", "turned three quarters"), não é idade. */
function countsSomething(token: string): boolean {
  if (!token || token === ',' || UNITS.has(token)) return false;
  // outro número logo depois é medida ("5'7\"", "1 70")
  if (/^\d/.test(token)) return true;
  if (COUNT_NOUNS.has(token) || COUNTED_SINGULAR.has(token) || PLURAL_PEOPLE.has(token) || PERSON_NOUNS.has(token)) return true;
  // plural em pt/es/en ("mulheres", "chicas", "girls", "quarters")
  return /^[a-z]{3,}s$/.test(token);
}

/** Pedido livre, depois de verbo vago: o número fecha o trecho, tem unidade, "e meio", "de idade" ou faixa ("16 or 17"). */
function closesAsAge(tokens: readonly string[], end: number): boolean {
  const next = tokens[end + 1] ?? '';
  const after = tokens[end + 2] ?? '';
  if (next === '' || next === ',' || UNITS.has(next)) return true;
  // "15 and naked", "15 e nua", "17 y medio"
  if (['e', 'y', 'and'].includes(next)) return true;
  if (next === 'de' && ['idade', 'edad'].includes(after)) return true;
  // faixa ("16 or 17", "15 a 17"), menos quando a faixa mede alguma coisa ("2 to 3 meters", "8 a 9 segundos")
  return (
    ['or', 'ou', 'o', 'to', 'a', 'al', 'ate'].includes(next) &&
    (/^\d{1,2}$/.test(after) || WORD_VALUES[after] !== undefined) &&
    !countsSomething(tokens[end + 3] ?? '')
  );
}

/** Pedido livre: o trecho antes do número sozinho termina numa pessoa, num nome ou num rótulo de idade ("Ana, 16"). */
function namesSomeone(segment: readonly string[] | undefined): boolean {
  const last = segment?.[segment.length - 1];
  if (!last) return false;
  return PERSON_NOUNS.has(last) || PERSON_SUBJECTS.has(last) || FIRST_NAMES.has(last) || AMBIGUOUS_NAMES.has(last) || AGE_LABELS.has(last);
}

/** Pedido livre: o trecho depois do número sozinho começa por uma pessoa ("16, blonde girl", "15, garota"). */
function startsWithSomeone(segment: readonly string[] | undefined): boolean {
  const first = segment?.[0];
  return Boolean(first && (PERSON_NOUNS.has(first) || ['f', 'm', 'fem', 'female', 'male'].includes(first)));
}

/** Texto em palavras para a leitura de idade: vírgula, ponto e parêntese viram "," (fim de trecho). */
function ageTokens(text: string): string[] {
  const value = canonical(text)
    .replace(PICTOGRAPHIC, '')
    // "18+", "+18", "21+": selo de só adultos, não idade
    .replace(/\+\s*(?:1[89]|2\d)(?!\d)|(?<!\d)(?:1[89]|2\d)\s*\+/g, ' ')
    .replace(/'(s|m)(?![a-z])/g, '$1')
    // "17 y/o", "17 y,o", "17-y-o", "sixteen y.o." (o "y/o" do espanhol, "e/ou", vira "yo" e só conta com número antes)
    .replace(/(\d)\s*[-.]?\s*y\s*[,./-]?\s*o(?![a-z])/g, '$1 yo')
    .replace(/(?<![a-z])y\s*[,./-]\s*o(?![a-z])/g, ' yo')
    .replace(/(\d)[.,](\d)/g, '$1d$2')
    .replace(/[,;:!?|()[\]{}"<>\n/]+/g, ' , ')
    .replace(/[^a-z0-9,\s]+/g, ' ');
  const split: string[] = [];
  for (const token of value.split(/\s+/).filter(Boolean)) {
    let match = /^(\d{1,4}(?:d\d+)?)([a-z]+)$/.exec(token);
    if (match) {
      // "16y" = 16 anos
      split.push(match[1], match[2] === 'y' ? 'yo' : match[2]);
      continue;
    }
    match = /^([a-z]+)(\d{1,4})$/.exec(token);
    if (match) {
      split.push(match[1], match[2]);
      continue;
    }
    match = /^([a-z]+?)(yearsold|yearold|yrsold|years|anos|yo)$/.exec(token);
    if (match && WORD_VALUES[match[1]] !== undefined) {
      split.push(match[1], match[2]);
      continue;
    }
    split.push(token);
  }
  // "y o" → "yo"; número por extenso partido ("dez esseis" → "dezesseis")
  const merged: string[] = [];
  for (let index = 0; index < split.length; index++) {
    const token = split[index];
    const next = split[index + 1];
    if (token === 'y' && next === 'o' && /^\d/.test(merged[merged.length - 1] ?? '')) {
      merged.push('yo');
      index++;
    } else if (next !== undefined && WORD_VALUES[token + next] !== undefined && WORD_VALUES[next] === undefined) {
      merged.push(token + next);
      index++;
    } else merged.push(token);
  }
  return merged;
}

interface FoundNumber {
  value: number;
  start: number;
  end: number;
  decimal: boolean;
}

/** Valor de 1 a 4 palavras/algarismo começando em `start` (andando para a frente). */
function numberAt(tokens: readonly string[], start: number): FoundNumber | null {
  const first = tokens[start];
  if (first === undefined) return null;
  const digits = /^(\d{1,3})(d\d+)?$/.exec(first);
  if (digits) return { value: Number(digits[1]), start, end: start, decimal: Boolean(digits[2]) };
  // pedido livre: artigo não abre número ("um vestido", "una de las fotos", "only one woman")
  if (freeMode && ARTICLE_NUMBERS.has(first)) return null;
  let total = 0;
  let end = -1;
  for (let index = start; index < tokens.length && index < start + 4; index++) {
    const token = tokens[index];
    if (CONNECTORS.has(token) && end !== -1) continue;
    const value = WORD_VALUES[token];
    if (value === undefined) break;
    total += value;
    end = index;
  }
  return end === -1 ? null : { value: total, start, end, decimal: false };
}

/** Valor que termina logo antes de `unitIndex` (andando para trás). */
function numberBefore(tokens: readonly string[], unitIndex: number): FoundNumber | null {
  let index = unitIndex - 1;
  if (index < 0) return null;
  const digits = /^(\d{1,3})(d\d+)?$/.exec(tokens[index]);
  if (digits) return { value: Number(digits[1]), start: index, end: index, decimal: Boolean(digits[2]) };
  // "17 e meio anos", "17 and a half years"
  if (['meio', 'meia', 'half', 'medio'].includes(tokens[index])) {
    let back = index - 1;
    while (back >= 0 && ['e', 'y', 'and', 'a'].includes(tokens[back])) back--;
    const half = numberBefore(tokens, back + 1);
    return half && back < index - 1 ? { ...half, end: index } : null;
  }
  let total = 0;
  let start = -1;
  for (let steps = 0; index >= 0 && steps < 4; index--, steps++) {
    const token = tokens[index];
    if (CONNECTORS.has(token)) continue;
    const value = WORD_VALUES[token];
    if (value === undefined) break;
    total += value;
    start = index;
  }
  return start === -1 ? null : { value: total, start, end: unitIndex - 1, decimal: false };
}

/** "N anos" que não é idade: "há 10 anos", "10 anos de experiência", "anos 80", "10 years ago", "10 anos mais jovem". */
function isDuration(tokens: readonly string[], numberStart: number, unitIndex: number): boolean {
  // "nasceu há 17 anos" é idade
  for (let back = numberStart - 1; back >= Math.max(0, numberStart - 4); back--) if (BIRTH_WORDS.has(tokens[back])) return false;
  for (let back = numberStart - 1; back >= Math.max(0, numberStart - 3); back--) {
    if (tokens[back] === ',') break;
    if (DURATION_BEFORE.has(tokens[back])) return true;
  }
  const after = tokens[unitIndex + 1] ?? '';
  // "faz 2 anos que trabalha" (o "que" logo depois da unidade); "trabalha com moda faz 7 anos" (faz depois de outra palavra)
  if (tokens[numberStart - 1] === 'faz' && (after === 'que' || (numberStart >= 2 && !PERSON_SUBJECTS.has(tokens[numberStart - 2]) && tokens[numberStart - 2] !== ','))) {
    return !BIRTH_WORDS.has(tokens[unitIndex + 2] ?? '');
  }
  if (/^\d{2,4}$/.test(after)) return true;
  if (DURATION_AFTER.has(after)) return true;
  // "aparenta 5 anos a menos"
  if (after === 'a' && ['menos', 'mais'].includes(tokens[unitIndex + 2] ?? '')) return true;
  // "N anos de X" é tempo ("3 anos de pole dance", "12 anos de ballet"), menos "de idade/de vida" e traço físico
  // ("garota de 16 anos de olhos verdes" continua idade)
  if (after === 'de' || after === 'of' || after === 'del') {
    const noun = tokens[unitIndex + 2] ?? '';
    if (AGE_NOUNS_AFTER.has(noun)) return false;
    if (noun && noun !== ',' && !/^\d/.test(noun)) return true;
  }
  if (PREPOSITIONS.has(after)) {
    let next = unitIndex + 2;
    while (ARTICLES.has(tokens[next] ?? '') && next < unitIndex + 4) next++;
    if (DURATION_NOUNS.has(tokens[next] ?? '')) return true;
  }
  return false;
}

/** Fim de "under/below/menos de/sub/younger than…" que começa em `index` (-1 = não é comparativo). */
function comparatorEnd(tokens: readonly string[], index: number): number {
  const at = (offset: number) => tokens[index + offset] ?? '';
  const t = at(0);
  if (['under', 'below', 'sub', 'u', 'menores', 'inferior'].includes(t)) return index + 1 + (at(1) === 'a' || at(1) === 'de' || at(1) === 'the' ? 1 : 0);
  if (['younger', 'less', 'lower'].includes(t) && at(1) === 'than') return index + 2;
  if (['menos', 'abaixo', 'menor'].includes(t) && ['de', 'dos', 'das', 'que'].includes(at(1))) return index + 2;
  if (t === 'mais' && ['nova', 'novo', 'jovem'].includes(at(1)) && ['que', 'do', 'de'].includes(at(2))) return index + 3;
  if (t === 'por' && at(1) === 'debajo' && at(2) === 'de') return index + 3;
  return -1;
}

/** Fim de "quase/almost/prestes a fazer/va a cumplir…" que começa em `index` (-1 = não é). */
function aboutToEnd(tokens: readonly string[], index: number): number {
  const seq = (...words: string[]) => words.every((word, offset) => tokens[index + offset] === word);
  if (['almost', 'nearly', 'quase', 'casi', 'fara', 'fazendo', 'completando', 'cumplira', 'cumpliendo'].includes(tokens[index])) return index + 1;
  if (seq('not', 'yet')) return index + 2;
  if (seq('prestes', 'a', 'fazer') || seq('prestes', 'a', 'completar') || seq('antes', 'de', 'fazer') || seq('about', 'to', 'turn') || seq('va', 'a', 'cumplir') || seq('va', 'a', 'tener')) return index + 3;
  if (seq('vai', 'fazer') || seq('vai', 'completar') || seq('a', 'completar') || seq('antes', 'dos') || seq('por', 'cumplir') || seq('soon', 'to')) return index + 2;
  if (seq('a', 'punto', 'de', 'cumplir')) return index + 4;
  return -1;
}

/** Quem tem a idade no lado de vender: uma pessoa antes do verbo (ou o verbo abrindo o texto). */
function personBefore(tokens: readonly string[], index: number): boolean {
  let back = index - 1;
  while (back >= 0 && ['ja', 'so', 'apenas', 'only', 'just', 'ya', 'solo', 'agora', 'now', 'hoje'].includes(tokens[back])) back--;
  return back < 0 || tokens[back] === ',' || PERSON_SUBJECTS.has(tokens[back]);
}

/** Piso de idade da conferência em andamento (checkAdultOnly é síncrona: definido no começo de cada chamada). */
let ageFloor = 25;
/** Pedido livre (opção `free`), também definido no começo de cada chamada. */
let freeMode = false;
const isUnderFloor = (value: number) => value >= 1 && value < ageFloor;

/**
 * Idade abaixo de 25 escrita no texto. `strict` (18+ e desenhado) lê também o verbo sem sujeito e o número sozinho
 * num trecho ("Valentina, 16, loira"); no lado de vender, onde copy de produto tem número, só com uma pessoa antes.
 * `labelOnCommerce`: rótulo do lado de vender, só a regra da unidade ("16 anos").
 */
function underageNumber(text: string, strict: boolean, labelOnCommerce: boolean): string | null {
  const tokens = ageTokens(text);
  const at = (index: number) => tokens[index] ?? '';
  const phrase = (start: number, end: number) => tokens.slice(Math.max(0, start), end + 1).join(' ') || text.trim();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    // R1 número + unidade ("16 anos", "17 e meio anos", "XV años"), menos duração
    if (UNITS.has(token)) {
      const found = numberBefore(tokens, index);
      if (found && isUnderFloor(found.value) && !isDuration(tokens, found.start, index)) return phrase(found.start, index);
      const roman = ROMAN[at(index - 1)];
      if (roman && isUnderFloor(roman)) return phrase(index - 1, index);
    }
    if (labelOnCommerce) continue;
    // R4 comparativo ("under 16", "menos de 20", "sub 17", "u18", "younger than 18") e faixa ("between 15 and 17")
    const comparator = comparatorEnd(tokens, index);
    if (comparator !== -1) {
      const found = numberAt(tokens, comparator);
      // pedido livre: "under/younger than/menor de" + número que não conta nada; "less than/below/menos de" só fechando o trecho
      const freeAge = !freeMode || (STRONG_COMPARATORS.has(token) ? !countsSomething(at((found?.end ?? 0) + 1)) : found !== null && closesAsAge(tokens, found.end));
      if (freeAge && found && !found.decimal && found.value >= 1 && found.value <= 25 && !COUNT_NOUNS.has(at(found.end + 1))) return phrase(index, found.end);
    }
    if (token === 'between' || token === 'entre') {
      const low = numberAt(tokens, index + 1);
      if (low && !low.decimal && isUnderFloor(low.value) && ['and', 'e', 'y', 'a', 'to'].includes(at(low.end + 1))) {
        const high = numberAt(tokens, low.end + 2);
        const tail = high ? at(high.end + 1) : '';
        if (high && !COUNT_NOUNS.has(tail)) return phrase(index, high.end);
      }
    }
    // R5 prestes a fazer ("quase 18", "va a cumplir 16", "about to turn 18")
    const soon = aboutToEnd(tokens, index);
    if (soon !== -1) {
      let next = soon;
      while (['os', 'los', 'the', 'seus', 'sus'].includes(at(next))) next++;
      const found = numberAt(tokens, next);
      const freeAge = !freeMode || (found !== null && closesAsAge(tokens, found.end));
      if (freeAge && found && !found.decimal && found.value >= 1 && found.value <= 25 && !COUNT_NOUNS.has(at(found.end + 1))) return phrase(index, found.end);
    }
    // R6 meia idade sem unidade ("17 e meio", "17 and a half", "17 y medio") e "17 de idade"
    const half = numberAt(tokens, index);
    if (half && !half.decimal && isUnderFloor(half.value) && at(half.end + 1) === 'de' && ['idade', 'edad'].includes(at(half.end + 2))) return phrase(index, half.end + 2);
    if (half && !half.decimal && isUnderFloor(half.value) && ['e', 'y', 'and'].includes(at(half.end + 1)) && ['meio', 'meia', 'medio', 'half', 'a'].includes(at(half.end + 2))) {
      if (at(half.end + 2) !== 'a' || at(half.end + 3) === 'half') return phrase(index, half.end + 2);
    }
    // R7 ordinal de aniversário ou de série ("16th birthday", "8th grade", "9o ano", "decimosexto cumpleaños", "mis XV")
    const ordinalDigits = /^\d{1,2}$/.test(token) && ['st', 'nd', 'rd', 'th', 'o', 'a'].includes(at(index + 1)) ? Number(token) : null;
    const ordinal = ordinalDigits ?? ORDINAL_WORDS[token];
    if (ordinal !== undefined && ordinal !== null) {
      const next = at(index + (ordinalDigits !== null ? 2 : 1));
      if (['birthday', 'bday', 'cumpleanos', 'aniversario'].includes(next) && isUnderFloor(ordinal)) return phrase(index, index + (ordinalDigits !== null ? 2 : 1));
      if (['grade', 'grader', 'graders', 'serie', 'ano', 'curso', 'grau'].includes(next) && ordinal <= 12) return phrase(index, index + (ordinalDigits !== null ? 2 : 1));
    }
    if (ROMAN[token] && ['mis', 'sus', 'seus', 'meus', 'festa', 'fiesta', 'de', 'los', 'os', 'nos', 'baile'].includes(at(index - 1))) return phrase(index - 1, index);
    // R8 ano de nascimento ("born in 2010", "nascida em 2009", "class of 2027", "safra 2010", "2010 baby")
    if (/^(?:19|20)\d\d$/.test(token)) {
      const year = Number(token);
      let back = index - 1;
      while (['em', 'in', 'en', 'no', 'el', 'of', 'de', 'da', 'do'].includes(at(back))) back--;
      const before = at(back);
      if (BIRTH_WORDS.has(before) || ['safra', 'geracao', 'generation', 'generacion', 'nascimento', 'birth', 'nacimiento'].includes(before) || ['baby', 'babies', 'bebe'].includes(at(index + 1))) {
        if (isUnderFloor(CURRENT_YEAR - year)) return phrase(back, index);
      }
      if (['class', 'turma', 'promocao', 'promocion'].includes(before) && year >= CURRENT_YEAR - 7) return phrase(back, index);
    }
    // R2 verbo/rótulo + número ("she is 16", "tem só 17", "tenho 17", "aos 16", "idade aparente: 17")
    const verb = AGE_VERBS.has(token) || (token === 'de' && (at(index - 1) === 'idade' || at(index - 1) === 'edad')) || (token === 'los' && at(index - 1) === 'a') || (token === 'com' && ['to', 'tou', 'estou', 'esta', 'tava', 'estava', 'ficou', 'fica'].includes(at(index - 1)));
    if (verb && !SIZE_WORDS.has(at(index - 1)) && (strict || personBefore(tokens, index) || ['idade', 'edad', 'age', 'aged'].includes(token))) {
      let next = index + 1;
      while (next < index + 5 && SKIP.has(at(next))) next++;
      const found = numberAt(tokens, next);
      if (found && !found.decimal && isUnderFloor(found.value)) {
        const tail = at(found.end + 1);
        const durationAfter = UNITS.has(tail) && isDuration(tokens, found.start, found.end + 1);
        const fazQue = token === 'faz' && (tail === 'que' || at(found.end + 2) === 'que');
        // pedido livre: verbo vago só com o número fechando o trecho; verbo de idade, desde que o número não conte nada
        const freeAge = !freeMode || (VAGUE_AGE_WORDS.has(token) ? closesAsAge(tokens, found.end) : !countsSomething(tail));
        if (freeAge && !COUNT_NOUNS.has(tail) && !durationAfter && !fazQue && !(tail === 'e' && at(found.end + 2) === 'vem')) return phrase(index, found.end);
      }
    }
    // R3 pessoa ou festa + de/of + número ("garota de 16", "girl of seventeen", "festa de 15")
    // "una de quince", "parece uma de 15": o "uma" é a pessoa
    const someone = ['una', 'uma'].includes(token) && (index === 0 || ['es', 'e', 'parece', 'como', 'tipo', 'soy', 'sou', 'like', ','].includes(at(index - 1)));
    if (PERSON_NOUNS.has(token) || EVENT_NOUNS.has(token) || someone) {
      let next = index + 1;
      while (next < index + 3 && ['de', 'of', 'com', 'con', 'with', 'aged', 'da', 'do', 'dos', 'das', 'del', 'los', 'os'].includes(at(next))) next++;
      if (next > index + 1 || ['aged'].includes(at(index + 1))) {
        const found = numberAt(tokens, next);
        if (found && !found.decimal && isUnderFloor(found.value) && !COUNT_NOUNS.has(at(found.end + 1))) {
          const tail = at(found.end + 1);
          // pedido livre: "com/con/with" + número é quase sempre contagem ("woman with two men"); vale só fechando o trecho
          const viaWith = tokens.slice(index + 1, next).some((word) => ['com', 'con', 'with'].includes(word));
          const freeAge = !freeMode || (viaWith ? closesAsAge(tokens, found.end) : !countsSomething(tail));
          if (freeAge && !(UNITS.has(tail) && isDuration(tokens, found.start, found.end + 1))) return phrase(index, found.end);
        }
      }
    }
  }
  if (labelOnCommerce) return null;
  // R9 trecho só com o número ("Valentina, 16, loira", "Ana (16)", "16F", "[F16]", "16/F"): vale nos dois lados,
  // porque o texto livre vai ao prompt (copy de produto quase nunca tem número sozinho entre vírgulas)
  // pedido livre: o número sozinho só é idade com pessoa, nome ou rótulo de idade no trecho de antes ("Ana, 16",
  // "1girl, 15") ou pessoa no de depois ("16, blonde girl"); "seed": 1, listas "1)" e "images 1, 2" não são idade
  const segments: string[][] = [];
  let segment: string[] = [];
  for (const token of [...tokens, ',']) {
    if (token !== ',') {
      segment.push(token);
      continue;
    }
    if (segment.length) segments.push(segment);
    segment = [];
  }
  for (let index = 0; index < segments.length; index++) {
    const current = segments[index];
    const marked = current.length === 2 && (['f', 'm', 'fem', 'female', 'male'].includes(current[0]) || ['f', 'm', 'fem', 'female', 'male'].includes(current[1]));
    const numberToken = current.length === 1 ? current[0] : marked ? current.find((part) => !['f', 'm', 'fem', 'female', 'male'].includes(part)) : undefined;
    if (numberToken === undefined) continue;
    const found = numberAt([numberToken], 0);
    if (!found || found.decimal || !isUnderFloor(found.value)) continue;
    // pedido livre: "1 male, 1 female" é contagem de gente; "16F" e "[F16]" seguem idade
    const markedAge = marked && (!freeMode || found.value >= 6);
    if (!freeMode || markedAge || namesSomeone(segments[index - 1]) || startsWithSomeone(segments[index + 1])) return current.join(' ');
  }
  return null;
}

/** O texto diz uma idade adulta (25 a 99): "de 26 anos", "aged 30", "tem 28", "Ana, 29". */
function hasAdultAge(text: string): boolean {
  const tokens = ageTokens(text);
  for (let index = 0; index < tokens.length; index++) {
    const found = numberAt(tokens, index);
    if (!found || found.decimal || found.value < ageFloor || found.value > 99) continue;
    const tail = tokens[found.end + 1];
    if (tail === undefined || tail === ',' || UNITS.has(tail) || AGE_VERBS.has(tokens[index - 1] ?? '')) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ nome de pessoa real */

/** Primeiros nomes comuns (pt/en/es) e de famosas: depois de "parecida com", "looks like"… já barram, até em minúscula. */
const FIRST_NAMES = new Set(
  (
    'ana analu adriana aline alice alessandra amanda andressa angelica barbara beatriz bia bianca bruna camila carla catarina cecilia clara claudia cristina ' +
    'daniela debora deborah denise eduarda elaine eliane elisa eloa emanuelle fabiana fernanda flavia gabriela gabi giovanna gisele giulia grazi graziela helena ' +
    'heloisa ingrid isabela isabella isadora isis ivete jessica joana julia juliana juliette karina karla kelly lais lara larissa laura leticia lilian livia lorena ' +
    'luana lucia luciana luisa luiza maite manuela marcela maria mariana marina marta mayara melissa michele milena mirella monica nadia natalia nathalia nicole ' +
    'paloma paola paolla patricia paula pietra priscila rafaela raissa raquel rebeca renata roberta rosana sabrina samara sandra sara sarah silvia simone sophia ' +
    'sofia stella tais thais talita tatiana tamires thalita valentina vanessa vera veronica viviane yasmin abigail addison alexa alexandra alexis alicia alison ' +
    'amelia anna anya ariana ashley ava avril billie britney brooke charlotte chloe christina claire demi doja dua elizabeth ella emily emilia emma gigi gwen ' +
    'hailey halle hannah jennifer jenna jojo kaia katy kate katie kendall khloe kim kourtney kylie lana lauren lindsay lisa lizzo margot megan melanie mia miley ' +
    'millie miranda natalie nicki olivia penelope rachel rebecca riley rita salma samantha scarlett selena sophie tiffany zoe abella sasha corinna alejandra ' +
    'andrea antonela belinda carmen danna esther eugenia eiza guadalupe isabel jimena karol lali martina natti paulina rocio rosalia tini thalia ursula valeria ' +
    'ximena yailin aitana wanda kenia becky anitta ludmilla xuxa mel adam alex andre antonio arthur brad bruno caio carlos chris cristiano daniel david diego ' +
    'dwayne eduardo enzo fabio felipe fernando gabriel gustavo harry henrique hugo igor jason joao jorge jose justin kevin leonardo lucas luis luiz marcelo ' +
    'marcos mateus matheus michael miguel neymar nicolas pablo pedro rafael ricardo robert rodrigo ryan samuel sergio shawn thiago tiago timothee tom vinicius ' +
    'vini william zac'
  ).split(' '),
);
/** Nome que também é palavra, cidade ou marca: só conta com o sobrenome depois ("Paris Hilton", mas não "estilo de Paris"). */
const AMBIGUOUS_NAMES = new Set(
  (
    'paris london victoria florence georgia carolina virginia madison sydney savannah brooklyn austin dallas india asia africa america chelsea jordan aurora luna ' +
    'rosa flor luz paz estrela perola gloria alegria jade ruby amber ivy rose lily daisy violet summer dawn april may june grace hope faith joy angel angela bella ' +
    'linda sol mar dior chanel zara celine barbie venus diana eva iris lola coco sky rain star crystal diamond honey candy cherry ginger hazel olive autumn holly ' +
    'taylor gal bonita'
  ).split(' '),
);
/** Palavras com maiúscula que não são nome (estética, nacionalidade, época): não contam como "Nome Sobrenome". */
const NOT_NAME_WORDS = new Set(
  (
    'old new y2k clean girl coquette money secret style fashion week vibe vibes aesthetic core look glam chic boho pin up gothic goth emo vintage retro latina latino ' +
    'brazilian brasileira asian japanese korean italian french russian nordic scandinavian mediterranean tropical summer winter spring autumn beach city street urban ' +
    'luxury rich quiet soft dark light natural red black white gold golden silver pink blue green hollywood bollywood age art deco nouveau renaissance baroque ' +
    'victorian edwardian greek roman egyptian angels angel princess queen goddess model models makeup hair face body skin eyes look looks magazine cover runway ' +
    'carnaval carnival festival party ibiza miami dubai tulum bali rio sao paulo bahia nordeste portugal brasil brazil mexico argentina colombia spain espanha ' +
    'anjo boneca doll deusa rainha gata diva mulher woman sereia mermaid fada fairy bruxa witch vampira vampire elfa elf vogue elle harper bazaar playboy ' +
    'cosmopolitan maxim gq instagram tiktok pinterest netflix disney marvel barbie'
  ).split(' '),
);
/** Frases que costumam vir antes de um nome num pedido de rosto real. */
const LOOKALIKE_PHRASES = new RegExp(
  `(?:^| )(?:${[
    'parecid[ao]s? (?:com|a|con)',
    'parecidissim[ao] (?:com|a|con)',
    'igual(?:zinha|zinho|ita|ito)? (?:a|ao|que|al)',
    'identic[ao] (?:a|ao|con)',
    'looks? (?:just |exactly |a lot |kind of |kinda |so much |very much )?like',
    'similar (?:to|a|com|con)',
    'resembl\\w*',
    'inspired by',
    'inspirad[ao] (?:em|na|no|en|por|pela|pelo)',
    'in the style of',
    'style of',
    'estilo(?: (?:da|do|de))?',
    'rosto (?:da|do|de)',
    'cara (?:da|do|de)',
    'face of',
    'como(?: (?:a|o|la|el))?',
    'tipo(?: (?:a|o))?',
    'se parece (?:a|con|com)',
    'versao (?:da|do|de)',
    'version (?:of|de)',
    'a mix of',
    'mix (?:de|of)',
    'mistura de',
    'mezcla de',
    'cosplay (?:de|of|da|do)',
    'vestida de',
    'dressed as',
    'fantasiada de',
  ].join('|')})(?= |$)`,
  'g',
);
/** Entre a frase e o nome ("parecida com a atriz Isis…", "looks like the singer…"). */
const NAME_FILLERS = new Set(
  (
    'a o as os the la el las los um uma un una an atriz actress actriz cantora cantante singer famosa famoso famous celebridade celebrity celebridad influencer ' +
    'influenciadora youtuber tiktoker streamer modelo model apresentadora presenter jovem young joven estrela star diva rapper mc da do de'
  ).split(' '),
);

interface NameToken {
  lower: string;
  capitalized: boolean;
}

/** Palavras do texto original (para saber o que tem maiúscula), já com letras trocadas e sem acento. */
function nameTokens(original: string): NameToken[] {
  const text = mapConfusables(mapDigits(original.normalize('NFKC').replace(INVISIBLE, '')))
    .replace(PICTOGRAPHIC, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(APOSTROPHES, "'")
    // personagem e frase liberada ("Jessica Rabbit", "same face as the base photo") não vira nome
    .replace(LOOKALIKE_ALLOW_ORIGINAL, ' ');
  return text
    .split(/[^A-Za-z0-9']+/)
    .filter(Boolean)
    .map((word) => ({
      lower: word.toLowerCase(),
      // palavra toda em maiúscula (caps lock) não diz que é nome
      capitalized: /^[A-Z][a-z]/.test(word),
    }));
}

function findLookalike(original: string, texts: readonly string[]): string | null {
  const allowed = without(texts, ALLOW.lookalike);
  const strong = findIn(allowed, LISTS.strong);
  if (strong) return strong;
  const celebrity = findIn(allowed, LISTS.celebrities);
  if (celebrity) return celebrity;
  // "@kyliejenner", "#taylorswift"
  for (const text of allowed) {
    for (const word of text.split(' ')) {
      if (word.length < 8) continue;
      const glued = GLUED_CELEBRITIES.find((name) => word.includes(name));
      if (glued) return glued;
    }
  }
  // frase de pedido + nome ("parecida com isis", "looks like Paris Hilton", "estilo Emma Stone")
  const tokens = nameTokens(original);
  const joined = tokens.map((token) => token.lower).join(' ');
  for (const match of joined.matchAll(LOOKALIKE_PHRASES)) {
    const end = (match.index ?? 0) + match[0].length;
    let next = joined.slice(0, end).split(' ').filter(Boolean).length;
    let fillers = 0;
    while (next < tokens.length && fillers < 3 && NAME_FILLERS.has(tokens[next].lower)) {
      next++;
      fillers++;
    }
    const name = tokens[next];
    if (!name || name.lower.endsWith("'s")) continue;
    const surname = tokens[next + 1];
    const surnameCapitalized = Boolean(surname && surname.capitalized && !NOT_NAME_WORDS.has(surname.lower) && !surname.lower.endsWith("'s"));
    // só nome de gente conhecido conta: palavra com maiúscula qualquer é quase sempre marca, lugar ou estética
    // ("estilo da Calvin Klein", "cara de Salvador", "igual ao AirPods", "Old Money"); nome fora da lista fica para a
    // trava da API, como o nome sozinho sem frase
    if (FIRST_NAMES.has(name.lower)) return `${match[0].trim()} ${name.lower}`;
    if (AMBIGUOUS_NAMES.has(name.lower) && surnameCapitalized) return `${match[0].trim()} ${name.lower} ${surname.lower}`;
  }
  return null;
}

/* ------------------------------------------------------------------ conferência */

/**
 * Confere um texto livre. Ordem: texto que tenta desligar a trava, idade e menor de idade (sempre), persona de escola
 * (menos no rótulo de vender), criança e pistas infantis (18+), traço infantil (desenhado), conteúdo adulto (lado de
 * vender) e pessoa real.
 */
export function checkAdultOnly(text: string, options: SafetyOptions = {}): SafetyVerdict {
  ageFloor = options.floor ?? 25;
  freeMode = Boolean(options.free);
  if (!text || !text.trim()) return OK;
  if (CHILD_EMOJI.test(text)) return { ok: false, reason: 'minor', term: text.match(CHILD_EMOJI)?.[0] ?? '' };
  const labelOnCommerce = Boolean(options.label && !options.adult);
  const strict = Boolean(options.adult || options.drawn);
  // com o acento (antes de tirar): "niña" (≠ "Nina"), "babá" (≠ "baba"), "maiô" (≠ "maio", o mês)
  const accented = text.normalize('NFKC').replace(INVISIBLE, '').replace(PICTOGRAPHIC, '').normalize('NFC').toLowerCase();
  const spanishChild = accented.match(/(?:^|[^\p{L}])(niñ(?:a|o|as|os|ita|itas|ito|itos))(?=$|[^\p{L}])/u);
  if (spanishChild) return { ok: false, reason: 'minor', term: spanishChild[1] };
  const texts = variants(text);
  // no pedido livre não existe instrução "totalmente vestida" para desligar, e "ignore previous instructions" não pode
  // encerrar a conferência antes da leitura de menor
  if (!freeMode) {
    const override = findIn(texts, LISTS.override);
    if (override) return { ok: false, reason: 'override', term: override };
  }
  const age = underageNumber(text, strict, labelOnCommerce);
  if (age) return { ok: false, reason: 'minor', term: age };
  const minor = findIn(texts, freeMode ? LISTS.minorHardFree : LISTS.minorHard);
  if (minor) return { ok: false, reason: 'minor', term: minor };
  if (!labelOnCommerce) {
    const persona = findIn(texts, LISTS.minorPersona);
    if (persona) return { ok: false, reason: 'minor', term: persona };
  }
  if (options.adult) {
    // com idade adulta escrita ("estudante universitária de 26 anos"), estudante deixa de ser pista de menor
    const allowed = without(texts, hasAdultAge(text) ? ALLOW.adultWithAge : freeMode ? ALLOW.adultFree : ALLOW.adult);
    // "babá" (≠ "baba") e "bebê/bebé" com acento (sem acento, "e bebe vinho" é o verbo)
    const accentedChild = accented.match(/(?:^|[^\p{L}])(babás?|beb[êé]s?)(?=$|[^\p{L}])/u);
    if (accentedChild) return { ok: false, reason: 'minor', term: accentedChild[1] };
    const child = findIn(allowed, LISTS.child);
    if (child) return { ok: false, reason: 'minor', term: child };
    if (freeMode) {
      // pedido livre: rosto, corpo e objeto de criança barram sozinhos; petite, tiny, braces, pigtails, kawaii, cute… só
      // em pedido sexual, e aí no desenhado uma basta e no realista só 3 juntas ("kawaii mascot" de infográfico passa)
      const strongCue = findIn(allowed, LISTS.childlikeStrong);
      if (strongCue) return { ok: false, reason: 'childlike', term: strongCue };
      if (findIn(texts, LISTS.adult)) {
        if (options.drawn) {
          const cue = findIn(without(texts, ALLOW.adultFree), LISTS.drawn);
          if (cue) return { ok: false, reason: 'drawnTerm', term: cue };
        } else {
          // contadas só na forma com espaços (a forma colada junta "innocent looking" e contaria a mesma pista duas vezes)
          const weak = new Set<string>();
          for (const match of (allowed[0] ?? '').matchAll(LISTS.childlikeWeak)) weak.add(match[1].replace(/\s+/g, ''));
          if (weak.size >= 3) return { ok: false, reason: 'childlike', term: [...weak].slice(0, 3).join(' + ') };
        }
      }
    } else {
      const cue = findIn(allowed, LISTS.childlike);
      if (cue) return { ok: false, reason: 'childlike', term: cue };
    }
  }
  if (options.drawn && !labelOnCommerce && !freeMode) {
    const cue = findIn(without(texts, ALLOW.adult), LISTS.drawn);
    if (cue) return { ok: false, reason: 'drawnTerm', term: cue };
  }
  if (!options.adult && !options.label) {
    const swimsuit = accented.match(/(?:^|[^\p{L}])(maiôs?)(?=$|[^\p{L}])/u);
    if (swimsuit) return { ok: false, reason: 'adultOnCommerce', term: swimsuit[1] };
    const adultTerm = findIn(without(texts, ALLOW.commerce), LISTS.adult);
    if (adultTerm) return { ok: false, reason: 'adultOnCommerce', term: adultTerm };
  }
  if (options.lookalike !== false) {
    const lookalike = findLookalike(text, texts);
    if (lookalike) return { ok: false, reason: 'lookalike', term: lookalike };
  }
  return OK;
}

/**
 * Texto que pode entrar no prompt: barrado vira vazio; o que passa entra sem emoji e sem caracteres invisíveis. Confere
 * o texto digitado E o que vai de fato ao prompt (tirar o emoji não pode religar um termo barrado).
 */
/** O texto pede conteúdo adulto (nudez, sexo, lingerie, biquíni, sensual…)? Mesma lista do lado de vender. */
export function hasAdultTerms(text: string): boolean {
  if (!text || !text.trim()) return false;
  return findIn(variants(text), LISTS.adult) !== null;
}

export function safeFreeText(text: string, options: Omit<SafetyOptions, 'label'> = {}): string {
  const cleaned = cleanForPrompt(text);
  if (!checkAdultOnly(text, options).ok || !checkAdultOnly(cleaned, options).ok) return '';
  return cleaned;
}
