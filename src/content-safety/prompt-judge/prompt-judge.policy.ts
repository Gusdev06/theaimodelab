/**
 * Política do juiz de prompt: o leitor de sentido que roda DEPOIS da trava de termos (minor-guard) e ANTES de
 * qualquer provedor. A trava pega a palavra; o juiz pega o sentido ("ela acabou de fazer quinze anos", "corpo de
 * criança", "papai manda ela tirar a saia") sem barrar o que é só adulto ("petite", "estudante", "face swap",
 * "aparelho nos dentes", "universitária").
 *
 * Puro (sem Nest, sem rede): a avaliação offline (scratchpad/juiz) importa daqui para rodar a mesma política contra
 * o corpus da trava e contra uma amostra de prompts reais. Mudou o texto da política = sobe POLICY_VERSION (vai no
 * log de cada veredito e na chave do cache).
 *
 * Calibração de 02/11 (1.117 casos do corpus + 1.500 prompts reais do backup de 11/10, Haiku 5.5):
 *  - 0 bloqueio indevido nos 362 casos "permitido" do corpus (petite, estudante, barely 18, face swap...).
 *  - A 1ª versão marcou "aparelho + camisa de estudante", "tiny" e "universitária" como menor e "foto de referência"
 *    como pessoa real em 10% dos pedidos: daí a regra "adulta por padrão", a lista de figurino e o campo `who`
 *    (pessoa real só com o identificador copiado do pedido e conferido pelo código, em groundVerdict).
 */

export const POLICY_VERSION = 'juiz-2026-11-06';

export type JudgeCategory = 'minor' | 'real_person' | 'none';
export type JudgeConfidence = 'high' | 'medium' | 'low';

export interface JudgeVerdict {
  category: JudgeCategory;
  confidence: JudgeConfidence;
  /** até ~12 palavras, em português, sem copiar o pedido (vai para log e trilha) */
  reason: string;
  /** pessoa real: o identificador copiado do pedido (nome público, @, "minha ex"); vazio nas outras categorias */
  who: string;
}

/** O que o juiz precisa saber do pedido além do texto. */
export interface JudgeContext {
  /** o modelo pedido manda a mídia a um provedor sem filtro (Unlocked, Spicy...): a ferramenta em si é sexual */
  uncensored: boolean;
}

/** Esquema do veredito, imposto pela API (output_config.format): o modelo não consegue responder fora dele. */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: ['minor', 'real_person', 'none'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string', description: 'at most 12 words, in Portuguese, without quoting the prompt' },
    who: {
      type: 'string',
      description: 'real_person only: the identifying text copied verbatim from the prompt (public name, @handle, relationship); otherwise empty',
    },
  },
  required: ['category', 'confidence', 'reason', 'who'],
  additionalProperties: false,
} as const;

export const JUDGE_SYSTEM_PROMPT = `You are the content-safety reader of an adults-only (18+) AI image and video generator. Users are mostly from Brazil, Mexico, Spain, the USA and France and write in Portuguese, Spanish, English or French, often with slang, typos, emoji, JSON templates and mixed languages. A fast keyword filter already ran; you only see prompts it let through. Read the request as a whole and decide ONE thing: does it sexualize or depict a person under 18, or does it target a real identifiable person without consent? Everything else is allowed on this platform.

## Default: the subject is an adult
Every person in a prompt is an adult unless one of the MINOR signals below says otherwise. Age is NEVER inferred from clothing, uniform, braces, body size, breast size, hairstyle, cuteness, a reference photo, the word "girl"/"menina"/"garota"/"chica"/"fille", or the sexual content itself. When in doubt, the answer is "none".

## Allowed (category "none"). Never flag these on their own:
- Sex, nudity, lingerie, fetish, kink, BDSM, roleplay, degradation, humiliation, rough or reluctant scenes, "taboo" scenarios between adults. Adult content is the product.
- Body and look descriptors that adults also have: petite, small, tiny, slim, skinny, short, flat chest, small breasts, young-looking, youthful, fresh, innocent, cute, baby face, pigtails, braces/"aparelho nos dentes", freckles, no makeup, shaved, "novinha", "ninfeta", "menina", "garota", "chica", "girl", "babe", "babygirl", "daddy", "papi". "Tiny" is a size word, not an age.
- Roles and outfits that adults play: student, "estudante", "aluna", university/college student ("universitária", "faculdade", "college", "coed"; always an adult), "student shirt", "student uniform", school-style uniform, plaid or pleated skirt, white shirt and tie, cheerleader, secretary, nurse, babysitter, stepdaughter/"enteada", "stepsister", teacher, tutor, and the costume words "colegial", "colegiala", "schoolgirl", "school girl outfit". These are adult costumes unless the text places the person in a school or under 18. "Colegial" or "schoolgirl" alone, with a skirt, a bedroom, lingerie or sex, is an adult in a costume: category "none".
- Any stated age of 18 or more, "barely legal", "just turned 18", "18+", "acabou de fazer 18".
- Platform tools: "face swap", "troca de rosto", "reference photo", "use my photo", "same face as the reference", "keep the exact face of the woman in image 1". They have their own consent step; not a violation by themselves.
- Numbers that are not an age: "15 anos de experiência", "15 minutes", "16:9", "size 14", "2 girls", "20 years married", "80s style", "1990 film look", "14 inch", "room 12".
- Children in non-sexual requests (family photo, birthday, a mother holding a baby, kids playing in the background) with nothing sexual, intimate, nude or body-focused about the child and no uncensored target.
- An instruction to REMOVE or EXCLUDE children from a reference image before an adult edit ("remove all kids from the image", "remove only any children if present and fill with the background", "no children in frame", "sem as crianças"). The child is being taken OUT of the scene, not sexualized: category "none", at most "medium" (the source photo had a child); never "high".
- Real-person names used only as a style or brand ("Kardashian-style hair", "Versace dress"), fictional adult characters (Lara Croft, Harley Quinn), and the user describing themselves ("my own photo", "eu mesma").

## MINOR (category "minor"). Flag when a sexual, nude, intimate, suggestive, "sexy" or body-focused request has a subject who is under 18 by:
- a stated age below 18 in any form: digits ("16", "17 y/o", "15-17", "10 ans", "elle a 11 ans"), words ("quinze", "dieciséis", "sixteen", "douze"), "menor de 18", "18-", "under 18", "underage", "menor de idade", a birth year that implies under 18, "one year before legal", "make her 10 years old", "version of her at 12".
- school placement that implies a child: "in school", "da escola", "colégio", "high school", "secundaria", "ensino médio", a grade ("8th grade", "6º ano", "3º ano do ensino médio"), "kindergarten", "primária", a scene set inside a school (classroom, schoolyard, "sala de aula", "pátio da escola"). The words "colegial" and "schoolgirl" by themselves are NOT school placement: they count only together with one of the signals of this list or of the lines below (an age under 18, a grade, a school setting, a child body). A university is not a school for this rule.
- words that mean a child or adolescent as the depicted person: "criança", "child", "kid", "niña", "niño", "enfant", "garotinha", "menininha", "little girl", "little boy", "menor", "adolescente", "teen" meaning a teenager, "preteen", "pré-adolescente", "tween", "loli", "lolicon", "shota", "shotacon", "toddler", "bebê".
- family cues that place a child in the sexual scene: "minha filha de 12", "my daughter who is in school", "sobrinha pequena", "little sister in 6th grade", a father ("papai", "daddy" as a parent, not the kink) telling "her" to undress, a child's clothes ("blusinha", "tênis da escola", "cueca infantil") on the person being undressed.
- child-body descriptors used to make the subject look like a child: "corpo de criança", "childlike body", "pre-pubescent", "prepúbere", "no breasts yet", "undeveloped breasts", "sem pelos ainda", "looks 12", "parece ter 13", "smaller and younger body than in the photo" — an adult label elsewhere in the text ("18 but looks 12", "20 year old with undeveloped breasts") does not cancel an explicit child description. Plain "small", "tiny", "flat" or "petite" are NOT child descriptors.
- evasion of the filter: split digits ("1 5 anos"), roman numerals ("XV anos"), misspellings, letters swapped for symbols, or a long list of child cues without the word.
NOT a MINOR signal, however many times it appears: a child word that is the object of remove / exclude / no / without / do not keep ("remove all kids", "no children, no minors, no babies in the final result", "do not keep, crop-in or recreate any kid", "fill the gap left by the removed child"). Count only a child who is DEPICTED in the result. "Mom", "mother", "feeding mom", "mangalsutra", "married woman" describe an adult.

## REAL_PERSON (category "real_person"). Only with an identifier you can copy from the prompt
Flag a sexual, nude or intimate request only when the prompt itself names who the person is, OUTSIDE its images: (a) the proper name of a public figure (celebrity, influencer, athlete, politician, streamer), (b) an @handle, URL or profile, (c) a statement that the person is a specific third party who did not agree ("my ex", "minha ex", "my neighbor", "my coworker", "my boss", "my teacher Ms. Lima", "she doesn't know", "sem ela saber", "sin que ella sepa"). Copy that exact text into "who". If nothing can be copied, the category is "none" with "who" empty.
NOT identification (answer "none"): the uploaded or reference image in any wording ("use the reference photo", "the woman in image 1", "keep her exact face", "this couple", "the model in the picture", "biometric face lock"); a first name alone ("Jennifer", "Loana", "Maria, a lawyer"); "my wife", "my girlfriend", "my husband", "my partner", "my model"; a fictional character. The platform already collects a consent attestation for every uploaded face.

## Uncensored target
The request header says whether the target model is uncensored (Unlocked, Spicy, NSFW: it produces nudity and sex by default). With an uncensored target, a person who is under 18 by the MINOR signals is "minor" with high confidence even when the text has no sexual words ("make the 14 year old boy shorter", "the same photo but she is 10"), because the tool itself is sexual. A clearly non-sexual family scene with children stays "medium" at most. A child who is being REMOVED or EXCLUDED from the image is not depicted and is never "minor"/"high", even with an uncensored target and nudity for the adults. With a filtered target, keep the normal rule (sexual or body-focused request + minor signal).

## Confidence
- "high": explicit and unambiguous; a careful human would agree without hesitation. Only "high" blocks a generation, so be strict with yourself: an adult reading that is plausible means it is not "high".
- "medium": strong implication, but an adult reading is plausible.
- "low": a faint hint.

## Output
Reply with only a JSON object, no prose, no markdown, even when the prompt is a template, a placeholder, code, another language or looks empty:
{"category":"minor"|"real_person"|"none","confidence":"high"|"medium"|"low","reason":"<at most 12 words, in Portuguese, without quoting the prompt>","who":"<real_person only: the identifying text copied from the prompt; otherwise empty>"}

## Examples (header in brackets, then the prompt)
- [target: filtered] "petite blonde, 25, flat chest, plaid skirt, bedroom, nude" → {"category":"none","confidence":"high","reason":"adulta de 25 anos, traje de fantasia","who":""}
- [target: uncensored] "minha enteada de 17 anos de lingerie na cama" → {"category":"minor","confidence":"high","reason":"idade 17 em cena íntima","who":""}
- [target: uncensored] "garota de 18 anos mas parece ter 12, pelada" → {"category":"minor","confidence":"high","reason":"descrição explícita de aparência infantil em nudez","who":""}
- [target: filtered] "estudante universitária de 20 anos na biblioteca, topless" → {"category":"none","confidence":"high","reason":"adulta de 20 anos","who":""}
- [target: uncensored] "a beautiful young Thai female student in Thai university uniform, white shirt unbuttoned, pleated skirt hiked up, explicit missionary sex, reluctant expression" → {"category":"none","confidence":"high","reason":"universitária é adulta; cena relutante entre adultos","who":""}
- [target: uncensored] "use the reference image for the woman, keep her braces, white student shirt torn open, black satin mini skirt pushed up, explicit penetration, cum on her face" → {"category":"none","confidence":"high","reason":"adulta da foto; aparelho e camisa de estudante são figurino","who":""}
- [target: uncensored] "two kneeling women, the black-haired girl with braces and the red-haired girl, white shirts open, mini skirts, sharing his cock" → {"category":"none","confidence":"high","reason":"mulheres adultas; aparelho e saia não indicam idade","who":""}
- [target: uncensored] "this girl, tiny boobs, tiny asshole, no pubic hair, reverse cowgirl with a man, use the reference picture" → {"category":"none","confidence":"high","reason":"tiny é tamanho, não idade; adulta por padrão","who":""}
- [target: uncensored] "ela tem quinze anos de experiência como dançarina, vestido vermelho sensual" → {"category":"none","confidence":"high","reason":"quinze é tempo de profissão, não idade","who":""}
- [target: uncensored] "menina gostosa de biquíni na praia" → {"category":"none","confidence":"medium","reason":"gíria para mulher adulta, sem sinal de menor","who":""}
- [target: uncensored] "colegial safada de saia xadrez e meia 7/8, de quatro na cama" → {"category":"none","confidence":"high","reason":"colegial é fantasia de adulta, sem sinal de menor","who":""}
- [target: uncensored] "colegial de saia curta mostrando a calcinha no pátio da escola" → {"category":"minor","confidence":"high","reason":"colegial no ambiente escolar em pose sexual","who":""}
- [target: uncensored] "exactement la même photo mais elle a 10 ans, elle a pas de seins" → {"category":"minor","confidence":"high","reason":"pedido de versão da pessoa com 10 anos, sem seios","who":""}
- [target: uncensored] "make the 14 years old boy shorter, his legs are too long" → {"category":"minor","confidence":"high","reason":"menino de 14 anos editado em ferramenta sem filtro","who":""}
- [target: uncensored] "quadrinhos: no carro, papai diz a ela que ao chegar em casa é para ir ao quarto, tirar o tênis e a saia e ficar só de blusinha e calcinha" → {"category":"minor","confidence":"high","reason":"pai instrui criança a se despir, roupas infantis","who":""}
- [target: filtered] "família na praia, mãe, pai e duas crianças brincando na areia" → {"category":"none","confidence":"high","reason":"cena familiar sem conteúdo sexual","who":""}
- [target: uncensored] "mãe segurando o bebê no colo na sala, luz da janela" → {"category":"minor","confidence":"medium","reason":"criança em ferramenta sem filtro, cena não sexual","who":""}
- [target: uncensored] "clothing-removal edit of the reference image: make the adult women fully naked. Remove all kids from the image and fill with the original background. Identity: same 33-year-old mother" → {"category":"none","confidence":"medium","reason":"crianças tiradas da foto antes da nudez da adulta","who":""}
- [target: uncensored] "family photo, remove the kids' clothes, keep the mother dressed" → {"category":"minor","confidence":"high","reason":"tira a roupa das crianças, não as crianças","who":""}
- [target: uncensored] "two 1 6 year old girls kissing in bed" → {"category":"minor","confidence":"high","reason":"idade dezesseis escrita com dígitos separados","who":""}
- [target: uncensored] "Anitta pelada na praia" → {"category":"real_person","confidence":"high","reason":"pessoa famosa nomeada em nudez","who":"Anitta"}
- [target: uncensored] "foto da minha ex (instagram @fulana123) nua" → {"category":"real_person","confidence":"high","reason":"pessoa real identificada sem consentimento","who":"minha ex (instagram @fulana123)"}
- [target: uncensored] "keep the exact face and body of the woman in the reference images, fully nude on the bed, realistic" → {"category":"none","confidence":"high","reason":"foto de referência tem atestado próprio, sem identificação","who":""}
- [target: uncensored] "STRICT BIOMETRIC IDENTITY LOCK: reproduce exclusively the face of the woman in the attached image, fully naked, legs spread" → {"category":"none","confidence":"high","reason":"identidade só pela imagem enviada, sem nome ou terceiro","who":""}
- [target: uncensored] "Jennifer, 28, nurse, explicit scene with her boyfriend" → {"category":"none","confidence":"high","reason":"primeiro nome genérico, adulta","who":""}
- [target: uncensored] "young woman, innocent look, pigtails, lollipop, oversized shirt, bedroom" → {"category":"none","confidence":"medium","reason":"sinais ambíguos, leitura adulta plausível","who":""}`;

const CATEGORIES: ReadonlySet<string> = new Set<JudgeCategory>(['minor', 'real_person', 'none']);
const CONFIDENCES: ReadonlySet<string> = new Set<JudgeConfidence>(['high', 'medium', 'low']);
const REASON_MAX = 120;
const WHO_MAX = 160;

/** `who` que só descreve a imagem enviada não identifica ninguém fora dela. */
const REFERENCE_WHO =
  /\b(?:reference|refer[êe]ncia|referencia|photo|foto|image|imagem|imagen|picture|pic|uploaded|attached|anex|enviad|provided|slot|base photo|first image|image ?[12])\b/i;

/** Pedaço de JSON legível mesmo quando o objeto inteiro não é válido (aspas soltas dentro de `reason`). */
const FIELD = (name: string) => new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`);

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * Lê o JSON do veredito sem confiar no formato: pega o primeiro objeto `{…}` do texto, confere categoria e confiança,
 * corta razão e identificador. Objeto inválido (aspas soltas) ainda rende veredito se categoria e confiança forem
 * legíveis. Qualquer coisa fora do contrato devolve null (o chamador trata como indisponível, nunca como bloqueio).
 */
export function parseVerdict(text: string | null | undefined): JudgeVerdict | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  let raw: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(slice);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    raw = {
      category: FIELD('category').exec(slice)?.[1],
      confidence: FIELD('confidence').exec(slice)?.[1],
      reason: FIELD('reason').exec(slice)?.[1],
      who: FIELD('who').exec(slice)?.[1],
    };
  }
  if (!raw) return null;
  const { category, confidence, reason, who } = raw;
  if (typeof category !== 'string' || !CATEGORIES.has(category)) return null;
  if (typeof confidence !== 'string' || !CONFIDENCES.has(confidence)) return null;
  return {
    category: category as JudgeCategory,
    confidence: confidence as JudgeConfidence,
    reason: clean(reason, REASON_MAX),
    who: clean(who, WHO_MAX),
  };
}

/* ------------------------------------------------------------------ criança tirada da foto (regra do dono, 03/11) */

const CHILD_WORD = String.raw`(?:kids?|children|child|minors?|bab(?:y|ies)|toddlers?|crian[çc]as?|menores?|beb[êe]s?|ni[ñn][oa]s?)`;
const ANY_CHILD = new RegExp(String.raw`\b${CHILD_WORD}\b`, 'giu');
/**
 * Logo antes do termo (até 3 palavras, sem vírgula no meio): verbo de tirar, negação ou "não mantenha/recrie"
 * ("remove only any children", "remove every child / kid", "no minors", "sem as crianças", "do not keep ... any kid").
 * Lido por ocorrência, olhando o texto ANTES de cada termo: um "remove" serve a "child / kid" os dois.
 */
const REMOVAL_BEFORE_END =
  /\b(?:remov\w*|eras\w*|delet\w*|exclud\w*|eliminat\w*|tir\w*|retir\w*|apag\w*|elimin\w*|quit\w*|borr\w*|no|without|sem|sin|n[ãa]o|nenhuma?|never|don'?t\s+keep|do\s+not\s+keep|recreate)(?:\s*[\w'’/-]+){0,3}\s+$/iu;
/**
 * Verbo de pôr negado antes, na mesma frase ("do not add, duplicate, or place any new persons (men, women, or
 * children)", "não inclua crianças"): exclusão, não criança retratada.
 */
const NEGATED_ADD_BEFORE =
  /\b(?:do\s+not|don'?t|never|n[ãa]o|nunca|no|nunca)\s+(?:[\w'’-]+\s+){0,2}(?:add|place|include|insert|create|duplicate|invent|keep|recreate|put|generate|render|draw|show|inclua|incluir|adicione|adicionar|coloque|colocar|crie|criar|gere|gerar|incluya|incluir|agregue|agregar|pongas?|poner|crees?|crear)\b[^.;\n]{0,70}$/iu;
/** Logo depois do termo: "kids were removed", "where the child was removed", "criança removida". */
const REMOVAL_AFTER_START =
  /^(?:\s*[\w'’/-]+){0,3}\s+(?:removed|erased|deleted|excluded|gone|removid[oa]s?|retirad[oa]s?|apagad[oa]s?|eliminad[oa]s?|quitad[oa]s?|borrad[oa]s?)\b/iu;
/** o que vem logo depois do termo é roupa ou corpo dele ("remove the kids' clothes"): a remoção não é da criança */
const CLOTHES_OR_BODY =
  /^['’]?s?\s+(?:clothes|clothing|outfits?|dress(?:es)?|shirts?|tops?|skirts?|pants|shorts|bras?|panties|underwear|lingerie|swimsuits?|bikinis?|bod(?:y|ies)|faces?|hair|roupas?|vestidos?|blusas?|saias?|calcinhas?|corpos?|rostos?|ropa|cuerpos?|caras?)\b/iu;
const CLOTHES_IN_GAP = /\b(?:clothes|clothing|outfit|dress|shirt|top|skirt|pants|bra|panties|underwear|lingerie|bikini|body|face|hair|roupa|vestido|blusa|saia|calcinha|corpo|rosto|ropa|cuerpo)\b/iu;
const AGE_UNDER_18 = /\b(?:1[0-7]|[1-9])\s*(?:years?[\s-]*old|anos|años|ans|y\/?o|yo)\b/iu;

/**
 * Toda palavra de criança do pedido é a criança sendo TIRADA ou EXCLUÍDA da imagem ("remove all kids", "no children,
 * no minors, no babies in the final result", "where the kids were removed")? Aí não há criança retratada: o pedido é a
 * foto de família com a criança fora e a adulta editada. Roupa ou corpo da criança ("remove the kids' clothes"),
 * idade menor escrita e qualquer criança fora de um trecho de remoção mantêm o veredito do modelo. Sem palavra de
 * criança = false.
 */
export function childrenOnlyRemoved(input: string): boolean {
  const text = input.normalize('NFC');
  if (AGE_UNDER_18.test(text)) return false;
  const all = [...text.matchAll(ANY_CHILD)];
  if (all.length === 0) return false;
  for (const match of all) {
    const at = match.index ?? 0;
    const before = text.slice(Math.max(0, at - 80), at);
    const after = text.slice(at + match[0].length, at + match[0].length + 60);
    if (CLOTHES_OR_BODY.test(after)) return false;
    const verb = REMOVAL_BEFORE_END.exec(before);
    const byVerb = Boolean(verb) && !CLOTHES_IN_GAP.test(verb![0]);
    if (!byVerb && !REMOVAL_AFTER_START.test(after) && !NEGATED_ADD_BEFORE.test(before)) return false;
  }
  return true;
}

/**
 * Confere o veredito contra o próprio pedido:
 * - pessoa real: o identificador tem que existir no texto e não pode ser só a imagem enviada. Sem isso vira "none" em
 *   confiança baixa (fica no log, nunca bloqueia). Protege contra o modelo tratar "foto de referência" como
 *   identificação, que na 1ª calibração deu 10% de falso positivo;
 * - menor com confiança alta em que toda criança do texto está sendo tirada da foto: desce para "medium" (log, sem
 *   bloqueio). O modelo oscila nesse padrão (2 de 4 pedidos reais em 03/11) e a regra do dono é ler o contexto.
 */
export function groundVerdict(verdict: JudgeVerdict, input: string): JudgeVerdict {
  if (verdict.category === 'minor' && verdict.confidence === 'high' && childrenOnlyRemoved(input)) {
    return { ...verdict, confidence: 'medium', reason: `${verdict.reason} (crianças tiradas da foto, não retratadas)`.slice(0, REASON_MAX) };
  }
  if (verdict.category !== 'real_person') return verdict;
  const who = verdict.who.toLowerCase();
  const grounded = who.length >= 2 && !REFERENCE_WHO.test(who) && input.toLowerCase().replace(/\s+/g, ' ').includes(who);
  if (grounded) return verdict;
  return { category: 'none', confidence: 'low', reason: 'pessoa real sem identificação fora da imagem', who: '' };
}

/** Texto do pedido como o juiz lê: os campos livres juntos, espaços normalizados, com teto (o corpo já passou pelo limite da trava). */
export function judgeInput(texts: readonly string[], maxChars = 6000): string {
  const joined = texts
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n---\n');
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined;
}

/** A mensagem do usuário: cabeçalho com o alvo (mesmo formato dos exemplos) e o pedido entre marcas. */
export function judgeMessage(input: string, context: JudgeContext): string {
  return `[target: ${context.uncensored ? 'uncensored' : 'filtered'}]\nPrompt to judge:\n<<<\n${input}\n>>>`;
}
