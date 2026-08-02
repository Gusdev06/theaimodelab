import {
  EMAIL_LOCALES,
  ONBOARDING_EMAILS,
  POST_SUBSCRIPTION_EMAILS,
  pickNextSequenceEmail,
  resolveEmailLocale,
} from '../../email-sequences/onboarding-sequence-templates';

const CATCHUP = 3;
const none = new Set<string>();

describe('pickNextSequenceEmail', () => {
  it('dia 0: envia o email de boas-vindas', () => {
    const email = pickNextSequenceEmail(ONBOARDING_EMAILS, 0, none, CATCHUP);
    expect(email?.key).toBe('onboarding_1_welcome');
  });

  it('não reenvia email já registrado no log', () => {
    const sent = new Set(['onboarding_1_welcome']);
    const email = pickNextSequenceEmail(ONBOARDING_EMAILS, 0, sent, CATCHUP);
    expect(email).toBeNull();
  });

  it('dia 1: envia o quick win, não o de boas-vindas de novo', () => {
    const sent = new Set(['onboarding_1_welcome']);
    const email = pickNextSequenceEmail(ONBOARDING_EMAILS, 1, sent, CATCHUP);
    expect(email?.key).toBe('onboarding_2_quickwin');
  });

  it('com atraso, escolhe só o email mais avançado elegível (máx 1 por dia)', () => {
    // Usuário no dia 5 sem nada enviado: dia-3 e dia-5 estão na janela,
    // mas só o dia-5 sai — nada de rajada.
    const email = pickNextSequenceEmail(ONBOARDING_EMAILS, 5, none, CATCHUP);
    expect(email?.key).toBe('onboarding_4_usecase');
  });

  it('expira emails cujo dia passou além da janela de catch-up', () => {
    // Dia 4 = dia-0 (janela 0–3) expirado; dia-1 (janela 1–4) ainda vale.
    const email = pickNextSequenceEmail(ONBOARDING_EMAILS, 4, none, CATCHUP);
    expect(email?.key).toBe('onboarding_3_mechanism'); // dia 3, janela 3–6
  });

  it('usuário antigo (fora de todas as janelas) não recebe nada', () => {
    const email = pickNextSequenceEmail(ONBOARDING_EMAILS, 60, none, CATCHUP);
    expect(email).toBeNull();
  });

  it('sequência completa: nada mais a enviar', () => {
    const sent = new Set(ONBOARDING_EMAILS.map((e) => e.key));
    const email = pickNextSequenceEmail(ONBOARDING_EMAILS, 14, sent, CATCHUP);
    expect(email).toBeNull();
  });

  it('pós-assinatura: ativação no dia 0, guia de créditos no dia 2', () => {
    expect(pickNextSequenceEmail(POST_SUBSCRIPTION_EMAILS, 0, none, CATCHUP)?.key).toBe(
      'postsub_1_activation',
    );
    const sent = new Set(['postsub_1_activation']);
    expect(pickNextSequenceEmail(POST_SUBSCRIPTION_EMAILS, 2, sent, CATCHUP)?.key).toBe(
      'postsub_2_credits_guide',
    );
  });
});

describe('templates', () => {
  it('todas as keys são únicas entre as duas sequências', () => {
    const keys = [...ONBOARDING_EMAILS, ...POST_SUBSCRIPTION_EMAILS].map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offsets são crescentes dentro de cada sequência', () => {
    for (const list of [ONBOARDING_EMAILS, POST_SUBSCRIPTION_EMAILS]) {
      const offsets = list.map((e) => e.offsetDays);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    }
  });

  it('todos os emails têm conteúdo nos 3 idiomas com CTA pra URL do app', () => {
    for (const email of [...ONBOARDING_EMAILS, ...POST_SUBSCRIPTION_EMAILS]) {
      for (const locale of EMAIL_LOCALES) {
        const content = email.content[locale];
        expect(content.subject.length).toBeGreaterThan(0);
        expect(content.body('https://theaimodelab.com')).toContain('https://theaimodelab.com/');
      }
    }
  });
});

describe('resolveEmailLocale', () => {
  it('mapeia variantes de português pra pt-BR', () => {
    expect(resolveEmailLocale('pt-BR')).toBe('pt-BR');
    expect(resolveEmailLocale('pt-PT')).toBe('pt-BR');
    expect(resolveEmailLocale('pt')).toBe('pt-BR');
  });

  it('mapeia variantes de espanhol pra es', () => {
    expect(resolveEmailLocale('es-ES')).toBe('es');
    expect(resolveEmailLocale('es-MX')).toBe('es');
    expect(resolveEmailLocale('ES')).toBe('es');
  });

  it('cai em inglês pra qualquer outro caso', () => {
    expect(resolveEmailLocale('en-US')).toBe('en');
    expect(resolveEmailLocale('de-DE')).toBe('en');
    expect(resolveEmailLocale('fr-FR')).toBe('en');
    expect(resolveEmailLocale(null)).toBe('en');
    expect(resolveEmailLocale(undefined)).toBe('en');
    expect(resolveEmailLocale('')).toBe('en');
  });
});
