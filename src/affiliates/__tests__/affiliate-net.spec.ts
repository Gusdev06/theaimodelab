import {
  AFFILIATE_GATEWAY_FEE_MAX_PERCENT,
  computeAffiliateNetCents,
  parseAffiliateGatewayFees,
} from '../affiliate-net';

/**
 * Base líquida da comissão: sem a env AFFILIATE_GATEWAY_FEE_PERCENT nada muda
 * (taxa da Stripe em toda venda); com ela, só o gateway citado troca de taxa.
 */
describe('parseAffiliateGatewayFees', () => {
  it.each([undefined, null, '', '   ', ',', 'perfectpay', ':20', 'perfectpay:'])(
    'sem entrada válida em %p',
    (raw) => {
      expect(parseAffiliateGatewayFees(raw as string | undefined).size).toBe(0);
    },
  );

  it('lê a lista, com espaços e maiúsculas', () => {
    const fees = parseAffiliateGatewayFees(' PerfectPay : 20 , cakto:6.5 ');
    expect(Object.fromEntries(fees)).toEqual({ perfectpay: 20, cakto: 6.5 });
  });

  it('aceita 0 e o teto; ignora o que passa do teto, negativo, vírgula decimal e texto', () => {
    const fees = parseAffiliateGatewayFees(
      `a:0,b:${AFFILIATE_GATEWAY_FEE_MAX_PERCENT},c:60.01,d:61,e:-5,f:abc,g:1e2,h:100,i:7%`,
    );
    expect(Object.fromEntries(fees)).toEqual({ a: 0, b: AFFILIATE_GATEWAY_FEE_MAX_PERCENT });
  });

  it('decimal com vírgula quebra a entrada, sem derrubar as vizinhas', () => {
    // "cakto:6,5" vira as entradas "cakto:6" e "5": a segunda é ignorada.
    expect(Object.fromEntries(parseAffiliateGatewayFees('cakto:6,5,perfectpay:20'))).toEqual({
      cakto: 6,
      perfectpay: 20,
    });
  });

  it('gateway repetido: vale a última entrada válida', () => {
    expect(parseAffiliateGatewayFees('cakto:6,cakto:8,cakto:99').get('cakto')).toBe(8);
  });
});

describe('computeAffiliateNetCents', () => {
  it('sem env: fórmula de sempre (Stripe 3,99% + 39 centavos) para qualquer gateway', () => {
    for (const provider of ['stripe', 'perfectpay', 'cakto', undefined, null, '']) {
      expect(computeAffiliateNetCents(3990, provider, undefined)).toEqual({
        netCents: 3792,
        feeCents: 198,
        rule: 'stripe-default',
      });
    }
  });

  it('gateway citado na env: líquido = bruto × (1 − taxa)', () => {
    expect(computeAffiliateNetCents(3990, 'perfectpay', 'perfectpay:20,cakto:6')).toEqual({
      netCents: 3192,
      feeCents: 798,
      rule: 'gateway-percent',
    });
    expect(computeAffiliateNetCents(2490, 'CAKTO', 'perfectpay:20,cakto:6')).toEqual({
      netCents: 2341,
      feeCents: 149,
      rule: 'gateway-percent',
    });
  });

  it('gateway fora da env continua na fórmula da Stripe', () => {
    expect(computeAffiliateNetCents(3990, 'stripe', 'perfectpay:20').rule).toBe('stripe-default');
    expect(computeAffiliateNetCents(3990, 'cakto', 'perfectpay:20').netCents).toBe(3792);
  });

  it('taxa 0 não desconta nada; entrada inválida cai na fórmula padrão', () => {
    expect(computeAffiliateNetCents(1000, 'cakto', 'cakto:0')).toEqual({
      netCents: 1000,
      feeCents: 0,
      rule: 'gateway-percent',
    });
    expect(computeAffiliateNetCents(1000, 'cakto', 'cakto:75').rule).toBe('stripe-default');
  });
});
