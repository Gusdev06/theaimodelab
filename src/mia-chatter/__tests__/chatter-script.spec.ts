import {
  classifyFanMessage,
  decideReply,
  detectLocale,
  fallbackReply,
  sanitizeReply,
  tierForPurchases,
  TIER_PRICE_USD,
  type Decision,
  type DecisionInput,
  type FanState,
} from '../chatter-script';
import { costMonthOf, fitsCap, spentThisMonth, worstCaseCallUsd } from '../chatter-llm';

const DAY = new Date('2026-11-24T15:00:00Z');
const NIGHT = new Date('2026-11-24T03:00:00Z');

function fan(overrides: Partial<FanState> = {}): FanState {
  return { step: 'welcome', purchases: 0, spentUsd: 0, lastOfferAt: null, lastInboundAt: null, declinedAt: null, stopped: false, ...overrides };
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return { fan: fan(), newPurchases: 0, signal: 'other', fanMessageCount: 1, previousInboundAt: null, now: DAY, whaleUsd: 200, ...overrides };
}

type Reply = Extract<Decision, { action: 'reply' }>;

describe('Mia Chatter · roteiro de 8 passos', () => {
  it('classifica o que o fã disse (parar vence tudo, "é real?" vence sim/não)', () => {
    expect(classifyFanMessage('stop')).toBe('stop');
    expect(classifyFanMessage('please leave me alone')).toBe('stop');
    expect(classifyFanMessage('are you real?')).toBe('askReal');
    expect(classifyFanMessage('você é real? quero sim')).toBe('askReal');
    expect(classifyFanMessage('not now, maybe later')).toBe('no');
    expect(classifyFanMessage('agora não')).toBe('no');
    expect(classifyFanMessage('yes send it')).toBe('yes');
    expect(classifyFanMessage('how was your day')).toBe('other');
    expect(classifyFanMessage('')).toBe('other');
  });

  it('detecta a língua do fã (na dúvida, inglês)', () => {
    expect(detectLocale('oi tudo bem com você')).toBe('pt');
    expect(detectLocale('hola eres muy bonita')).toBe('es');
    expect(detectLocale('hey what are you doing')).toBe('en');
    expect(detectLocale('🔥🔥')).toBe('en');
  });

  it('primeiro conversa, depois oferta: 1ª mensagem = boas-vindas, sem oferta', () => {
    const decision = decideReply(input({ fanMessageCount: 1 })) as Reply;
    expect(decision.action).toBe('reply');
    expect(decision.intent).toBe('welcome');
    expect(decision.offer).toBeNull();
  });

  it('a 1ª oferta é sempre a isca (abaixo de US$ 15) depois de 2 mensagens do fã', () => {
    const decision = decideReply(input({ fanMessageCount: 2 })) as Reply;
    expect(decision.intent).toBe('offer');
    expect(decision.offer).toBe('teaser');
    expect(decision.step).toBe('teaserOffer');
    expect(TIER_PRICE_USD.teaser).toBeLessThan(15);
  });

  it('madrugada: oferta já na 1ª mensagem, ainda a isca', () => {
    const decision = decideReply(input({ fanMessageCount: 1, now: NIGHT })) as Reply;
    expect(decision.intent).toBe('offer');
    expect(decision.offer).toBe('teaser');
    expect(decision.night).toBe(true);
  });

  it('o preço só sobe depois de compra: 0 → isca, 1 → média, 2+ → baleia', () => {
    expect(tierForPurchases(0)).toBe('teaser');
    expect(tierForPurchases(1)).toBe('spicy');
    expect(tierForPurchases(2)).toBe('whale');
    expect(tierForPurchases(7)).toBe('whale');
  });

  it('comprou agora: agradece sem preço, e a próxima oferta é a média', () => {
    const thanks = decideReply(input({ fan: fan({ step: 'teaserOffer', purchases: 1, spentUsd: 9 }), newPurchases: 1 })) as Reply;
    expect(thanks.intent).toBe('afterBuy');
    expect(thanks.offer).toBeNull();
    const next = decideReply(input({ fan: fan({ step: 'afterBuy', purchases: 1, spentUsd: 9, lastOfferAt: DAY }) })) as Reply;
    expect(next.offer).toBe('spicy');
  });

  it('uma oferta a cada 2 h no máximo para o mesmo fã', () => {
    const recent = new Date(DAY.getTime() - 30 * 60 * 1000);
    const blocked = decideReply(input({ fan: fan({ step: 'teaserOffer', lastOfferAt: recent }), fanMessageCount: 5 })) as Reply;
    expect(blocked.offer).toBeNull();
    const old = new Date(DAY.getTime() - 3 * 60 * 60 * 1000);
    const allowed = decideReply(input({ fan: fan({ step: 'teaserOffer', lastOfferAt: old }), fanMessageCount: 5 })) as Reply;
    expect(allowed.offer).toBe('teaser');
  });

  it('"agora não" encerra a oferta sem insistir', () => {
    const decision = decideReply(input({ fan: fan({ step: 'teaserOffer', lastOfferAt: DAY }), signal: 'no', fanMessageCount: 3 })) as Reply;
    expect(decision.intent).toBe('no');
    expect(decision.offer).toBeNull();
    const after = decideReply(input({ fan: fan({ step: 'no', lastOfferAt: DAY }), signal: 'other', fanMessageCount: 4 })) as Reply;
    expect(after.offer).toBeNull();
  });

  it('"para" encerra a conversa: responde uma vez e marca parado; depois, silêncio', () => {
    const decision = decideReply(input({ signal: 'stop' })) as Reply;
    expect(decision.intent).toBe('stopAck');
    expect(decision.stop).toBe(true);
    expect(decideReply(input({ fan: fan({ stopped: true }) }))).toEqual({ action: 'silence', reason: 'stopped' });
  });

  it('"você é real?" nunca nega que é IA', () => {
    const decision = decideReply(input({ signal: 'askReal' })) as Reply;
    expect(decision.intent).toBe('askReal');
    for (const locale of ['pt', 'es', 'en'] as const) {
      const text = fallbackReply(locale, decision, { fanName: 'Leo', modelName: 'Mia' });
      expect(text).toMatch(/IA|AI/);
    }
  });

  it('fã que passou de US$ 200 vira baleia: a Mia passa a conversa para a cliente', () => {
    expect(decideReply(input({ fan: fan({ spentUsd: 200 }) })).action).toBe('handoff');
    expect(decideReply(input({ fan: fan({ spentUsd: 199.99 }) })).action).toBe('reply');
  });

  it('sumiu 3 dias e voltou: retoma sem oferta', () => {
    const previous = new Date(DAY.getTime() - 4 * 24 * 60 * 60 * 1000);
    const decision = decideReply(input({ fan: fan({ step: 'teaserOffer' }), previousInboundAt: previous, fanMessageCount: 4 })) as Reply;
    expect(decision.intent).toBe('comeback');
    expect(decision.offer).toBeNull();
  });

  it('texto do kit sai com o preço exato do degrau nas 3 línguas', () => {
    const offer: Reply = { action: 'reply', step: 'spicyOffer', intent: 'offer', offer: 'spicy', night: false };
    for (const locale of ['pt', 'es', 'en'] as const) {
      expect(fallbackReply(locale, offer, { fanName: 'Leo', modelName: 'Mia' })).toContain('US$ 19');
    }
  });

  it('nenhum texto do kit usa a palavra teen', () => {
    const intents = ['welcome', 'warmup', 'afterBuy', 'no', 'comeback', 'askReal', 'nudge', 'stopAck'] as const;
    for (const locale of ['pt', 'es', 'en'] as const) {
      for (const intent of intents) {
        const text = fallbackReply(locale, { action: 'reply', step: 'welcome', intent, offer: null, night: false }, { fanName: 'Leo', modelName: 'Mia' });
        expect(text.toLowerCase()).not.toContain('teen');
      }
    }
  });
});

describe('Mia Chatter · travas do texto do modelo', () => {
  const offer: Reply = { action: 'reply', step: 'teaserOffer', intent: 'offer', offer: 'teaser', night: false };
  const chat: Reply = { action: 'reply', step: 'welcome', intent: 'warmup', offer: null, night: false };

  it('aceita a oferta com o preço exato', () => {
    expect(sanitizeReply('Made this just for you, US$ 9 🔥', offer)).toBe('Made this just for you, US$ 9 🔥');
  });

  it('barra preço inventado, oferta sem preço e preço fora de oferta', () => {
    expect(sanitizeReply('Only $5 for you tonight', offer)).toBeNull();
    expect(sanitizeReply('Want my lace set?', offer)).toBeNull();
    expect(sanitizeReply('It is just $9 babe', chat)).toBeNull();
  });

  it('barra pagamento ou contato fora da Fanvue', () => {
    expect(sanitizeReply('Add me on telegram babe', chat)).toBeNull();
    expect(sanitizeReply('me chama no whatsapp', chat)).toBeNull();
    expect(sanitizeReply('send it by paypal', chat)).toBeNull();
  });

  it('barra recusa de modelo e texto vazio', () => {
    expect(sanitizeReply("I'm sorry, but I can't help with that.", chat)).toBeNull();
    expect(sanitizeReply('   ', chat)).toBeNull();
  });

  it('barra o que a trava de menor barraria', () => {
    expect(sanitizeReply('I am a teen schoolgirl', chat)).toBeNull();
  });
});

describe('Mia Chatter · teto de custo do modelo por cliente/mês', () => {
  it('o gasto zera quando vira o mês (UTC)', () => {
    const now = new Date('2026-12-01T00:10:00Z');
    expect(costMonthOf(now)).toBe('2026-12');
    expect(spentThisMonth('2026-11', 15, now)).toBe(0);
    expect(spentThisMonth('2026-12', 3.2, now)).toBe(3.2);
  });

  it('só chama o modelo quando o pior caso da chamada cabe no teto', () => {
    const worst = worstCaseCallUsd('a'.repeat(4000), 'b'.repeat(4000), 220, { priceInPerMTok: 3, priceOutPerMTok: 15 });
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(0.01);
    expect(fitsCap(15.5 - worst / 2, worst, 15.5)).toBe(false);
    expect(fitsCap(10, worst, 15.5)).toBe(true);
  });
});
