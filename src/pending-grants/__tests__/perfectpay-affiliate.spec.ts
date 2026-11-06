import {
  decodeAffiliateRef,
  encodeAffiliateRef,
  extractPerfectpayAffiliateRef,
  isPackAffiliateBridgeEnabled,
  isPackBridgeLinkCodesEnabled,
  isPackProductAllowed,
  parseOwnAccountEmails,
} from '../perfectpay-affiliate';

const OWN = ['produtor@casa.test', 'coprodutor@casa.test'];
const own = { ownEmails: OWN };
const withLink = { ownEmails: OWN, allowLinkCodes: true };

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
    it('pega a linha de afiliado (tipo 5): código da Perfect Pay e e-mail em minúsculas', () => {
      expect(extractPerfectpayAffiliateRef({ commission: docCommission }, own)).toEqual({
        perfectpayCode: 'PPAJFTR',
        email: 'afiliada@exemplo.test',
      });
    });

    it('funciona sem a lista de contas próprias', () => {
      expect(extractPerfectpayAffiliateRef({ commission: docCommission })).toEqual({
        perfectpayCode: 'PPAJFTR',
        email: 'afiliada@exemplo.test',
      });
    });

    it('venda sem afiliado (só produtor e plataforma) não devolve nada', () => {
      expect(extractPerfectpayAffiliateRef({ commission: docCommission.slice(1) }, own)).toBeNull();
    });

    it('produtor, coprodutor, gerente, parceiro, premium e fornecedor não são o afiliado da venda', () => {
      for (const type of [0, 1, 2, 3, 4, 6, 7]) {
        const payload = {
          commission: [{ affiliation_type_enum: type, email: 'alguem@fora.test', affiliation_code: 'PPXXXXX' }],
        };
        expect(extractPerfectpayAffiliateRef(payload, own)).toBeNull();
      }
    });

    it('tipo 5 como texto numérico também vale', () => {
      expect(
        extractPerfectpayAffiliateRef({ commission: [{ affiliation_type_enum: ' 5 ', email: 'a@b.test' }] }),
      ).toEqual({ email: 'a@b.test' });
    });

    it('um participante só, como objeto solto em vez de lista', () => {
      expect(
        extractPerfectpayAffiliateRef({
          commission: { affiliation_type_enum: 5, email: 'a@b.test', affiliation_code: 'ppabc12' },
        }),
      ).toEqual({ perfectpayCode: 'PPABC12', email: 'a@b.test' });
    });

    it('e-mail ofuscado (com *) não identifica ninguém: sobra o código da Perfect Pay', () => {
      expect(
        extractPerfectpayAffiliateRef({
          commission: [{ affiliation_type_enum: 5, email: 'us***@exemplo.test', affiliation_code: 'PPAJFTR' }],
        }),
      ).toEqual({ perfectpayCode: 'PPAJFTR' });
    });

    it('afiliado com o e-mail de uma conta própria é ignorado', () => {
      const payload = {
        commission: [{ affiliation_type_enum: 5, email: 'Coprodutor@Casa.test', affiliation_code: 'PPOWN01' }],
      };
      expect(extractPerfectpayAffiliateRef(payload, own)).toBeNull();
      expect(extractPerfectpayAffiliateRef(payload, { ownEmails: ['  COPRODUTOR@casa.test '] })).toBeNull();
    });

    it('conta própria como "afiliada" não esconde o afiliado de verdade da mesma venda', () => {
      const payload = {
        commission: [
          { affiliation_type_enum: 5, email: 'coprodutor@casa.test', affiliation_code: 'PPOWN01' },
          { affiliation_type_enum: 5, email: 'afiliada@exemplo.test', affiliation_code: 'PPAJFTR' },
        ],
      };
      expect(extractPerfectpayAffiliateRef(payload, own)).toEqual({
        perfectpayCode: 'PPAJFTR',
        email: 'afiliada@exemplo.test',
      });
    });

    describe('linha sem affiliation_type_enum nunca conta', () => {
      const untyped = {
        commission: [
          { email: 'produtor@casa.test', commission_amount: 10 },
          { email: 'afiliada@exemplo.test', affiliation_code: 'PPAJFTR', commission_amount: 9 },
        ],
      };

      it('nem com as contas próprias configuradas (o atalho antigo saiu)', () => {
        expect(extractPerfectpayAffiliateRef(untyped, own)).toBeNull();
        expect(extractPerfectpayAffiliateRef(untyped)).toBeNull();
      });

      it('nome do tipo em texto ("affiliate") e campos fora da documentação não contam', () => {
        for (const entry of [
          { affiliation_type: 'Affiliate', email: 'a@b.test' },
          { affiliation_type: 5, email: 'a@b.test' },
          { type: 5, email: 'a@b.test' },
          { role: 'afiliado', email: 'a@b.test' },
          { affiliation_type_enum: 'affiliate', email: 'a@b.test' },
          { affiliation_type_enum: 5.5, email: 'a@b.test' },
        ]) {
          expect(extractPerfectpayAffiliateRef({ commission: [entry] }, own)).toBeNull();
        }
      });
    });
  });

  describe('campos fora da documentação não são lidos', () => {
    it('`affiliate` / `affiliation` soltos no topo não viram afiliado nem código', () => {
      for (const payload of [
        { affiliate: { email: 'a@b.test', code: 'MARIA30' } },
        { affiliation: { affiliation_email: 'a@b.test', affiliation_code: 'PPZZ999' } },
        { affiliate: ' a@b.test ' },
        { affiliation: 'MARIA30' },
        { affiliate: 'MARIA30', affiliation: 'MARIA30' },
      ]) {
        expect(extractPerfectpayAffiliateRef(payload, withLink)).toBeNull();
      }
    });

    it('`commissions` (plural) e `affiliation_email` não são o formato do postback', () => {
      expect(
        extractPerfectpayAffiliateRef({ commissions: [{ affiliation_type_enum: 5, email: 'a@b.test' }] }, own),
      ).toBeNull();
      expect(
        extractPerfectpayAffiliateRef(
          { commission: [{ affiliation_type_enum: 5, affiliation_email: 'a@b.test' }] },
          own,
        ),
      ).toBeNull();
    });
  });

  describe('código de afiliado da plataforma no link (metadata)', () => {
    it('desligado por padrão: o link não vale nada', () => {
      for (const options of [undefined, {}, own, { allowLinkCodes: false }]) {
        expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:maria30' } }, options)).toBeNull();
        expect(extractPerfectpayAffiliateRef({ metadata: { utm_content: 'aff:MARIA30' } }, options)).toBeNull();
      }
    });

    it('ligado: `convite:CODIGO` e `aff:CODIGO` em src ou utm_content, em venda sem afiliado', () => {
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:maria30' } }, withLink)).toEqual({
        linkCode: 'MARIA30',
      });
      expect(extractPerfectpayAffiliateRef({ metadata: { utm_content: 'AFF:Parceira_1' } }, withLink)).toEqual({
        linkCode: 'PARCEIRA_1',
      });
      expect(
        extractPerfectpayAffiliateRef({ metadata: { src: null, utm_content: 'video3|aff:MARIA30|ig' } }, withLink),
      ).toEqual({ linkCode: 'MARIA30' });
      // produtor e plataforma na comissão não são afiliado: o link segue valendo
      expect(
        extractPerfectpayAffiliateRef(
          { commission: docCommission.slice(1), metadata: { src: 'convite:MARIA30' } },
          withLink,
        ),
      ).toEqual({ linkCode: 'MARIA30' });
    });

    it('utm comum não vira código', () => {
      expect(
        extractPerfectpayAffiliateRef(
          { metadata: { src: 'instagram', utm_content: 'Example+User-seq1-ba', utm_source: 'aff:NAOVALE' } },
          withLink,
        ),
      ).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'staff:MARIA30' } }, withLink)).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:' } }, withLink)).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:A' } }, withLink)).toBeNull();
      expect(extractPerfectpayAffiliateRef({ metadata: { src: 'convite:cod!go' } }, withLink)).toBeNull();
    });

    it('com afiliado da Perfect Pay (tipo 5) na venda, o link é ignorado', () => {
      expect(
        extractPerfectpayAffiliateRef({ commission: docCommission, metadata: { src: 'convite:MARIA30' } }, withLink),
      ).toEqual({ perfectpayCode: 'PPAJFTR', email: 'afiliada@exemplo.test' });
    });

    it('afiliado tipo 5 presente, mesmo sem identificação útil ou sendo conta própria: o link não entra', () => {
      for (const affiliateEntry of [
        { affiliation_type_enum: 5 },
        { affiliation_type_enum: 5, email: 'us***@exemplo.test' },
        { affiliation_type_enum: 5, email: 'coprodutor@casa.test', affiliation_code: 'PPOWN01' },
      ]) {
        expect(
          extractPerfectpayAffiliateRef(
            { commission: [affiliateEntry], metadata: { src: 'convite:MARIA30' } },
            withLink,
          ),
        ).toBeNull();
      }
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
    [{ commission: [{ affiliation_type_enum: 5, email: 'a|b@c.test' }] }],
  ])('lixo não lança e devolve null: %p', (payload) => {
    expect(extractPerfectpayAffiliateRef(payload, withLink)).toBeNull();
  });

  it('nunca lança, nem com getter que explode nem com lista de contas torta', () => {
    const hostile = {
      get commission(): unknown {
        throw new Error('boom');
      },
    };
    expect(() => extractPerfectpayAffiliateRef(hostile, own)).not.toThrow();
    expect(extractPerfectpayAffiliateRef(hostile, own)).toBeNull();
    expect(
      extractPerfectpayAffiliateRef(
        { commission: docCommission },
        { ownEmails: [null, 5, 'produtor@casa.test'] as never },
      ),
    ).toEqual({ perfectpayCode: 'PPAJFTR', email: 'afiliada@exemplo.test' });
  });
});

describe('encodeAffiliateRef / decodeAffiliateRef', () => {
  it('afiliado da Perfect Pay: ppcode e e-mail; o código do link só entra sozinho', () => {
    expect(encodeAffiliateRef({ perfectpayCode: 'PPAJFTR', email: 'a@b.test' })).toBe('ppcode:PPAJFTR|email:a@b.test');
    expect(encodeAffiliateRef({ perfectpayCode: 'PPAJFTR' })).toBe('ppcode:PPAJFTR');
    expect(encodeAffiliateRef({ email: 'a@b.test' })).toBe('email:a@b.test');
    expect(encodeAffiliateRef({ linkCode: 'MARIA30' })).toBe('code:MARIA30');
    expect(encodeAffiliateRef({ perfectpayCode: 'PPAJFTR', linkCode: 'MARIA30' })).toBe('ppcode:PPAJFTR');
    expect(encodeAffiliateRef(null)).toBeNull();
    expect(encodeAffiliateRef({})).toBeNull();
  });

  it('o código da Perfect Pay nunca sai como `code:` (espaço de nomes da plataforma)', () => {
    const stored = encodeAffiliateRef(extractPerfectpayAffiliateRef({ commission: docCommission }));
    expect(stored).toBe('ppcode:PPAJFTR|email:afiliada@exemplo.test');
    expect(decodeAffiliateRef(stored).map((part) => part.kind)).toEqual(['ppcode', 'email']);
  });

  it('ida e volta, na ordem em que a resolução tenta', () => {
    expect(decodeAffiliateRef('email:a@b.test')).toEqual([{ kind: 'email', value: 'a@b.test' }]);
    expect(decodeAffiliateRef('email: A@B.test ')).toEqual([{ kind: 'email', value: 'a@b.test' }]);
    expect(decodeAffiliateRef('code:maria30')).toEqual([{ kind: 'code', value: 'MARIA30' }]);
    expect(decodeAffiliateRef('ppcode:ppajftr')).toEqual([{ kind: 'ppcode', value: 'PPAJFTR' }]);
    expect(decodeAffiliateRef('email:a@b.test|ppcode:PPAJFTR')).toEqual([
      { kind: 'ppcode', value: 'PPAJFTR' },
      { kind: 'email', value: 'a@b.test' },
    ]);
  });

  it('parte inválida é descartada sem derrubar a vizinha; parte repetida vale a primeira', () => {
    expect(decodeAffiliateRef('ppcode:!|email:a@b.test')).toEqual([{ kind: 'email', value: 'a@b.test' }]);
    expect(decodeAffiliateRef('ppcode:PPAJFTR|email:us***@b.test')).toEqual([{ kind: 'ppcode', value: 'PPAJFTR' }]);
    expect(decodeAffiliateRef('ppcode:PPAAA|ppcode:PPBBB')).toEqual([{ kind: 'ppcode', value: 'PPAAA' }]);
  });

  it.each([null, undefined, '', 'a@b.test', 'email:', 'email:sem-arroba', 'code:', 'code:!', 'ppcode:', 'outro:valor', ':x', '|'])(
    'referência inválida (%p) não tem parte nenhuma',
    (raw) => {
      expect(decodeAffiliateRef(raw as string | null)).toEqual([]);
    },
  );
});

describe('envs da ponte', () => {
  it('PACK_AFFILIATE_BRIDGE_ENABLED e PACK_AFFILIATE_BRIDGE_LINK_CODES: só "true" liga', () => {
    for (const isEnabled of [isPackAffiliateBridgeEnabled, isPackBridgeLinkCodesEnabled]) {
      expect(isEnabled('true')).toBe(true);
      expect(isEnabled(' TRUE ')).toBe(true);
      for (const raw of [undefined, null, '', 'false', '1', 'yes', 'on']) {
        expect(isEnabled(raw)).toBe(false);
      }
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
