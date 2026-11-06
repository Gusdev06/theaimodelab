import {
  decodeAffiliateRef,
  encodeAffiliateRef,
  extractPerfectpayAffiliateRef,
  isPackAffiliateBridgeEnabled,
  isPackProductAllowed,
  parseOwnAccountEmails,
} from '../perfectpay-affiliate';

const OWN = ['produtor@casa.test', 'coprodutor@casa.test'];

/** Exemplo de `commission` da documentação oficial do postback (e-mails acrescentados). */
const docCommission = [
  {
    affiliation_code: 'PPAJFTR',
    affiliation_type_enum: 5,
    name: 'USER EXAMPLE NAME',
    email: 'Afiliada@Exemplo.test',
    identification_number: '07958658745',
    commission_amount: 0,
  },
  {
    affiliation_code: 'PPAGSDE',
    affiliation_type_enum: 1,
    name: 'User Affiliation Example',
    email: 'produtor@casa.test',
    identification_number: '08745785448',
    commission_amount: 440.28,
  },
  { affiliation_type_enum: 0, name: 'PerfectPay', commission_amount: 53.72 },
];

describe('extractPerfectpayAffiliateRef', () => {
  describe('commission[] do postback', () => {
    it('pega a linha de afiliado (tipo 5), com o e-mail em minúsculas', () => {
      expect(extractPerfectpayAffiliateRef({ commission: docCommission }, OWN)).toEqual({
        email: 'afiliada@exemplo.test',
        code: 'PPAJFTR',
      });
    });

    it('funciona sem a lista de contas próprias quando a linha traz o tipo', () => {
      expect(extractPerfectpayAffiliateRef({ commission: docCommission })).toEqual({
        email: 'afiliada@exemplo.test',
        code: 'PPAJFTR',
      });
    });

    it('venda sem afiliado (só produtor e plataforma) não devolve nada', () => {
      expect(extractPerfectpayAffiliateRef({ commission: docCommission.slice(1) }, OWN)).toBeNull();
    });

    it('produtor, coprodutor, gerente, parceiro, premium e fornecedor não são o afiliado da venda', () => {
      for (const type of [0, 1, 2, 3, 4, 6, 7]) {
        const payload = {
          commission: [{ affiliation_type_enum: type, email: 'alguem@fora.test', affiliation_code: 'PPXXXXX' }],
        };
        expect(extractPerfectpayAffiliateRef(payload, OWN)).toBeNull();
      }
    });

    it('tipo como texto numérico ou como nome também vale', () => {
      expect(
        extractPerfectpayAffiliateRef({ commission: [{ affiliation_type_enum: '5', email: 'a@b.test' }] }),
      ).toEqual({ email: 'a@b.test' });
      expect(
        extractPerfectpayAffiliateRef({ commissions: [{ affiliation_type: 'Affiliate', affiliation_email: 'a@b.test' }] }),
      ).toEqual({ email: 'a@b.test' });
      expect(
        extractPerfectpayAffiliateRef({ commissions: [{ affiliation_type: 'producer', affiliation_email: 'a@b.test' }] }, OWN),
      ).toBeNull();
    });

    it('`commissions` como objeto único e como objeto de objetos', () => {
      expect(
        extractPerfectpayAffiliateRef({
          commissions: { affiliation_type_enum: 5, affiliation_email: 'a@b.test', affiliation_code: 'ppabc12' },
        }),
      ).toEqual({ email: 'a@b.test', code: 'PPABC12' });
      expect(
        extractPerfectpayAffiliateRef({
          commissions: {
            '0': { affiliation_type_enum: 1, affiliation_email: 'produtor@casa.test' },
            '1': { affiliation_type_enum: 5, affiliation_email: 'a@b.test' },
          },
        }),
      ).toEqual({ email: 'a@b.test' });
    });

    it('e-mail ofuscado não identifica ninguém: sobra o código da afiliação', () => {
      expect(
        extractPerfectpayAffiliateRef({
          commission: [{ affiliation_type_enum: 5, email: 'us***@exemplo.test', affiliation_code: 'PPAJFTR' }],
        }),
      ).toEqual({ code: 'PPAJFTR' });
    });

    it('afiliado com o e-mail de uma conta própria é ignorado', () => {
      const payload = {
        commission: [{ affiliation_type_enum: 5, email: 'Coprodutor@Casa.test', affiliation_code: 'PPOWN01' }],
      };
      expect(extractPerfectpayAffiliateRef(payload, OWN)).toBeNull();
      expect(extractPerfectpayAffiliateRef(payload, ['  COPRODUTOR@casa.test '])).toBeNull();
    });

    describe('linha sem tipo (formato da API de vendas)', () => {
      const untyped = {
        commissions: [
          { affiliation_email: 'produtor@casa.test', commission_amount: 10 },
          { affiliation_email: 'afiliada@exemplo.test', commission_amount: 9 },
        ],
      };

      it('com as contas próprias configuradas, quem sobra é o afiliado', () => {
        expect(extractPerfectpayAffiliateRef(untyped, OWN)).toEqual({ email: 'afiliada@exemplo.test' });
      });

      it('sem as contas próprias não dá para separar produtor de afiliado: nada', () => {
        expect(extractPerfectpayAffiliateRef(untyped)).toBeNull();
        expect(extractPerfectpayAffiliateRef(untyped, [])).toBeNull();
      });

      it('linha sem tipo e sem e-mail nunca conta', () => {
        expect(extractPerfectpayAffiliateRef({ commission: [{ affiliation_code: 'PPAGSDE' }] }, OWN)).toBeNull();
      });
    });
  });

  describe('`affiliate` / `affiliation` no topo', () => {
    it('objeto com e-mail e código', () => {
      expect(
        extractPerfectpayAffiliateRef({ affiliate: { email: 'A@B.test', code: 'ppzz999' } }, OWN),
      ).toEqual({ email: 'a@b.test', code: 'PPZZ999' });
      expect(
        extractPerfectpayAffiliateRef({ affiliation: { affiliation_email: 'a@b.test', affiliation_code: 'PPZZ999' } }),
      ).toEqual({ email: 'a@b.test', code: 'PPZZ999' });
    });

    it('texto: e-mail ou código', () => {
      expect(extractPerfectpayAffiliateRef({ affiliate: ' a@b.test ' })).toEqual({ email: 'a@b.test' });
      expect(extractPerfectpayAffiliateRef({ affiliation: 'ppzz999' })).toEqual({ code: 'PPZZ999' });
    });

    it('conta própria é ignorada', () => {
      expect(extractPerfectpayAffiliateRef({ affiliate: { email: 'produtor@casa.test' } }, OWN)).toBeNull();
      expect(extractPerfectpayAffiliateRef({ affiliate: 'produtor@casa.test' }, OWN)).toBeNull();
    });
  });

  describe('código de afiliado da plataforma no link (metadata)', () => {
    it('`convite:CODIGO` e `aff:CODIGO` em src ou utm_content', () => {
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:maria30' } })).toEqual({ code: 'MARIA30' });
      expect(extractPerfectpayAffiliateRef({ metadata: { utm_content: 'AFF:Parceira_1' } })).toEqual({
        code: 'PARCEIRA_1',
      });
      expect(
        extractPerfectpayAffiliateRef({ metadata: { src: null, utm_content: 'video3|aff:MARIA30|ig' } }),
      ).toEqual({ code: 'MARIA30' });
    });

    it('utm comum não vira código', () => {
      expect(
        extractPerfectpayAffiliateRef({
          metadata: { src: 'instagram', utm_content: 'Example+User-seq1-ba', utm_source: 'aff:NAOVALE' },
        }),
      ).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'staff:MARIA30' } })).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:' } })).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:A' } })).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:cod!go' } })).toBeNull();
    });

    it('com afiliado na comissão, o e-mail é dele e o código é o do link (da plataforma)', () => {
      expect(
        extractPerfectpayAffiliateRef({ commission: docCommission, metadata: { src: 'convite:MARIA30' } }, OWN),
      ).toEqual({ email: 'afiliada@exemplo.test', code: 'MARIA30' });
    });
  });

  it.each([
    [undefined],
    [null],
    ['texto'],
    [42],
    [[]],
    [{}],
    [{ commission: 'x', commissions: 7, affiliate: 9, affiliation: [], metadata: 'y' }],
    [{ commission: [null, 'a', 3, []], metadata: { src: 12, utm_content: {} } }],
    [{ commission: [{ affiliation_type_enum: 5 }] }],
    [{ commission: [{ affiliation_type_enum: 5, email: 'sem-arroba', affiliation_code: '!' }] }],
    [{ commission: [{ affiliation_type_enum: 5, email: { nested: true }, affiliation_code: {} }] }],
  ])('lixo não lança e devolve null: %p', (payload) => {
    expect(extractPerfectpayAffiliateRef(payload, OWN)).toBeNull();
  });

  it('nunca lança, nem com getter que explode nem com lista de contas torta', () => {
    const hostile = {
      get commission(): unknown {
        throw new Error('boom');
      },
    };
    expect(() => extractPerfectpayAffiliateRef(hostile, OWN)).not.toThrow();
    expect(extractPerfectpayAffiliateRef(hostile, OWN)).toBeNull();
    expect(
      extractPerfectpayAffiliateRef({ commission: docCommission }, [null, 5, 'produtor@casa.test'] as never),
    ).toEqual({ email: 'afiliada@exemplo.test', code: 'PPAJFTR' });
  });
});

describe('encodeAffiliateRef / decodeAffiliateRef', () => {
  it('e-mail (afiliado identificado pela Perfect Pay) vale antes do código', () => {
    expect(encodeAffiliateRef({ email: 'a@b.test', code: 'MARIA30' })).toBe('email:a@b.test');
    expect(encodeAffiliateRef({ code: 'MARIA30' })).toBe('code:MARIA30');
    expect(encodeAffiliateRef(null)).toBeNull();
    expect(encodeAffiliateRef({})).toBeNull();
  });

  it('ida e volta', () => {
    expect(decodeAffiliateRef('email:a@b.test')).toEqual({ kind: 'email', value: 'a@b.test' });
    expect(decodeAffiliateRef('email: A@B.test ')).toEqual({ kind: 'email', value: 'a@b.test' });
    expect(decodeAffiliateRef('code:maria30')).toEqual({ kind: 'code', value: 'MARIA30' });
  });

  it.each([null, undefined, '', 'a@b.test', 'email:', 'email:sem-arroba', 'code:', 'code:!', 'outro:valor', ':x'])(
    'referência inválida (%p) vira null',
    (raw) => {
      expect(decodeAffiliateRef(raw as string | null)).toBeNull();
    },
  );
});

describe('envs da ponte', () => {
  it('PACK_AFFILIATE_BRIDGE_ENABLED: só "true" liga', () => {
    expect(isPackAffiliateBridgeEnabled('true')).toBe(true);
    expect(isPackAffiliateBridgeEnabled(' TRUE ')).toBe(true);
    for (const raw of [undefined, null, '', 'false', '1', 'yes', 'on']) {
      expect(isPackAffiliateBridgeEnabled(raw)).toBe(false);
    }
  });

  it('PERFECTPAY_OWN_ACCOUNT_EMAILS: lista por vírgula, em minúsculas', () => {
    expect(parseOwnAccountEmails(' Produtor@Casa.test , ,coprodutor@casa.test')).toEqual(OWN);
    expect(parseOwnAccountEmails(undefined)).toEqual([]);
  });

  it('PERFECTPAY_PACK_PRODUCTS: vazia aceita qualquer produto; com lista, só os dela', () => {
    expect(isPackProductAllowed('PPPBFJAQ', undefined)).toBe(true);
    expect(isPackProductAllowed(undefined, '')).toBe(true);
    expect(isPackProductAllowed('pppbfjaq', 'PPPBFJAQ, PPPBFJAR')).toBe(true);
    expect(isPackProductAllowed('PPPBFJAR', 'PPPBFJAQ, PPPBFJAR')).toBe(true);
    expect(isPackProductAllowed('PPPBF381', 'PPPBFJAQ,PPPBFJAR')).toBe(false);
    expect(isPackProductAllowed(undefined, 'PPPBFJAQ')).toBe(false);
    expect(isPackProductAllowed({ code: 'PPPBFJAQ' }, 'PPPBFJAQ')).toBe(false);
  });
});
