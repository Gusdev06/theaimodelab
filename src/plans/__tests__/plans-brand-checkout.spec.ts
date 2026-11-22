import { PlansController } from '../plans.controller';

/** A vitrine troca o link só onde a marca tem link próprio; o resto fica com o link da origem. */
describe('PlansController · link de checkout por marca', () => {
  const plan = (id: string, slug: string, checkoutUrl: string) => ({
    id,
    slug,
    name: slug,
    description: null,
    priceCents: 3990,
    creditsPerMonth: 30000,
    maxConcurrentGenerations: 1,
    hasWatermark: false,
    galleryRetentionDays: null,
    hasApiAccess: false,
    sortOrder: 1,
    billingInterval: 'month',
    basePlanSlug: null,
    checkoutUrl,
  });

  function make(links: Map<string, string>, recurring: { cakto?: boolean; perfectpay?: boolean } = {}) {
    const plansService = {
      hasRecurringCaktoSubscription: jest.fn(async () => Boolean(recurring.cakto)),
      hasRecurringPerfectpaySubscription: jest.fn(async () => Boolean(recurring.perfectpay)),
      findAllPlans: jest.fn(async () => [plan('p-pro', 'pro', 'https://taml/pro'), plan('p-adv', 'advanced', 'https://taml/adv')]),
      findBrlPublicPlans: jest.fn(async () => [{ ...plan('p-pro', 'pro', 'https://cakto/taml-pro'), currency: 'BRL' }]),
      resolvePlanPrice: jest.fn(async () => ({ priceCents: 3990, currency: 'USD', stripePriceId: 'x' })),
    };
    const checkoutCodes = { storefrontLinks: jest.fn(async () => links) };
    return { controller: new PlansController(plansService as any, checkoutCodes as any), checkoutCodes };
  }

  it('USD: plano com link da marca troca; sem link próprio mantém o da origem', async () => {
    const { controller, checkoutCodes } = make(new Map([['p-pro', 'https://funv/pro']]));
    const headers = { origin: 'https://www.funvmake.com' };

    const result = await controller.findAll(undefined, { headers });

    expect(checkoutCodes.storefrontLinks).toHaveBeenCalledWith(headers, 'USD', 'plan');
    expect(result.find((p) => p.slug === 'pro')?.checkoutUrl).toBe('https://funv/pro');
    expect(result.find((p) => p.slug === 'advanced')?.checkoutUrl).toBe('https://taml/adv');
  });

  it('BRL: mesma regra na vitrine em reais', async () => {
    const { controller, checkoutCodes } = make(new Map([['p-pro', 'https://pay.cakto.com.br/funvpro']]));

    const result = await controller.findAll('brl', { headers: {} });

    expect(checkoutCodes.storefrontLinks).toHaveBeenCalledWith({}, 'BRL', 'plan');
    expect(result[0].checkoutUrl).toBe('https://pay.cakto.com.br/funvpro');
  });

  it('sem links da marca a resposta é a de sempre', async () => {
    const { controller } = make(new Map());
    const result = await controller.findAll();
    expect(result.map((p) => p.checkoutUrl)).toEqual(['https://taml/pro', 'https://taml/adv']);
  });

  // TKT-354 (22/11): o link da marca é de OUTRO produto; para quem já tem assinatura recorrente ele abriria
  // uma 2ª cobrança que não cancela a 1ª. Assinante recorrente fica no link da assinatura de sempre.
  it('BRL: assinante recorrente da Cakto não recebe o link da marca', async () => {
    const { controller } = make(new Map([['p-pro', 'https://pay.cakto.com.br/funvpro']]), { cakto: true });
    const result = await controller.findAll('brl', { headers: { origin: 'https://www.funvmake.com' }, user: { sub: 'u1' } });
    expect(result[0].checkoutUrl).not.toBe('https://pay.cakto.com.br/funvpro');
  });

  it('USD: assinante recorrente da Perfect Pay não recebe o link da marca', async () => {
    const { controller } = make(new Map([['p-pro', 'https://funv/pro']]), { perfectpay: true });
    const result = await controller.findAll(undefined, { headers: { origin: 'https://www.funvmake.com' }, user: { sub: 'u1' } });
    expect(result.find((p) => p.slug === 'pro')?.checkoutUrl).toBe('https://taml/pro');
  });

  it('logado SEM assinatura recorrente segue recebendo o link da marca', async () => {
    const { controller } = make(new Map([['p-pro', 'https://funv/pro']]));
    const result = await controller.findAll(undefined, { headers: { origin: 'https://www.funvmake.com' }, user: { sub: 'u1' } });
    expect(result.find((p) => p.slug === 'pro')?.checkoutUrl).toBe('https://funv/pro');
  });
});
