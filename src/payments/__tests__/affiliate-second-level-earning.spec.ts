import { PaymentsService } from '../payments.service';
import { resetAffiliateGatewayFeeWarnings } from '../../affiliates/affiliate-net';

/**
 * Segundo nível: depois da comissão direta, o afiliado que trouxe o afiliado da venda
 * (pai) recebe uma fatia dela, paga pela casa. Desligado sem a env
 * AFFILIATE_SECOND_LEVEL_PERCENT; só um nível acima; nunca para o próprio comprador.
 *
 * Venda de US$ 39,90 sem taxa de gateway na env → líquido 3792, comissão 30% = 1138.
 * Com 5% de segundo nível: round(1138 × 0,05) = 57.
 */
describe('PaymentsService · comissão de segundo nível', () => {
  const ORIGINAL = {
    second: process.env.AFFILIATE_SECOND_LEVEL_PERCENT,
    fees: process.env.AFFILIATE_GATEWAY_FEE_PERCENT,
    recurring: process.env.AFFILIATE_RECURRING_MONTHS,
  };
  const plan = { id: 'plan-pro', slug: 'pro', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };

  beforeEach(() => {
    delete process.env.AFFILIATE_RECURRING_MONTHS;
    delete process.env.AFFILIATE_GATEWAY_FEE_PERCENT;
    delete process.env.AFFILIATE_SECOND_LEVEL_PERCENT;
    resetAffiliateGatewayFeeWarnings();
  });

  afterEach(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('AFFILIATE_SECOND_LEVEL_PERCENT', ORIGINAL.second);
    restore('AFFILIATE_GATEWAY_FEE_PERCENT', ORIGINAL.fees);
    restore('AFFILIATE_RECURRING_MONTHS', ORIGINAL.recurring);
  });

  type AffiliateRow = { id: string; userId?: string | null; isActive: boolean; commissionPercent?: number; parentAffiliateId?: string | null };

  function setup(affiliates: AffiliateRow[]) {
    const byCode: Record<string, AffiliateRow> = { PARCEIRA: affiliates[0] };
    const byId = new Map(affiliates.map((row) => [row.id, row]));
    let nextEarningId = 1;
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
      affiliate: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.code ? (byCode[where.code] ?? null) : (byId.get(where.id) ?? null),
        ),
      },
      affiliateEarning: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: `ae-${nextEarningId++}`, ...data })),
      },
    };
    const prisma = {
      plan: { findUnique: jest.fn(async () => plan) },
      user: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new PaymentsService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    const created = () => (tx.affiliateEarning.create.mock.calls as any[][]).map((call) => call[0].data);
    return { service, tx, created };
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

  const child: AffiliateRow = { id: 'aff-filho', userId: 'user-filho', isActive: true, commissionPercent: 30, parentAffiliateId: 'aff-pai' };
  const parent: AffiliateRow = { id: 'aff-pai', userId: 'user-pai', isActive: true, commissionPercent: 30, parentAffiliateId: null };

  it('sem a env: só a comissão direta, marcada como nível 1', async () => {
    const { service, created } = setup([child, parent]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ affiliateId: 'aff-filho', commissionCents: 1138, level: 1 });
    expect(created()[0]).not.toHaveProperty('sourceEarningId');
  });

  it('ligada: direta para o filho e a fatia para o pai, ligada à direta', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const { service, created, tx } = setup([child, parent]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(2);
    expect(created()[0]).toEqual({
      affiliateId: 'aff-filho',
      paymentId: 'pay-1',
      userId: 'user-1',
      amountCents: 3792,
      commissionCents: 1138,
      currency: 'USD',
      provider: 'perfectpay',
      status: 'PENDING',
      level: 1,
    });
    expect(created()[1]).toEqual({
      affiliateId: 'aff-pai',
      paymentId: 'pay-1',
      userId: 'user-1',
      amountCents: 3792,
      commissionCents: 57,
      currency: 'USD',
      provider: 'perfectpay',
      status: 'PENDING',
      level: 2,
      sourceEarningId: 'ae-1',
    });
    // O pai é lido pelo id com o que decide o pagamento, sem campo a mais.
    expect(tx.affiliate.findUnique).toHaveBeenCalledWith({
      where: { id: 'aff-pai' },
      select: { id: true, userId: true, isActive: true },
    });
  });

  it('a comissão do filho não muda com o segundo nível ligado (a casa paga a fatia)', async () => {
    const off = setup([child, parent]);
    await off.service.activateOrRenewPerfectpaySubscription(sale);

    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '20';
    const on = setup([child, parent]);
    await on.service.activateOrRenewPerfectpaySubscription(sale);

    expect(on.created()[0].commissionCents).toBe(off.created()[0].commissionCents);
    expect(on.created()[1].commissionCents).toBe(228); // 20% de 1138 = 227,6
  });

  it('pai inativo: só a direta', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const { service, created } = setup([child, { ...parent, isActive: false }]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(1);
    expect(created()[0].level).toBe(1);
  });

  it('pai que sumiu do banco: só a direta', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const { service, created } = setup([child]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(1);
  });

  it('afiliado sem pai: só a direta, e o pai nem é consultado', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const { service, created, tx } = setup([{ ...child, parentAffiliateId: null }, parent]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(1);
    expect(tx.affiliate.findUnique).toHaveBeenCalledTimes(1);
  });

  it('pai que é o próprio comprador não ganha pela própria compra', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const { service, created } = setup([child, { ...parent, userId: 'user-1' }]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(1);
    expect(created()[0].affiliateId).toBe('aff-filho');
  });

  it('fatia que arredonda a zero não é gravada', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '0.01';
    const { service, created } = setup([child, parent]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(1);
  });

  it('o avô não recebe: só um nível acima', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const grandparent: AffiliateRow = { id: 'aff-avo', userId: 'user-avo', isActive: true, parentAffiliateId: null };
    const { service, created, tx } = setup([child, { ...parent, parentAffiliateId: 'aff-avo' }, grandparent]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(2);
    expect(created().map((row) => row.affiliateId)).toEqual(['aff-filho', 'aff-pai']);
    expect(tx.affiliate.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'aff-avo' } }));
  });

  it('env inválida ou acima do teto: desligada ou presa em 20%', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5%';
    const invalid = setup([child, parent]);
    await invalid.service.activateOrRenewPerfectpaySubscription(sale);
    expect(invalid.created()).toHaveLength(1);

    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '50';
    const capped = setup([child, parent]);
    await capped.service.activateOrRenewPerfectpaySubscription(sale);
    expect(capped.created()[1].commissionCents).toBe(228);
  });

  it('sem comissão direta (afiliado inativo) não há segundo nível', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const { service, created } = setup([{ ...child, isActive: false }, parent]);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(created()).toHaveLength(0);
  });
});
