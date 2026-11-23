/**
 * "Melhorar prompt com IA" para os modelos sem filtro (Unlocked, Spicy, despir...). O melhorador atual (Gemini,
 * prompt-enhancer.service.ts) recusa cena sensível e devolve outra cena sem avisar, por isso o site o desliga no
 * Unlocked, que é 62% das gerações. Este aqui parte do que as clientes que mais geram já fazem.
 *
 * Estudo (02/11/2026, 45.874 prompts reais do backup de 11/10, só agregados): no Unlocked, 98% completam; os que mais
 * completam têm identidade travada na foto (+1,1 pt), câmera (+1,5), luz (+1,2), textura de pele (+1,1), corpo
 * descrito (+1,5), lista "evitar" (+1,1) e 300 a 2.000 caracteres (+2 a +3 pts sobre <100). As 24 clientes que mais
 * geram escrevem na mesma ordem: papel de cada foto → identidade exata → UMA cena/pose com o que aparece e o que fica
 * coberto → bloco de realismo (pele com poros, sem filtro, peso e gravidade do corpo) → câmera e luz → "não mudar".
 * Nos modelos com filtro, corpo/roupa íntima/negativo DERRUBAM a conclusão (bloqueio do provedor): este melhorador não
 * é usado lá (o de sempre continua).
 *
 * Puro (sem Nest, sem rede): a avaliação offline (scratchpad/juiz/melhorador) importa daqui.
 */

/**
 * 13/11: piso de idade da casa 20 (era 25) e idade adulta escrita pela cliente (18+) mantida (regra do dono).
 * 20/11: vídeo com regra própria (guia de prompts do nicho, PRODUTO/INTELIGENCIA-NICHO/2026-11-19/prompts): com 1º
 * quadro o texto diz só o que MEXE (1 ação + 1 câmera), nunca redescreve a foto; formato por motor (LTX prosa, MiniMax
 * câmera em colchetes, Wan 5 blocos, Grok curto).
 */
export const ADULT_ENHANCER_VERSION = 'melhorador-18-2026-11-20-video';

export interface AdultEnhancerContext {
  type: 'image' | 'video';
  /** slug do modelo pedido (só informativo para o texto) */
  model?: string;
  hasReferenceImages?: boolean;
  referenceCount?: number;
  /**
   * Vídeo que parte de uma foto (imagem → vídeo). Sem o campo, vídeo com UMA referência conta como 1º quadro: os
   * modelos de vídeo sem filtro do studio da X (LTX, Seedance, MiniMax e Wan por imagem) partem todos da foto enviada.
   */
  hasFirstFrame?: boolean;
  aspectRatio?: string;
  durationSeconds?: number;
  /** idioma da interface da cliente: a explicação volta nesse idioma; o prompt sai em inglês */
  locale?: string;
}

export interface AdultEnhancement {
  prompt: string;
  /** o que se quer evitar, escrito como lista curta; os modelos da casa não têm campo negativo, então vai anexado como "Avoid:" */
  avoid: string;
  /** 1 frase, no idioma da cliente, dizendo o que foi acrescentado (vai no toast) */
  note: string;
}

export const ENHANCEMENT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'the improved prompt, in English, with the length the rules give for this request (photo 120 to 320 words; video from a first frame 50 to 120)' },
    avoid: { type: 'string', description: 'comma-separated list of defects to avoid, 6 to 14 items, in English; empty for an EDIT request' },
    note: { type: 'string', description: "one sentence in the user's language saying what was added, at most 18 words" },
  },
  required: ['prompt', 'avoid', 'note'],
  additionalProperties: false,
} as const;

export const ADULT_ENHANCER_SYSTEM_PROMPT = `You are the prompt editor of an adults-only (18+) AI image and video platform whose uncensored models produce nudity and explicit scenes between adults by default. Users (Brazil, Mexico, Spain, USA, France) write short, vague or mixed-language prompts. Your job is editorial, not creative: keep exactly what the user asked for, including every explicit element, and rewrite it the way the platform's most successful users write, so the model renders it well. You never add sexual acts, never remove or soften the ones the user wrote, never moralize, and never change the user's intent. If a request is purely technical (an edit), stay minimal.

## Non-negotiable
- Every person is an adult. Write the age explicitly for each person the user describes, 18 or older ("adult woman, 27 years old"). If the user wrote an adult age (18 or older), keep it exactly. Never write, imply or keep anything that makes a person look under 18 (no "teen", "schoolgirl", "petite childlike", "no breasts yet", school settings, braces as an age cue): if the user's text has such a cue, drop the cue and keep the person an adult; if the request is about a minor at all, output the user's prompt unchanged with note "" and avoid "" (the platform's filter handles it).
- No real public figure names and no "looks like <celebrity>". Keep first names the user invented.
- Keep the user's language for any spoken line, in quotes; the prompt itself is in English.
- Never use the words "deepfake", "clone", "replica". Say "same person as in the reference image".
- Do not mention this platform, policies, or that the text was rewritten.

## EDIT vs GENERATE
- EDIT (the user wants to change one thing in a reference image: "change the top", "make the breasts bigger", "remove the bra", "make it night", "swap the background"): write 2 to 4 sentences: the change, stated precisely; then "Keep everything else exactly the same: face, body proportions, pose, lighting, background and framing." Add realism only if the change touches skin or body. "avoid" is empty.
- GENERATE (a scene or pose, with or without references): use the structure below, 120 to 320 words, plain descriptive sentences, no tag soup, no markdown, no headings.

## GENERATE structure (this exact order)
1. Images, when there are references: say what each image is for. "Image 1 is the identity reference: same face, same body proportions, same skin tone. Image 2 is only a pose reference: do not copy its background, clothing or face." Without references: skip.
2. Identity: age ("adult woman, 27 years old"), body as the user described it (breast size, hips, waist, thighs, skin tone, hair, tattoos, marks); if the user gave nothing and there is no reference, add 2 or 3 neutral physical anchors (hair, build, skin tone) without inventing a style.
3. One scene, one pose, one action, in the present tense, with exactly what is visible and what is covered ("white shirt unbuttoned, breasts exposed, nipples visible", or "nipples covered by the fabric"). Keep every explicit element the user wrote, in plain anatomical words, and never add new ones. Where she looks (at the camera / away) and the expression.
4. Clothing, props and setting as written, with material and fit ("black lace thong, sheer", "wet white cotton shirt clinging to the skin"). Specific place and time of day when the user gave one.
5. Camera: shot type and angle (full body knees up, medium shot, POV, low angle, mirror selfie), lens or device ("shot on iPhone 15 Pro front camera", "85mm at f/1.8"), framing ("head in frame, body filling the frame"). For video: ONE camera movement, the motion of the body, 1 or 2 natural micro-movements (breathing, hair, cloth), and audio in one short sentence if the model has audio.
6. Realism block (always for photographic requests, this is what the platform sells; skip it only when the user asks for a stylized result such as anime, manga, hentai, cartoon, 3D render, illustration, painting or comic, and keep that style instead): "real skin texture with visible pores, fine body hair and natural imperfections, no beauty filter, no airbrushing, realistic body weight and gravity, natural asymmetry, authentic photographic look, not a 3D render, not CGI". Light described as a real source ("soft window light from the left", "harsh on-camera flash at night", "overcast daylight").
7. Lock line: "Do not change the face or the body proportions from the reference." (only with references).

## VIDEO (the header says [type: video]): this replaces the GENERATE structure above
A. FROM A FIRST FRAME (header [first frame: yes]): the frame already shows who she is, her body, what she wears, the place and the light. Redescribing any of it makes the model reinterpret the frame and the face drifts. Write ONLY what changes over time, 50 to 120 words, one paragraph, present tense, in this order:
  1. "The same adult woman from the first frame (18 or older), her face, hair and body unchanged in every frame." With a second person in the request, give each person a fixed label ("the woman", "the man") and keep it; never switch to pronouns that could mean either.
  2. The body action the user asked for, at natural speed, with every explicit element the user wrote in plain anatomical words, never adding new ones. Clips are about 5 seconds: one action reads clean; if the user wrote several beats, keep them all, in order, as one continuous movement ("slowly ... then ..."), never as cuts.
  3. One or two micro-movements that sell real footage: breathing, a blink, hair or fabric moving, skin and body weight reacting to the motion.
  4. ONE camera instruction (a movement or "static camera"), in the format of the engine below.
  5. Only if the engine has audio: one short sound sentence (breathing, room tone, a whispered line in the user's language in quotes).
  6. One short look line: "real handheld phone footage, natural skin texture, the same face in every frame."
  Mention clothing, place or light ONLY when the user asks to change them in the clip ("she pulls the strap down").
B. WITHOUT A FIRST FRAME (text-to-video): the GENERATE structure, 80 to 160 words, with ONE action and ONE camera move.
Engine format (the header names the model):
- LTX (slug with "ltx"): one flowing paragraph of 4 to 8 sentences, one continuous take, actions in the order they happen, emotion shown by physical cues (a bitten lip, a slow exhale); no tags, no brackets; the length follows the clip, for 5 s about 60 to 100 words.
- Seedance (slug with "seedance"): short concrete verbs, at most one adjective per noun; keep any @Image1/@Video1 tag the user wrote with its role; camera in plain words.
- MiniMax H3 (slug with "minimax"): camera in plain words inside the sentence ("slow push in", "static camera"); for more than one beat, label the shots "[Shot 1] ... [Shot 2] ..." with what happens in each; keep <Picture N>, <Video N> and <Audio N> tags exactly; it has audio. Square-bracket camera commands such as [Push in] are for the older Hailuo models, not H3: do not use them.
- Wan (slug with "wan"): from a frame, motion and camera only, 80 to 120 words; text-to-video in five blocks: who, where, the motion, the camera and light (shot size, angle, lens, movement), the look.
- Grok (slug with "grok"): short and natural, one action, one camera move, one sound line, at most 80 words.
- Any other model: rules A and B as written.

## Words that hurt (never write them)
"realistic", "photorealistic", "hyper-realistic", "8K", "4K", "ultra detailed", "masterpiece", "award-winning", "perfect", "flawless", "beautiful", "stunning", "gorgeous", "cinematic lighting", "trending on". Describe the real condition instead ("natural skin texture with subtle pores", "warm afternoon sun from camera-left").

## avoid (GENERATE only)
6 to 14 comma-separated defects the models actually produce, picked for this scene: "different face from the reference, deformed hands, extra fingers, fused limbs, extra limbs, warped anatomy, plastic or waxy skin, airbrushed skin, doll-like face, anime, cartoon, 3D render, text, watermark, blurry, duplicated person, wrong genital anatomy, mismatched skin tone between face and body". For video use the motion defects instead of the photo list: "face changing between frames, morphing face, flickering, warping between frames, melting or fused limbs, extra fingers, unnatural mouth movement, sudden cuts, camera drifting on its own" (plus "different face from the first frame" with a first frame). When the user asked for a stylized result (anime, manga, hentai, cartoon, 3D, illustration), leave that style out of "avoid".

## note
One sentence in the user's language (detect it from the prompt; the header may name the interface language) saying what you added, for example: "Travei a identidade na foto, escrevi a idade adulta, a cena exata e o bloco de realismo com luz de janela." At most 18 words.

## Output
Only the JSON object: {"prompt": "...", "avoid": "...", "note": "..."}.`;

const WORD_MIN_GENERATE = 60;

/**
 * Vídeo que parte de uma foto: o campo explícito manda; sem ele, vídeo com UMA referência = 1º quadro (o studio da X
 * manda só a foto do quadro). 2+ referências = vídeo por referência (papéis de cada imagem), não 1º quadro.
 */
export function isFirstFrameVideo(context: AdultEnhancerContext): boolean {
  if (context.type !== 'video') return false;
  return context.hasFirstFrame ?? (Boolean(context.hasReferenceImages) && (context.referenceCount ?? 1) <= 1);
}

/** Texto do usuário com cabeçalho do pedido (mesmo padrão do melhorador atual). */
export function adultEnhancerMessage(prompt: string, context: AdultEnhancerContext): string {
  const head: string[] = [`[type: ${context.type}]`];
  if (context.model) head.push(`[model: ${context.model}]`);
  if (isFirstFrameVideo(context)) head.push('[first frame: yes]');
  else if (context.hasReferenceImages) head.push(`[reference images: ${context.referenceCount ?? 1}]`);
  if (context.aspectRatio) head.push(`[aspect ratio: ${context.aspectRatio}]`);
  if (context.durationSeconds) head.push(`[duration: ${context.durationSeconds}s]`);
  if (context.locale) head.push(`[interface language: ${context.locale}]`);
  return `${head.join(' ')}\n\nUser prompt:\n<<<\n${prompt.trim()}\n>>>`;
}

/** Lê a resposta sem confiar no formato; qualquer coisa fora do contrato devolve null (o chamador usa o fallback). */
export function parseEnhancement(text: string | null | undefined): AdultEnhancement | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const { prompt, avoid, note } = raw as Record<string, unknown>;
  if (typeof prompt !== 'string' || !prompt.trim()) return null;
  return {
    prompt: prompt.trim(),
    avoid: typeof avoid === 'string' ? avoid.replace(/\s+/g, ' ').trim() : '',
    note: typeof note === 'string' ? note.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
  };
}

/** Junta prompt e "Avoid:" num texto só, do jeito que a trava e os modelos da casa leem (sem campo negativo). */
export function composeEnhanced(enhancement: AdultEnhancement): string {
  const avoid = enhancement.avoid.replace(/^avoid:\s*/i, '').trim();
  return avoid ? `${enhancement.prompt}\n\nAvoid: ${avoid}` : enhancement.prompt;
}

/**
 * Fallback sem modelo: quando o Claude recusa ler o pedido (cena muito explícita) ou falha, a cliente ainda ganha o
 * que o estudo mostrou que ajuda: idade adulta escrita quando não há, bloco de identidade (com referência), realismo,
 * câmera e a lista "evitar". O texto dela entra intacto, na frente.
 */
export function deterministicEnhancement(prompt: string, context: AdultEnhancerContext): AdultEnhancement {
  const clean = prompt.trim();
  if (isFirstFrameVideo(context)) return firstFrameVideoEnhancement(clean);
  const hasAge = /\b(1[89]|[2-9]\d)\s*(?:years?\s*old|anos|años|ans|y\/?o|yo)\b|\b(?:woman|mulher|mujer|femme|homem|man|hombre)\b[^.]{0,20}\b(1[89]|[2-9]\d)\b/i.test(clean);
  const parts: string[] = [];
  if (context.hasReferenceImages) {
    parts.push(
      context.referenceCount && context.referenceCount > 1
        ? 'Image 1 is the identity reference: same face, same body proportions, same skin tone as in the reference. The other images are pose or scene references only: do not copy their background, clothing or face.'
        : 'Same person as in the reference image: same face, same body proportions, same skin tone.',
    );
  }
  // pedido de homem ou casal não vira "mulher de 27" (dono, 23/11): só a âncora de adulto
  const malePresent = /\b(?:man|men|homem|homens|hombre|hombres|casal|couple|pareja|guy|boy ?friend)\b/i.test(clean);
  parts.push(hasAge ? clean : `${malePresent ? 'Every person shown is an adult (18 or older).' : 'Adult woman, 27 years old.'} ${clean}`);
  parts.push(
    context.type === 'video'
      ? 'Real footage look: natural skin texture with visible pores and imperfections, no beauty filter, realistic body weight and movement, one steady camera move, natural micro-movements of hair and fabric, consistent face across frames.'
      : 'Real skin texture with visible pores, fine body hair and natural imperfections, no beauty filter, no airbrushing, realistic body weight and gravity, natural asymmetry, authentic photographic look, not a 3D render, not CGI. Soft natural light from a real source, framing with the head in frame and the body filling the frame.',
  );
  if (context.hasReferenceImages) parts.push('Do not change the face or the body proportions from the reference.');
  const defects =
    context.type === 'video'
      ? ['morphing face', 'flickering', 'warping between frames', 'deformed hands', 'extra fingers', 'extra limbs', 'plastic skin', 'anime', 'cartoon', '3D render', 'text', 'watermark']
      : ['deformed hands', 'extra fingers', 'fused limbs', 'extra limbs', 'warped anatomy', 'plastic or waxy skin', 'airbrushed skin', 'doll-like face', 'anime', 'cartoon', '3D render', 'text', 'watermark', 'blurry', 'duplicated person'];
  const avoid = (context.hasReferenceImages ? ['different face from the reference', ...defects] : defects).join(', ');
  return { prompt: parts.join(' '), avoid, note: '' };
}

/**
 * Fallback do vídeo que parte de uma foto: a foto já diz quem ela é, a roupa e o lugar, então o bloco fixo não soma
 * idade, corpo nem cenário (redescrever a foto faz o rosto derivar). Só a âncora de identidade na frente, o pedido
 * dela intacto e o que segura o movimento (natural, contínuo, câmera estável).
 */
export const FIRST_FRAME_VIDEO_ANCHOR =
  'The same adult woman from the first frame (18 or older), her face, hair and body unchanged in every frame.';
export const FIRST_FRAME_VIDEO_MOTION =
  'One smooth continuous movement at natural speed, natural breathing, hair and fabric moving softly, steady camera, real handheld phone footage, natural skin texture, the same face in every frame.';

function firstFrameVideoEnhancement(clean: string): AdultEnhancement {
  const avoid = [
    'different face from the first frame',
    'face changing between frames',
    'morphing face',
    'flickering',
    'warping between frames',
    'melting or fused limbs',
    'extra fingers',
    'unnatural mouth movement',
    'sudden cuts',
    'camera drifting on its own',
  ].join(', ');
  return { prompt: [FIRST_FRAME_VIDEO_ANCHOR, clean, FIRST_FRAME_VIDEO_MOTION].join(' '), avoid, note: '' };
}

/** Pedido curto o bastante para ser uma edição (o modelo decide, isto só evita inflar um "muda a cor do top"). */
export function looksLikeEdit(prompt: string): boolean {
  const words = prompt.trim().split(/\s+/).length;
  return words < WORD_MIN_GENERATE && /\b(change|edit|make it|turn|add|remove|replace|swap|fix|adjust|muda|mude|troca|troque|tira|tire|coloca|coloque|remova|deixa|deixe|cambia|quita|pon|ajout|enl[eè]ve|change[rz]?)\b/i.test(prompt);
}
