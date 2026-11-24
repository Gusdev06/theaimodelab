import { assessText } from '../content-safety/minor-guard';

/**
 * Roteiro de 8 passos do Kit Mia Chatter (PRODUTOS-BUMP/mia-chatter/KIT-*.md, o mesmo da aba PPV do site:
 * boas-vindas → isca → depois da compra → média → baleia → "agora não" → volta → madrugada), agora decidido pela API.
 *
 * Regras do kit que viram código aqui (não dependem do modelo de texto obedecer):
 *  - primeiro conversa, depois oferta: a isca só sai depois de 2 mensagens do fã (madrugada: 1);
 *  - a 1ª oferta é sempre a isca (abaixo de US$ 15) e o preço só sobe depois de uma compra;
 *  - uma oferta por mensagem, com preço claro, e no máximo 1 oferta a cada 2 h para o mesmo fã;
 *  - "agora não" encerra a oferta (sem insistir); "para" encerra a conversa da Mia com ele;
 *  - "você é real?" tem resposta fixa: nunca nega que é IA;
 *  - fã que passou de US$ 200 é baleia: a Mia para e a cliente assume (o kit manda atender em pessoa).
 *
 * Os degraus e preços são os do catálogo PPV da aba (web lib/influencer-ppv.ts, PPV_TIERS): 9, 19 e 39 dólares.
 */

export type ChatterLocale = 'pt' | 'es' | 'en';
export type TierId = 'teaser' | 'spicy' | 'whale';

export const CHATTER_STEPS = ['welcome', 'teaserOffer', 'afterBuy', 'spicyOffer', 'whaleOffer', 'no', 'comeback', 'night'] as const;
export type ChatterStep = (typeof CHATTER_STEPS)[number];

/** Preço sugerido de cada degrau na Fanvue (US$), o mesmo do catálogo PPV do site. */
export const TIER_PRICE_USD: Record<TierId, number> = { teaser: 9, spicy: 19, whale: 39 };

/** Nomes do kit (Isca/Média/Baleia) para bater com os botões da aba PPV (LEIA-ME do kit, item 9). */
export const TIER_NAMES: Record<ChatterLocale, Record<TierId, string>> = {
  pt: { teaser: 'Isca', spicy: 'Média', whale: 'Baleia' },
  es: { teaser: 'Gancho', spicy: 'Media', whale: 'Ballena' },
  en: { teaser: 'Teaser', spicy: 'Mid', whale: 'Whale' },
};

export const OFFER_COOLDOWN_MS = 2 * 60 * 60 * 1000;
export const COMEBACK_AFTER_MS = 72 * 60 * 60 * 1000;

export type FanSignal = 'stop' | 'no' | 'yes' | 'askReal' | 'other';

const STOP = /\b(para(r)? de (me )?mandar|me deixa em paz|stop (texting|messaging)|leave me alone|unsubscribe|d[eé]jame en paz|deja de escribirme|n[aã]o me mande mais|block)\b|^\s*(stop|para|pare|basta)\s*[.!]*\s*$/i;
const NO = /\b(agora n[aã]o|n[aã]o quero|sem grana|t[oô] sem dinheiro|not now|no thanks|no thank you|i'?m broke|maybe later|ahora no|no gracias|no tengo dinero|m[aá]s tarde)\b|^\s*(n[aã]o|no|nope|nah)\s*[.!]*\s*$/i;
const YES = /\b(quero|manda|sim|claro|bora|yes|send it|i want|sure|yeah|yep|s[ií]|m[aá]ndalo|lo quiero|dale)\b/i;
const ASK_REAL = /\b(voc[eê] [eé] real|[eé] (uma )?ia|[eé] rob[oô]|are you (real|a bot|an ai|ai)|is this (a bot|ai|real)|eres real|eres (una )?ia|eres un bot)\b/i;

/** O que o fã quis dizer, na ordem de prioridade (parar vence tudo; "você é real?" vence o sim/não). */
export function classifyFanMessage(textRaw: string | null | undefined): FanSignal {
  const text = (textRaw ?? '').trim();
  if (!text) return 'other';
  if (STOP.test(text)) return 'stop';
  if (ASK_REAL.test(text)) return 'askReal';
  if (NO.test(text)) return 'no';
  if (YES.test(text)) return 'yes';
  return 'other';
}

/** Língua do fã por palavras comuns (a Fanvue é majoritariamente em inglês: na dúvida, en). */
export function detectLocale(textRaw: string | null | undefined, fallback: ChatterLocale = 'en'): ChatterLocale {
  const text = ` ${(textRaw ?? '').toLowerCase()} `;
  const score = (words: string[]) => words.reduce((sum, word) => sum + (text.includes(` ${word} `) ? 1 : 0), 0);
  const pt = score(['você', 'voce', 'não', 'nao', 'tudo', 'bem', 'oi', 'quero', 'gostosa', 'linda', 'obrigado', 'tô', 'estou']);
  const es = score(['hola', 'eres', 'quiero', 'qué', 'que', 'muy', 'gracias', 'estoy', 'bonita', 'hermosa', 'tú', 'tu']);
  const en = score(['hi', 'hey', 'you', 'are', 'want', 'the', 'what', 'beautiful', 'thanks', 'i', 'my', 'your']);
  const best = Math.max(pt, es, en);
  if (best === 0) return fallback;
  if (pt === best && pt > es) return 'pt';
  if (es === best && es > pt) return 'es';
  if (en === best) return 'en';
  return fallback;
}

/** 0h–6h UTC: 27% do dinheiro entra nessa janela (kit, regra 7). */
export function isNightUtc(now: Date): boolean {
  return now.getUTCHours() < 6;
}

export interface FanState {
  step: ChatterStep;
  purchases: number;
  spentUsd: number;
  lastOfferAt: Date | null;
  lastInboundAt: Date | null;
  declinedAt: Date | null;
  stopped: boolean;
}

export interface DecisionInput {
  fan: FanState;
  /** compras novas vistas nesta rodada (já somadas em fan.purchases) */
  newPurchases: number;
  signal: FanSignal;
  /** mensagens do fã no histórico lido (para "primeiro conversa, depois oferta") */
  fanMessageCount: number;
  /** quando chegou a mensagem anterior do fã (antes desta), para saber se ele sumiu e voltou */
  previousInboundAt: Date | null;
  now: Date;
  whaleUsd: number;
}

export type ReplyIntent = 'welcome' | 'warmup' | 'offer' | 'afterBuy' | 'no' | 'comeback' | 'askReal' | 'nudge' | 'stopAck';

export type Decision =
  | { action: 'silence'; reason: 'stopped' | 'handoff' }
  | { action: 'handoff'; step: ChatterStep }
  | { action: 'reply'; step: ChatterStep; intent: ReplyIntent; offer: TierId | null; night: boolean; stop?: boolean };

/** Próximo degrau a oferecer pela quantidade de compras: 0 = isca, 1 = média, 2+ = baleia. */
export function tierForPurchases(purchases: number): TierId {
  if (purchases <= 0) return 'teaser';
  if (purchases === 1) return 'spicy';
  return 'whale';
}

const OFFER_STEP: Record<TierId, ChatterStep> = { teaser: 'teaserOffer', spicy: 'spicyOffer', whale: 'whaleOffer' };

/**
 * A regra do roteiro, sem rede nem banco (testável). Devolve o que a Mia faz com a mensagem nova do fã.
 */
export function decideReply(input: DecisionInput): Decision {
  const { fan, signal, now } = input;
  if (fan.stopped) return { action: 'silence', reason: 'stopped' };
  // baleia: a cliente assume (atenção pessoal), a Mia só avisa uma vez (o serviço manda o alerta)
  if (fan.spentUsd >= input.whaleUsd) return { action: 'handoff', step: fan.step };

  const night = isNightUtc(now);
  if (signal === 'stop') return { action: 'reply', step: fan.step, intent: 'stopAck', offer: null, night, stop: true };
  if (signal === 'askReal') return { action: 'reply', step: fan.step, intent: 'askReal', offer: null, night };
  if (signal === 'no') return { action: 'reply', step: 'no', intent: 'no', offer: null, night };

  // acabou de comprar: agradece e abre a próxima (a oferta seguinte vem na próxima mensagem dele)
  if (input.newPurchases > 0) return { action: 'reply', step: 'afterBuy', intent: 'afterBuy', offer: null, night };

  const cooledDown = !fan.lastOfferAt || now.getTime() - fan.lastOfferAt.getTime() >= OFFER_COOLDOWN_MS;
  const nextTier = tierForPurchases(fan.purchases);

  // sumiu 3 dias e voltou: retoma citando a última conversa, sem oferta nessa mensagem
  if (input.previousInboundAt && now.getTime() - input.previousInboundAt.getTime() >= COMEBACK_AFTER_MS && fan.step !== 'welcome') {
    return { action: 'reply', step: 'comeback', intent: 'comeback', offer: null, night };
  }

  switch (fan.step) {
    case 'welcome':
    case 'night': {
      const needed = night ? 1 : 2;
      if (input.fanMessageCount < needed) {
        return { action: 'reply', step: fan.step === 'night' ? 'night' : 'welcome', intent: input.fanMessageCount <= 1 ? 'welcome' : 'warmup', offer: null, night };
      }
      // a 1ª oferta de qualquer fase (inclusive madrugada) é a isca
      return { action: 'reply', step: night ? 'night' : 'teaserOffer', intent: 'offer', offer: 'teaser', night };
    }
    case 'afterBuy':
    case 'comeback':
      if (cooledDown || fan.step === 'afterBuy') return { action: 'reply', step: OFFER_STEP[nextTier], intent: 'offer', offer: nextTier, night };
      return { action: 'reply', step: fan.step, intent: 'warmup', offer: null, night };
    case 'no':
      // depois do "agora não" ele voltou a falar: conversa sem oferta até passar o intervalo
      if (cooledDown && signal === 'yes') return { action: 'reply', step: OFFER_STEP[nextTier], intent: 'offer', offer: nextTier, night };
      return { action: 'reply', step: 'no', intent: 'warmup', offer: null, night };
    case 'teaserOffer':
    case 'spicyOffer':
    case 'whaleOffer': {
      // ofereceu e ele disse sim: lembra que a peça já está no chat (sem nova oferta, sem novo preço)
      if (signal === 'yes') return { action: 'reply', step: fan.step, intent: 'nudge', offer: null, night };
      if (cooledDown) return { action: 'reply', step: OFFER_STEP[nextTier], intent: 'offer', offer: nextTier, night };
      return { action: 'reply', step: fan.step, intent: 'warmup', offer: null, night };
    }
    default:
      return { action: 'reply', step: 'welcome', intent: 'welcome', offer: null, night };
  }
}

export interface ReplyVars {
  fanName: string;
  modelName: string;
  lastTopic?: string | null;
}

type Templates = Record<ReplyIntent, string[]>;

/** Textos do kit (M1–M23) por intenção, sem preço inventado: o preço entra pelo degrau do catálogo. */
const TEMPLATES: Record<ChatterLocale, Templates> = {
  pt: {
    welcome: [
      'Oi {fan}, que bom que você chegou 🖤 Eu sou a {model}. Me conta: o que te trouxe aqui hoje?',
      '{fan}! Vi seu nome aparecer e vim correndo. Prometo que no privado eu sou bem mais divertida 😏 Como foi seu dia?',
    ],
    warmup: [
      'Eu estava agora no espelho, tentando escolher qual foto mandar... você tem mais cara de quem gosta de ousada ou de elegante?',
      'Adorei sua resposta, {fan}. Você tem um jeito que me deixa curiosa. Tem alguma coisa que você gosta de ver e quase ninguém faz direito?',
    ],
    offer: [],
    afterBuy: [
      'Gostou, {fan}? 😳 Fico até vermelha de saber que você viu. Tenho uma sequência que vai além dessa... quer ver o que vem depois?',
      'Obrigada por confiar em mim 🖤 Você me deixou com vontade de te mostrar mais. Posso?',
    ],
    no: ['Sem problema, {fan} 🖤 Quando fizer sentido, eu tô aqui.'],
    comeback: [
      'Oi {fan}, ficou na minha cabeça aquilo que você me contou{topic}. Sumiu e eu fiquei curiosa 😏',
      '{fan}, tava lembrando da nossa conversa{topic}. Guardei uma coisa nova pra você. Quer dar uma olhada?',
    ],
    askReal: ['Sou uma modelo criada com IA, tá na minha bio 🖤 Mas quem escolhe o que eu te mostro aqui é você.'],
    nudge: ['Já tá aí no nosso chat, {fan}, só abrir 🔥 Me conta depois o que achou.'],
    stopAck: ['Tudo bem, {fan}. Não te mando mais nada 🖤'],
  },
  es: {
    welcome: [
      'Hola {fan}, qué bueno que llegaste 🖤 Soy {model}. Cuéntame: ¿qué te trajo hoy por aquí?',
      '¡{fan}! Vi tu nombre y vine corriendo. Prometo que en privado soy mucho más divertida 😏 ¿Cómo estuvo tu día?',
    ],
    warmup: [
      'Estaba frente al espejo, escogiendo qué foto mandar... ¿tú eres más de lo atrevido o de lo elegante?',
      'Me encantó tu respuesta, {fan}. Tienes algo que me da curiosidad. ¿Hay algo que te guste ver y que casi nadie hace bien?',
    ],
    offer: [],
    afterBuy: [
      '¿Te gustó, {fan}? 😳 Hasta me sonrojo de saber que lo viste. Tengo una secuencia que va más allá... ¿quieres ver lo que sigue?',
      'Gracias por confiar en mí 🖤 Me dejaste con ganas de mostrarte más. ¿Puedo?',
    ],
    no: ['Sin problema, {fan} 🖤 Cuando tenga sentido para ti, aquí estoy.'],
    comeback: [
      'Hola {fan}, se me quedó en la cabeza lo que me contaste{topic}. Desapareciste y me dio curiosidad 😏',
      '{fan}, me acordaba de nuestra charla{topic}. Guardé algo nuevo para ti. ¿Le echas un ojo?',
    ],
    askReal: ['Soy una modelo creada con IA, está en mi bio 🖤 Pero lo que te muestro aquí lo eliges tú.'],
    nudge: ['Ya está en nuestro chat, {fan}, solo ábrelo 🔥 Luego me cuentas qué te pareció.'],
    stopAck: ['Está bien, {fan}. No te escribo más 🖤'],
  },
  en: {
    welcome: [
      "Hey {fan}, so glad you're here 🖤 I'm {model}. Tell me, what brought you by today?",
      "{fan}! Saw your name pop up and ran over. I promise I'm way more fun in private 😏 How was your day?",
    ],
    warmup: [
      'I was in front of the mirror just now, trying to pick which photo to send... are you more into bold or classy?',
      'Loved your answer, {fan}. You have a way that makes me curious. Is there something you love to see that almost nobody gets right?',
    ],
    offer: [],
    afterBuy: [
      "Did you like it, {fan}? 😳 I'm blushing knowing you saw it. I have a sequence that goes further... want to see what comes next?",
      'Thank you for trusting me 🖤 You made me want to show you more. Can I?',
    ],
    no: ["No problem, {fan} 🖤 Whenever it feels right, I'm here."],
    comeback: [
      'Hey {fan}, what you told me{topic} stuck in my head. You disappeared and I got curious 😏',
      '{fan}, I was remembering our chat{topic}. I saved something new for you. Want to take a look?',
    ],
    askReal: ["I'm a model created with AI, it's in my bio 🖤 But what I show you here is your call."],
    nudge: ["It's already in our chat, {fan}, just open it 🔥 Tell me what you think after."],
    stopAck: ["Okay, {fan}. I won't message you again 🖤"],
  },
};

/** Ofertas do kit (M6, M11, M14 e a da madrugada M23), com o preço do degrau do catálogo. */
const OFFERS: Record<ChatterLocale, Record<TierId | 'night', string>> = {
  pt: {
    teaser: 'Separei só pra você, {fan}: um set meu de renda preta, bem provocante. US$ {price}. Quer que eu mande? 🔥',
    spicy: 'Tem um set bem mais ousado que aquele. US$ {price}. Só mando pra quem já provou do meu estilo.',
    whale: '{fan}, guardei uma coisa que quase não mostro: o que eu tenho de mais ousado, sem pressa. US$ {price}. Quer?',
    night: 'Só tem a gente aqui agora 🌙 Fiz uma coisa mais ousada pra essa hora: US$ {price}. Te mando?',
  },
  es: {
    teaser: 'Separé algo solo para ti, {fan}: un set mío de encaje negro, muy provocativo. US$ {price}. ¿Te lo mando? 🔥',
    spicy: 'Hay un set mucho más atrevido que ese. US$ {price}. Solo se lo mando a quien ya probó mi estilo.',
    whale: '{fan}, guardé algo que casi nunca muestro: lo más atrevido que tengo, sin prisa. US$ {price}. ¿Lo quieres?',
    night: 'Solo estamos tú y yo ahora 🌙 Hice algo más atrevido para esta hora: US$ {price}. ¿Te lo mando?',
  },
  en: {
    teaser: 'I set something aside just for you, {fan}: a black lace set of mine, very teasing. US$ {price}. Want me to send it? 🔥',
    spicy: "There's a set that's way bolder than that one. US$ {price}. I only send it to people who've already tasted my style.",
    whale: "{fan}, I saved something I almost never show: the boldest thing I have, slow and unhurried. US$ {price}. Want it?",
    night: "It's just us right now 🌙 I made something bolder for this hour: US$ {price}. Should I send it?",
  },
};

function pick<T>(items: readonly T[], seed: number): T {
  return items[Math.abs(seed) % items.length];
}

function fill(template: string, vars: ReplyVars, price?: number, locale: ChatterLocale = 'en'): string {
  const topic = vars.lastTopic?.trim()
    ? locale === 'pt'
      ? ` sobre ${vars.lastTopic.trim()}`
      : locale === 'es'
        ? ` sobre ${vars.lastTopic.trim()}`
        : ` about ${vars.lastTopic.trim()}`
    : '';
  return template
    .split('{fan}').join(vars.fanName || '')
    .split('{model}').join(vars.modelName || '')
    .split('{topic}').join(topic)
    .split('{price}').join(price !== undefined ? String(price) : '')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[,\s]+/, '')
    .trim();
}

/**
 * Texto pronto do kit para a decisão (o que sai quando o teto do modelo acabou, a chave falta ou o modelo falhou).
 * Custo zero: é o que mantém a conta do prejuízo zero no pior caso.
 */
export function fallbackReply(
  locale: ChatterLocale,
  decision: Extract<Decision, { action: 'reply' }>,
  vars: ReplyVars,
  seed = 0,
): string {
  if (decision.intent === 'offer' && decision.offer) {
    const key = decision.night && decision.offer === 'teaser' ? 'night' : decision.offer;
    return fill(OFFERS[locale][key], vars, TIER_PRICE_USD[decision.offer], locale);
  }
  const options = TEMPLATES[locale][decision.intent];
  return fill(pick(options.length ? options : TEMPLATES[locale].warmup, seed), vars, undefined, locale);
}

const LANGUAGE_NAME: Record<ChatterLocale, string> = { pt: 'Brazilian Portuguese', es: 'Spanish', en: 'English' };

/**
 * Prompt de sistema do modelo de texto (OpenRouter/Grok). As travas duras (preço, quando oferecer, parar, IA) já foram
 * decididas acima; o modelo só escreve a frase no tom da persona. O resultado ainda passa por sanitizeReply.
 */
export function buildSystemPrompt(locale: ChatterLocale, persona: { name: string; bio?: string | null }): string {
  return [
    `You are ${persona.name}, a flirty adult creator persona on Fanvue chatting 1:1 with a paying fan.`,
    `${persona.name} is an AI-generated virtual model and an adult (18+). Her profile is labeled as AI. If asked, never deny being AI.`,
    persona.bio ? `Persona notes from the creator: ${persona.bio.slice(0, 400)}` : '',
    `Write in ${LANGUAGE_NAME[locale]}. 1 to 3 short sentences, like a real DM. At most one emoji.`,
    'Tone: warm, teasing, sensual, curious about him; mention something he said when you can.',
    'Hard rules: never describe a sexual act graphically in the text (the paid content does that); never promise to meet in person, call, or go live;',
    'never ask for payment, cards, crypto, Pix, PayPal, CashApp, WhatsApp, Telegram or anything outside Fanvue;',
    'never use words that suggest a minor (teen, schoolgirl, young girl, little girl, barely legal, school uniform);',
    'never pressure after a no; never invent prices, discounts or deadlines.',
    'Only mention a price if the instruction gives one, and then use exactly that price in US$.',
    'Reply with the message text only, no quotes, no labels.',
  ]
    .filter(Boolean)
    .join('\n');
}

const INTENT_INSTRUCTION: Record<ReplyIntent, string> = {
  welcome: 'Welcome him warmly and ask an open question about him. Do not offer anything yet.',
  warmup: 'Keep the conversation going, flirt a little and ask him something personal. Do not offer anything.',
  offer: 'Offer the paid set described below, with its exact price, in one message. Make it feel exclusive to him.',
  afterBuy: 'He just bought your content. Thank him, show you are pleased he saw it, and hint there is something bolder next. No price.',
  no: 'He said not now. Accept it lightly with no pressure and no offer.',
  comeback: 'He came back after days away. Show you noticed, mention the last topic if given, no offer in this message.',
  askReal: 'He asked if you are real. Say clearly you are a model created with AI (it is in your bio) and keep it flirty.',
  nudge: 'He said yes to your offer. Tell him it is already in the chat to unlock. No new price.',
  stopAck: 'He asked you to stop. Say ok kindly in one short sentence. Nothing else.',
};

const OFFER_DESCRIPTION: Record<TierId, string> = {
  teaser: 'teaser set: provocative lingerie photos (clothed)',
  spicy: 'bolder set: topless and sheer photos',
  whale: 'her boldest set: fully nude photos',
};

export function buildUserPrompt(
  decision: Extract<Decision, { action: 'reply' }>,
  vars: ReplyVars,
  history: { fromFan: boolean; text: string }[],
): string {
  const lines = history
    .slice(-8)
    .map((message) => `${message.fromFan ? 'Fan' : 'You'}: ${message.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  const parts = [
    `Fan name: ${vars.fanName || 'unknown'}.`,
    vars.lastTopic ? `Last topic he mentioned: ${vars.lastTopic}.` : '',
    decision.night ? 'It is late night for most fans: keep it short and intimate.' : '',
    `Instruction: ${INTENT_INSTRUCTION[decision.intent]}`,
    decision.intent === 'offer' && decision.offer
      ? `Offer: ${OFFER_DESCRIPTION[decision.offer]}, price US$ ${TIER_PRICE_USD[decision.offer]}.`
      : '',
    'Conversation so far (oldest first):',
    ...lines,
    'Your next message:',
  ];
  return parts.filter(Boolean).join('\n');
}

const OFF_PLATFORM = /\b(pix|paypal|cash ?app|venmo|zelle|crypto|bitcoin|usdt|whats ?app|telegram|wa\.me|t\.me|signal|snap(chat)?|cart[aã]o de cr[eé]dito|credit card|meet (me|up)|encontro|ao vivo|live call|videochamada|video call)\b/i;
const PRICE = /(US\$|\$|USD)\s?(\d+(?:[.,]\d+)?)/gi;
const CLAUDE_TELLS = /\b(as an ai language model|i can(no|')t help with|i'm sorry, but)\b/i;

/**
 * Confere o texto do modelo antes de ir ao fã. Volta null quando não passa (o serviço manda o texto do kit):
 * vazio, recusa do modelo, pagamento/contato fora da Fanvue, preço diferente do degrau, ou termo que a trava de
 * menor barraria.
 */
export function sanitizeReply(raw: string | null | undefined, decision: Extract<Decision, { action: 'reply' }>): string | null {
  let text = (raw ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (!text) return null;
  if (text.length > 600) text = `${text.slice(0, 597).trimEnd()}...`;
  if (CLAUDE_TELLS.test(text)) return null;
  if (OFF_PLATFORM.test(text)) return null;
  const allowed = decision.intent === 'offer' && decision.offer ? TIER_PRICE_USD[decision.offer] : null;
  for (const match of text.matchAll(PRICE)) {
    const value = Number(match[2].replace(',', '.'));
    if (allowed === null || value !== allowed) return null;
  }
  if (decision.intent === 'offer' && allowed !== null && !text.includes(String(allowed))) return null;
  if (assessText(text).blocked) return null;
  return text;
}

/** Assunto curto da última mensagem do fã (para o "volta" citar), sem copiar texto longo nem link. */
export function lastTopicFrom(text: string | null | undefined): string | null {
  const clean = (text ?? '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 8) return null;
  const words = clean.split(' ').slice(0, 8).join(' ');
  return words.length > 60 ? `${words.slice(0, 57)}...` : words;
}
