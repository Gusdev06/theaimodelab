import { PaymentsService } from '../payments.service';
import { resetAffiliateGatewayFeeWarnings } from '../../affiliates/affiliate-net';

/**
 * AFFILIATE_PERCENT_BY_PLAN (L05 candy, 24/11) na venda de verdade: sem a env a comissão é a de sempre (percentual do
 * afiliado) e o pagamento nem é relido; com ela, o plano vendido manda, limitado ao teto de prejuízo zero.
 */
describe('PaymentsService · comissão por produto (AFFILIATE_PERCENT_BY_PLAN)', () => {
  const ORIGINAL = {
    byPlan: process.env.AFFILIATE_PERCENT_BY_PLAN,
    fees: process.env.AFFILIATE_GATEWAY_FEE_PERCENT,
    recurring: process.env.AFFILIATE_RECURRING_MONTHS,
  };
  const plan = { id: 'plan-pro', slug: 'pro', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };

  beforeEach(() => {
    delete process.env.AFFILIATE_RECURRING_MONTHS;
    delete process.env.AFFILIATE_GATEWAY_FEE_PERCENT;
    delete process.env.AFFILIATE_PERCENT_BY_PLAN;
    resetAffiliateGatewayFeeWarnings();
  });

  afterEach(() => {
    for (const [key, value] of [
      ['AFFILIATE_PERCENT_BY_PLAN', ORIGINAL.byPlan],
      ['AFFILIATE_GATEWAY_FEE_PERCENT', ORIGINAL.fees],
      ['AFFILIATE_RECURRING_MONTHS', ORIGINAL.recurring],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function setup() {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      payment: {
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(async () => ({
          type: 'SUBSCRIPTION',
          subscription: { plan: { slug: 'pro', basePlanSlug: null, billingInterval: 'month' } },
        })),
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
      affiliate: { findUnique: jest.fn(async () => ({ id: 'aff-1', isActive: true, commissionPercent: 30 })) },
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

  it('sem a env: 30% do afiliado, igual a hoje, sem reler o pagamento', async () => {
    const { service, tx, earningData } = setup();
    await service.activateOrRenewPerfectpaySubscription(sale);
    expect(earningData()).toEqual(expect.objectContaining({ amountCents: 3792, commissionCents: 1138 }));
    expect(tx.payment.findUnique).not.toHaveBeenCalled();
  });

  it('com a env: Pro a 15% da lista', async () => {
    process.env.AFFILIATE_PERCENT_BY_PLAN = 'pack:40,creator:25,pro:15,advanced:0,studio:0';
    const { service, earningData } = setup();
    await service.activateOrRenewPerfectpaySubscription(sale);
    expect(earningData()).toEqual(expect.objectContaining({ amountCents: 3792, commissionCents: 569 }));
  });

  it('com a env pedindo acima do teto: Pro fica em 19%', async () => {
    process.env.AFFILIATE_PERCENT_BY_PLAN = 'pro:40';
    const { service, earningData } = setup();
    await service.activateOrRenewPerfectpaySubscription(sale);
    expect(earningData()).toEqual(expect.objectContaining({ commissionCents: 720 }));
  });

  it('com a env zerando o plano: nenhuma comissão gravada', async () => {
    process.env.AFFILIATE_PERCENT_BY_PLAN = 'pro:0';
    const { service, tx } = setup();
    await service.activateOrRenewPerfectpaySubscription(sale);
    expect(tx.affiliateEarning.create).not.toHaveBeenCalled();
  });
});
