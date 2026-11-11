import {
  AFFILIATE_GATEWAY_FEE_MAX_PERCENT,
  computeAffiliateNetCents,
  parseAffiliateGatewayFees,
  parseAffiliateGatewayFeesDetailed,
  resetAffiliateGatewayFeeWarnings,
  warnDiscardedAffiliateGatewayFees,
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

describe('parseAffiliateGatewayFeesDetailed', () => {
  it('devolve o que valeu e o que foi descartado', () => {
    const { fees, discarded } = parseAffiliateGatewayFeesDetailed(
      ' perfectpay:20% , perfectpay=20,perfectpay:100, cakto:6 ,:7,stripe:,hubla: 4.5 ',
    );

    expect(Object.fromEntries(fees)).toEqual({ cakto: 6, hubla: 4.5 });
    expect(discarded).toEqual(['perfectpay:20%', 'perfectpay=20', 'perfectpay:100', ':7', 'stripe:']);
  });

  it('vírgula sobrando e env vazia não contam como descarte', () => {
    for (const raw of [undefined, null, '', '   ', ',', 'cakto:6,', ',,cakto:6, ,']) {
      expect(parseAffiliateGatewayFeesDetailed(raw as string | undefined).discarded).toEqual([]);
    }
  });

  it('decimal com vírgula: a sobra aparece no descarte', () => {
    expect(parseAffiliateGatewayFeesDetailed('cakto:6,5,perfectpay:20').discarded).toEqual(['5']);
  });
});

describe('warnDiscardedAffiliateGatewayFees', () => {
  beforeEach(() => resetAffiliateGatewayFeeWarnings());

  it('avisa uma vez por valor da env, não a cada venda', () => {
    const warn = jest.fn();

    expect(warnDiscardedAffiliateGatewayFees('perfectpay:20%,cakto:6', warn)).toEqual(['perfectpay:20%']);
    expect(warnDiscardedAffiliateGatewayFees('perfectpay:20%,cakto:6', warn)).toEqual([]);
    expect(warnDiscardedAffiliateGatewayFees('  perfectpay:20%,cakto:6  ', warn)).toEqual([]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"perfectpay:20%"');
    expect(warn.mock.calls[0][0]).toContain('AFFILIATE_GATEWAY_FEE_PERCENT');
  });

  it('valor diferente da env avisa de novo', () => {
    const warn = jest.fn();

    warnDiscardedAffiliateGatewayFees('perfectpay=20', warn);
    warnDiscardedAffiliateGatewayFees('perfectpay:100', warn);

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('env válida ou vazia não avisa', () => {
    const warn = jest.fn();

    for (const raw of [undefined, null, '', 'perfectpay:20,cakto:6', 'cakto:6,']) {
      warnDiscardedAffiliateGatewayFees(raw as string | undefined, warn);
    }

    expect(warn).not.toHaveBeenCalled();
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
