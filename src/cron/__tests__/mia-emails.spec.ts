import {
  buildCreditsDepletedEmail,
  buildLowBalanceEmail,
  buildWinbackEmail,
} from '../../email-sequences/lifecycle-templates';
import {
  EMAIL_LOCALES,
  ONBOARDING_EMAILS,
  POST_SUBSCRIPTION_EMAILS,
} from '../../email-sequences/onboarding-sequence-templates';
import {
  MIA_ASSET_BASE_URL,
  miaEmailBlock,
  miaLine,
  miaTalkUrl,
  showMiaFor,
} from '../../email-sequences/mia-email';

const APP = 'https://theaimodelab.com';
const MIA25 = `${MIA_ASSET_BASE_URL}/mia25-leva1.jpg`;
const MIA29 = `${MIA_ASSET_BASE_URL}/mia29-leva1.jpg`;
const MIA30 = `${MIA_ASSET_BASE_URL}/mia30-leva1.jpg`;

const lowBalance = (locale: (typeof EMAIL_LOCALES)[number], mia?: boolean) =>
  buildLowBalanceEmail({ appUrl: APP, totalCredits: 2100, monthlyCredits: 12000 }, locale, { mia });
const depleted = (locale: (typeof EMAIL_LOCALES)[number], mia?: boolean) =>
  buildCreditsDepletedEmail(
    {
      appUrl: APP,
      monthlyCredits: 12000,
      daysUsed: 9,
      daysUntilRenewal: 21,
      upgrade: { name: 'Pro', creditsPerMonth: 30000, priceUsd: 39.9 },
    },
    locale,
    { mia },
  );
const winback = (locale: (typeof EMAIL_LOCALES)[number], mia?: boolean) =>
  buildWinbackEmail({ appUrl: APP, generationsCount: 87 }, locale, { mia });

/** Links Markdown `[texto](url)`: o CTA único continua único com a Mia. */
const markdownLinks = (body: string) => body.match(/\]\(https?:\/\/[^)]+\)/g) ?? [];

describe('Mia nos e-mails de ciclo de vida', () => {
  const cases = [
    { name: 'crédito acabando', build: lowBalance, image: MIA30, scene: 'low_balance' as const },
    { name: 'créditos zerados', build: depleted, image: MIA30, scene: 'credits_depleted' as const },
    { name: 'volta depois de cancelar', build: winback, image: MIA25, scene: 'winback' as const },
  ];

  for (const c of cases) {
    for (const locale of EMAIL_LOCALES) {
      it(`${c.name} (${locale}): abre com a foto e a fala da Mia no idioma`, () => {
        const { body } = c.build(locale);
        expect(body.startsWith('<table')).toBe(true);
        expect(body).toContain(`src="${c.image}"`);
        expect(body).toContain(miaLine(c.scene, locale));
      });

      it(`${c.name} (${locale}): sem a Mia, o e-mail é o mesmo de antes, com o mesmo CTA`, () => {
        const withMia = c.build(locale);
        const without = c.build(locale, false);
        expect(without.body).not.toContain(MIA_ASSET_BASE_URL);
        expect(withMia.subject).toBe(without.subject);
        expect(withMia.body).toBe(miaEmailBlock(c.scene, locale) + without.body);
        expect(markdownLinks(withMia.body)).toEqual(markdownLinks(without.body));
        expect(markdownLinks(withMia.body)).toHaveLength(1);
      });
    }
  }

  it('a foto da Mia não é link (o e-mail segue com um único botão)', () => {
    const block = miaEmailBlock('credits_depleted', 'pt-BR');
    expect(block).not.toMatch(/<a [^>]*>\s*<img/);
    expect(block.match(/<a /g)).toHaveLength(1);
  });

  it('o bloco é uma linha só, seguida de linha em branco (o Markdown passa o HTML adiante)', () => {
    const block = miaEmailBlock('winback', 'en');
    expect(block.endsWith('\n\n')).toBe(true);
    expect(block.trimEnd()).not.toContain('\n');
  });

  it('a fala com apóstrofo e reticências não quebra o HTML', () => {
    const block = miaEmailBlock('winback', 'en');
    expect(block).toContain("I've been waiting");
    expect(block).not.toMatch(/<(?!\/?(table|tr|td|img|p|a)\b)/);
  });
});

describe('Linha de conversa 1 a 1 com a Mia', () => {
  const original = { on: process.env.MIA_X1_EMAIL, number: process.env.MIA_X1_WA_NUMBER };
  afterEach(() => {
    if (original.on === undefined) delete process.env.MIA_X1_EMAIL;
    else process.env.MIA_X1_EMAIL = original.on;
    if (original.number === undefined) delete process.env.MIA_X1_WA_NUMBER;
    else process.env.MIA_X1_WA_NUMBER = original.number;
  });

  for (const locale of EMAIL_LOCALES) {
    it(`(${locale}) o link abre o WhatsApp do suporte com a palavra MIA e o texto do idioma`, () => {
      const url = miaTalkUrl(locale);
      expect(url.startsWith('https://wa.me/5511922198321?text=MIA%20')).toBe(true);
      expect(url).not.toMatch(/['"<>& ]/);
      expect(miaEmailBlock('welcome', locale)).toContain(`href="${url}"`);
    });
  }

  it('o texto que vai para o WhatsApp é neutro (sem termo adulto)', () => {
    for (const locale of EMAIL_LOCALES) {
      expect(decodeURIComponent(miaTalkUrl(locale))).not.toMatch(/18\+|nsfw|uncensored|sem censura|sin censura|nude|porn/i);
    }
  });

  it('em inglês a resposta ao e-mail vem antes do WhatsApp', () => {
    const block = miaEmailBlock('low_balance', 'en');
    expect(block.indexOf('reply to this e-mail')).toBeGreaterThan(-1);
    expect(block.indexOf('reply to this e-mail')).toBeLessThan(block.indexOf('wa.me/'));
  });

  it('MIA_X1_EMAIL=off tira a linha e o bloco volta a não ter link', () => {
    process.env.MIA_X1_EMAIL = 'off';
    const block = miaEmailBlock('credits_depleted', 'es');
    expect(block).not.toContain('<a ');
    expect(block).not.toContain('wa.me');
    expect(block).toContain(miaLine('credits_depleted', 'es'));
  });

  it('MIA_X1_WA_NUMBER troca o número; valor inválido cai no número padrão', () => {
    process.env.MIA_X1_WA_NUMBER = '+55 (11) 90000-0000';
    expect(miaTalkUrl('pt-BR').startsWith('https://wa.me/5511900000000?text=')).toBe(true);
    process.env.MIA_X1_WA_NUMBER = 'abc';
    expect(miaTalkUrl('pt-BR').startsWith('https://wa.me/5511922198321?text=')).toBe(true);
  });

  it('conta de outra marca (sem a Mia) não ganha a linha de conversa', () => {
    expect(lowBalance('pt-BR', false).body).not.toContain('wa.me');
  });
});

describe('Mia nas boas-vindas', () => {
  const welcome = ONBOARDING_EMAILS.find((e) => e.key === 'onboarding_1_welcome')!;
  const activation = POST_SUBSCRIPTION_EMAILS.find((e) => e.key === 'postsub_1_activation')!;

  for (const locale of EMAIL_LOCALES) {
    it(`cadastro (${locale}): Mia 3D (MIA29) no topo, CTA igual`, () => {
      const body = welcome.content[locale].body(APP);
      const plain = welcome.content[locale].body(APP, { mia: false });
      expect(body).toContain(`src="${MIA29}"`);
      expect(body).toBe(miaEmailBlock('welcome', locale) + plain);
      expect(markdownLinks(body)).toEqual(markdownLinks(plain));
    });

    it(`assinatura ativa (${locale}): Mia 3D (MIA29) no topo, links iguais`, () => {
      const body = activation.content[locale].body(APP);
      const plain = activation.content[locale].body(APP, { mia: false });
      expect(body).toContain(`src="${MIA29}"`);
      expect(body).toBe(miaEmailBlock('activation', locale) + plain);
      expect(markdownLinks(body)).toEqual(markdownLinks(plain));
    });
  }

  it('os outros e-mails da trilha não ganham a Mia', () => {
    const others = [...ONBOARDING_EMAILS, ...POST_SUBSCRIPTION_EMAILS].filter(
      (e) => e.key !== welcome.key && e.key !== activation.key,
    );
    for (const email of others) {
      for (const locale of EMAIL_LOCALES) {
        expect(email.content[locale].body(APP)).not.toContain(MIA_ASSET_BASE_URL);
      }
    }
  });

  it('as Mias 3D só aparecem nas boas-vindas, nunca em crédito ou saudade', () => {
    for (const locale of EMAIL_LOCALES) {
      for (const body of [lowBalance(locale).body, depleted(locale).body, winback(locale).body]) {
        expect(body).not.toMatch(/mia2[89]-/);
      }
    }
  });
});

describe('showMiaFor', () => {
  const env = process.env;
  afterEach(() => {
    process.env = env;
  });

  it('conta da The AI Model Lab (sem marca) recebe a Mia', () => {
    expect(showMiaFor(null)).toBe(true);
    expect(showMiaFor(undefined)).toBe(true);
    expect(showMiaFor('taml')).toBe(true);
  });

  it('conta da Funvmake não recebe a Mia', () => {
    process.env = { ...env, FUNVMAKE_FRONTEND_URL: 'https://www.funvmake.com' };
    expect(showMiaFor('funvmake')).toBe(false);
  });
});
