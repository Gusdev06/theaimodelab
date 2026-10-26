import {
  DEFAULT_PERFECTPAY_PRODUCT_LOCALES,
  localeFromCountry,
  parseProductLocales,
  resolvePerfectpayBuyerLocale,
} from '../buyer-locale';

/** TKT-004: e-mail de acesso da isca no idioma do comprador. */
describe('resolvePerfectpayBuyerLocale', () => {
  it('pack ES (conta CPF e CNPJ) → es', () => {
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFHBE' } })).toBe('es');
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFJAQ' } })).toBe('es');
  });

  it('pack EN (conta CPF e CNPJ) → en, mesmo com comprador no México', () => {
    expect(
      resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFHC5' }, customer: { country: 'MX' } }),
    ).toBe('en');
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFJAR' } })).toBe('en');
  });

  it('código em minúsculo ou com espaço casa igual', () => {
    expect(resolvePerfectpayBuyerLocale({ product: { code: ' pppbfhbe ' } })).toBe('es');
  });

  it('bumps e upsells seguem o idioma do funil', () => {
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFHC2' } })).toBe('es');
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFHD0' } })).toBe('en');
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFKG0' } })).toBe('es');
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBFKG1' } })).toBe('en');
  });

  it('produto desconhecido: decide pelo país do comprador', () => {
    expect(
      resolvePerfectpayBuyerLocale({ product: { code: 'PPPBNOVO1' }, customer: { country: 'MX' } }),
    ).toBe('es');
    expect(
      resolvePerfectpayBuyerLocale({ product: { code: 'PPPBNOVO1' }, customer: { country: 'BR' } }),
    ).toBe('pt');
    expect(
      resolvePerfectpayBuyerLocale({ product: { code: 'PPPBNOVO1' }, customer: { country: 'US' } }),
    ).toBe('en');
    expect(
      resolvePerfectpayBuyerLocale({
        product: { code: 'PPPBNOVO1' },
        customer: { address: { country: 'España' } },
      }),
    ).toBe('es');
  });

  it('sem produto nem país: moeda BRL → pt; nada → en (comportamento antigo)', () => {
    expect(resolvePerfectpayBuyerLocale({ currency_enum_key: 'BRL' })).toBe('pt');
    expect(resolvePerfectpayBuyerLocale({ currency_enum_key: 'USD' })).toBe('en');
    expect(resolvePerfectpayBuyerLocale({})).toBe('en');
    expect(resolvePerfectpayBuyerLocale(null)).toBe('en');
  });

  it('mapa da env sobrescreve e soma ao padrão', () => {
    const map = {
      ...DEFAULT_PERFECTPAY_PRODUCT_LOCALES,
      ...parseProductLocales('pppbnovo1:es, PPPBFHC5:pt ,lixo,semidioma:,PPPBX:xx'),
    };
    expect(map.PPPBNOVO1).toBe('es');
    expect(map.PPPBFHC5).toBe('pt');
    expect(map.PPPBX).toBeUndefined();
    expect(resolvePerfectpayBuyerLocale({ product: { code: 'PPPBNOVO1' } }, map)).toBe('es');
  });

  it('parseProductLocales aceita vazio e undefined', () => {
    expect(parseProductLocales(undefined)).toEqual({});
    expect(parseProductLocales('')).toEqual({});
  });
});

describe('localeFromCountry', () => {
  it('código ISO e nome por extenso', () => {
    expect(localeFromCountry('mx')).toBe('es');
    expect(localeFromCountry('PT')).toBe('pt');
    expect(localeFromCountry('DE')).toBe('en');
    expect(localeFromCountry('Brasil')).toBe('pt');
    expect(localeFromCountry('República Dominicana')).toBe('es');
  });

  it('vazio ou irreconhecível devolve null para a próxima pista', () => {
    expect(localeFromCountry('')).toBeNull();
    expect(localeFromCountry('Atlântida')).toBeNull();
    expect(localeFromCountry(42)).toBeNull();
    expect(localeFromCountry(undefined)).toBeNull();
  });
});
