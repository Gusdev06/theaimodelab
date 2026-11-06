import { PaymentsService } from '../payments.service';

/**
 * Comissão de afiliado sobre o líquido de cada gateway. Sem a env
 * AFFILIATE_GATEWAY_FEE_PERCENT a conta é a de sempre (taxa da Stripe em toda venda);
 * com ela, só o gateway citado muda. A comissão passa a guardar moeda e gateway.
 */
describe('PaymentsService · base líquida da comissão por gateway', () => {
  const ORIGINAL_FEES = process.env.AFFILIATE_GATEWAY_FEE_PERCENT;
  const ORIGINAL_RECURRING = process.env.AFFILIATE_RECURRING_MONTHS;
  const plan = { id: 'plan-pro', slug: 'pro', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };

  beforeEach(() => {
    delete process.env.AFFILIATE_RECURRING_MONTHS;
  });

  afterEach(() => {
    if (ORIGINAL_FEES === undefined) delete process.env.AFFILIATE_GATEWAY_FEE_PERCENT;
    else process.env.AFFILIATE_GATEWAY_FEE_PERCENT = ORIGINAL_FEES;
    if (ORIGINAL_RECURRING === undefined) delete process.env.AFFILIATE_RECURRING_MONTHS;
    else process.env.AFFILIATE_RECURRING_MONTHS = ORIGINAL_RECURRING;
  });

  function setup(affiliate: Record<string, unknown> | null = { id: 'aff-1', isActive: true, commissionPercent: 30 }) {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      payment: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })),
      },
      subscription: {
        findFirst: jest.fn(async () => null),
        update: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
      },
      creditBalance: { upsert: jest.fn(async () => ({})) },
      creditTransaction: { create: jest.fn(async () => ({})) },
      affiliate: { findUnique: jest.fn(async () => affiliate) },
      affiliateEarning: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'ae-1' })),
      },
    };
    const prisma = {
      plan: { findUnique: jest.fn(async () => plan) },
      user: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new PaymentsService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    const earningData = () => (tx.affiliateEarning.create.mock.calls as any[][])[0]?.[0]?.data;
    return { service, tx, earningData };
  }

  const sale = {
    userId: 'user-1',
    planId: 'plan-pro',
    saleCode: 'PPCPMTB999',
    subscriptionCode: 'PPSUB1',
    amountCents: 3990,
    currency: 'usd',
    referredByCode: 'PARCEIRA',
  };

  it('sem a env: taxa da Stripe, como sempre, e a comissão guarda moeda e gateway', async () => {
    delete process.env.AFFILIATE_GATEWAY_FEE_PERCENT;
    const { service, earningData } = setup();

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(earningData()).toEqual({
      affiliateId: 'aff-1',
      paymentId: 'pay-1',
      userId: 'user-1',
      amountCents: 3792,
      commissionCents: 1138,
      currency: 'USD',
      provider: 'perfectpay',
      status: 'PENDING',
    });
  });

  it('com a env: Perfect Pay desconta a taxa dela (20%)', async () => {
    process.env.AFFILIATE_GATEWAY_FEE_PERCENT = 'perfectpay:20,cakto:6';
    const { service, earningData } = setup();

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(earningData()).toMatchObject({
      amountCents: 3192,
      commissionCents: 958,
      currency: 'USD',
      provider: 'perfectpay',
    });
  });

  it('com a env: Cakto em real usa a taxa da Cakto', async () => {
    process.env.AFFILIATE_GATEWAY_FEE_PERCENT = 'perfectpay:20,cakto:6';
    const { service, earningData } = setup();

    await service.activateOrRenewPerfectpaySubscription({
      ...sale,
      saleCode: 'cakto-1',
      amountCents: 9990,
      currency: 'brl',
      provider: 'cakto',
    });

    // 9990 − 6% (599) = 9391; 30% = 2817
    expect(earningData()).toMatchObject({
      amountCents: 9391,
      commissionCents: 2817,
      currency: 'BRL',
      provider: 'cakto',
    });
  });

  it('gateway fora da env fica na fórmula de sempre', async () => {
    process.env.AFFILIATE_GATEWAY_FEE_PERCENT = 'perfectpay:20';
    const { service, earningData } = setup();

    await service.activateOrRenewPerfectpaySubscription({ ...sale, provider: 'cakto', currency: 'brl' });

    expect(earningData()).toMatchObject({ amountCents: 3792, commissionCents: 1138, provider: 'cakto' });
  });

  it('env com lixo não muda a conta', async () => {
    process.env.AFFILIATE_GATEWAY_FEE_PERCENT = 'perfectpay:abc,cakto:99';
    const { service, earningData } = setup();

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(earningData()).toMatchObject({ amountCents: 3792, commissionCents: 1138 });
  });

  it('afiliado inativo ou inexistente não gera comissão', async () => {
    process.env.AFFILIATE_GATEWAY_FEE_PERCENT = 'perfectpay:20';

    const inactive = setup({ id: 'aff-1', isActive: false, commissionPercent: 30 });
    await inactive.service.activateOrRenewPerfectpaySubscription(sale);
    expect(inactive.tx.affiliateEarning.create).not.toHaveBeenCalled();

    const missing = setup(null);
    await missing.service.activateOrRenewPerfectpaySubscription(sale);
    expect(missing.tx.affiliateEarning.create).not.toHaveBeenCalled();
  });
});
