import {
  AFFILIATE_PERCENT_CAP_BY_PRODUCT,
  affiliateProductKey,
  parseAffiliatePercentByPlan,
  resolveEffectiveAffiliatePercent,
} from '../affiliate-percent-by-plan';

describe('AFFILIATE_PERCENT_BY_PLAN (L05)', () => {
  describe('flag off (env vazia): igual a hoje', () => {
    it.each([undefined, null, '', '   '])('env %p devolve tabela vazia', (raw) => {
      expect(parseAffiliatePercentByPlan(raw).size).toBe(0);
    });

    it('sem tabela, qualquer produto usa o percentual do afiliado', () => {
      const empty = parseAffiliatePercentByPlan('');
      for (const ref of [
        { paymentType: 'CREDIT_PURCHASE' },
        { paymentType: 'SUBSCRIPTION', planSlug: 'creator', billingInterval: 'month' },
        { paymentType: 'SUBSCRIPTION', planSlug: 'studio', billingInterval: 'month' },
      ]) {
        expect(resolveEffectiveAffiliatePercent(20, empty, ref)).toEqual(
          expect.objectContaining({ percent: 20, source: 'affiliate' }),
        );
      }
    });
  });

  describe('leitura da env', () => {
    it('aceita produto:percentual separado por vírgula, ignorando lixo', () => {
      const table = parseAffiliatePercentByPlan('pack:40, creator:25,pro=15;advanced:0 lixo studio:abc agency:120');
      expect(Object.fromEntries(table)).toEqual({ pack: 40, creator: 25, pro: 15, advanced: 0 });
    });

    it('aceita o anual como <slug>:year:<pct>', () => {
      expect(parseAffiliatePercentByPlan('creator:year:10').get('creator:year')).toBe(10);
    });
  });

  describe('chave do produto', () => {
    it('compra de créditos = pack', () => {
      expect(affiliateProductKey({ paymentType: 'CREDIT_PURCHASE' })).toBe('pack');
    });
    it('mensal = slug; anual = base:year', () => {
      expect(affiliateProductKey({ paymentType: 'SUBSCRIPTION', planSlug: 'creator', billingInterval: 'month' })).toBe('creator');
      expect(
        affiliateProductKey({ paymentType: 'SUBSCRIPTION', planSlug: 'creator-annual', basePlanSlug: 'creator', billingInterval: 'year' }),
      ).toBe('creator:year');
    });
    it('sem plano = desconhecido', () => {
      expect(affiliateProductKey({ paymentType: 'SUBSCRIPTION' })).toBeNull();
    });
  });

  describe('flag on: comissão por produto com teto de prejuízo zero', () => {
    const table = parseAffiliatePercentByPlan('pack:40,creator:25,pro:15,advanced:0,studio:0');

    it('pack 40% e Creator 25% (os números da página)', () => {
      expect(resolveEffectiveAffiliatePercent(20, table, { paymentType: 'CREDIT_PURCHASE' }).percent).toBe(40);
      expect(
        resolveEffectiveAffiliatePercent(20, table, { paymentType: 'SUBSCRIPTION', planSlug: 'creator', billingInterval: 'month' }),
      ).toEqual({ percent: 25, source: 'by-plan', productKey: 'creator' });
    });

    it('Advanced e Studio zeram', () => {
      expect(resolveEffectiveAffiliatePercent(20, table, { paymentType: 'SUBSCRIPTION', planSlug: 'advanced' }).percent).toBe(0);
      expect(resolveEffectiveAffiliatePercent(20, table, { paymentType: 'SUBSCRIPTION', planSlug: 'studio' }).percent).toBe(0);
    });

    it('nunca passa do teto, mesmo com a env pedindo mais', () => {
      const greedy = parseAffiliatePercentByPlan('pack:70,creator:40,pro:40,advanced:40,studio:40');
      expect(resolveEffectiveAffiliatePercent(20, greedy, { paymentType: 'CREDIT_PURCHASE' }).percent).toBe(AFFILIATE_PERCENT_CAP_BY_PRODUCT.pack);
      expect(resolveEffectiveAffiliatePercent(20, greedy, { paymentType: 'SUBSCRIPTION', planSlug: 'creator' }).percent).toBe(27);
      expect(resolveEffectiveAffiliatePercent(20, greedy, { paymentType: 'SUBSCRIPTION', planSlug: 'pro' }).percent).toBe(19);
      expect(resolveEffectiveAffiliatePercent(20, greedy, { paymentType: 'SUBSCRIPTION', planSlug: 'advanced' }).percent).toBe(8);
      expect(resolveEffectiveAffiliatePercent(20, greedy, { paymentType: 'SUBSCRIPTION', planSlug: 'studio' }).percent).toBe(1);
    });

    it('produto sem teto conhecido (anual, agency) ou fora da lista segue com o do afiliado', () => {
      const withAnnual = parseAffiliatePercentByPlan('creator:year:30,agency:30');
      expect(
        resolveEffectiveAffiliatePercent(20, withAnnual, { paymentType: 'SUBSCRIPTION', planSlug: 'creator-annual', basePlanSlug: 'creator', billingInterval: 'year' }),
      ).toEqual(expect.objectContaining({ percent: 20, source: 'affiliate' }));
      expect(resolveEffectiveAffiliatePercent(20, withAnnual, { paymentType: 'SUBSCRIPTION', planSlug: 'agency' }).percent).toBe(20);
      expect(resolveEffectiveAffiliatePercent(30, table, { paymentType: 'SUBSCRIPTION', planSlug: 'basic' }).percent).toBe(30);
    });

    it('teto fecha a conta do pior caso (US$, preço de catálogo da matriz)', () => {
      // pack 12,99: margem 7,80 antes do afiliado; 40% sobre o bruto = 5,20 → sobra 2,60 > 0
      expect(7.8 - 12.99 * (AFFILIATE_PERCENT_CAP_BY_PRODUCT.pack / 100)).toBeGreaterThan(0);
    });
  });
});
