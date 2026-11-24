import { PaymentsService } from '../payments.service';

/**
 * Retentativa tardia (23/11): a Perfect Pay recupera a cobrança da MESMA recorrência (mesmo PPSUB) depois que o
 * cron de vencimento já cancelou a assinatura local. Tem de reabrir a assinatura antiga (renovação), não criar outra.
 */
describe('Cobrança atrasada da mesma recorrência (Perfect Pay/Cakto)', () => {
  const plan = { id: 'plan-pro', slug: 'pro', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };
  const DAY = 24 * 60 * 60 * 1000;

  type Sub = Record<string, unknown> | null;

  function setup({ active = null, lapsed = null }: { active?: Sub; lapsed?: Sub } = {}) {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      payment: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })),
      },
      subscription: {
        // ACTIVE/PAST_DUE → assinatura ativa; CANCELED → a que o cron cancelou
        findFirst: jest.fn(async ({ where }: any) => (where.status === 'CANCELED' ? lapsed : active)),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }: any) => ({ id: 'sub-nova', ...data })),
      },
      creditBalance: { upsert: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
      creditTransaction: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
      affiliate: { findUnique: jest.fn(async () => null) },
      affiliateEarning: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
      plan: { findUnique: jest.fn(async () => plan) },
    };
    const prisma = {
      plan: { findUnique: jest.fn(async () => plan) },
      user: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new PaymentsService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
    return { service, tx, prisma };
  }

  const sale = {
    userId: 'user-1',
    planId: 'plan-pro',
    saleCode: 'PPCPMT-RETRY',
    subscriptionCode: 'PPSUB1',
    amountCents: 3990,
    currency: 'usd',
  };
  const lapsedSub = {
    id: 'sub-antiga',
    planId: 'plan-pro',
    status: 'CANCELED',
    externalSubscriptionId: 'PPSUB1',
    currentPeriodEnd: new Date(Date.now() - 10 * DAY),
    cancelAtPeriodEnd: false,
  };

  afterEach(() => {
    delete process.env.LAPSED_RENEWAL_REOPEN;
  });

  it('reabre a assinatura cancelada pelo cron em vez de criar outra (conta como renovação)', async () => {
    const { service, tx, prisma } = setup({ lapsed: lapsedSub });
    const before = new Date();

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.subscription.create).not.toHaveBeenCalled();
    const call = (tx.subscription.update.mock.calls as any[][])[0][0];
    expect(call.where.id).toBe('sub-antiga');
    expect(call.data).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: false, paymentRetryCount: 0, externalSubscriptionId: 'PPSUB1' });
    // período novo a partir de agora (o antigo já venceu), +1 mês
    expect(call.data.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before.getTime());
    const expectedEnd = new Date(call.data.currentPeriodStart);
    expectedEnd.setMonth(expectedEnd.getMonth() + 1);
    expect(call.data.currentPeriodEnd.getTime()).toBe(expectedEnd.getTime());
    // o pagamento fica na MESMA assinatura (a torre conta renovação)
    expect((tx.payment.create.mock.calls as any[][])[0][0].data.subscriptionId).toBe('sub-antiga');
    // créditos do plano voltam
    expect(tx.creditBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ planCreditsRemaining: 30000, planCreditsUsed: 0 }) }),
    );
    expect(String((tx.creditTransaction.create.mock.calls as any[][])[0][0].data.description)).toContain('Renovação');
    // renovação não dispara e-mail de boas-vindas nem Purchase no CAPI (só a ativação busca a usuária para isso)
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('cancela outra assinatura ativa ao reabrir (nunca 2 ativas)', async () => {
    const { service, tx } = setup({ lapsed: lapsedSub });

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.subscription.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', id: { not: 'sub-antiga' }, status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      data: { status: 'CANCELED', cancelAtPeriodEnd: false },
    });
  });

  it('procura a cancelada só pelo mesmo código e o mesmo gateway', async () => {
    const { service, tx } = setup({ lapsed: lapsedSub });

    await service.activateOrRenewPerfectpaySubscription({ ...sale, provider: 'cakto' });

    const canceledQuery = (tx.subscription.findFirst.mock.calls as any[][]).map((c) => c[0]).find((q) => q.where.status === 'CANCELED');
    expect(canceledQuery.where).toEqual({
      userId: 'user-1',
      paymentProvider: 'cakto',
      externalSubscriptionId: 'PPSUB1',
      status: 'CANCELED',
    });
  });

  it('sem cancelada com o mesmo código: continua criando (1ª compra)', async () => {
    const { service, tx, prisma } = setup();

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
    expect(tx.subscription.update).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).toHaveBeenCalled();
  });

  it('com assinatura ativa no gateway: não procura a cancelada (renovação normal ou troca de plano como antes)', async () => {
    const active = {
      id: 'sub-ativa',
      planId: 'plan-pro',
      status: 'ACTIVE',
      externalSubscriptionId: 'PPSUB2',
      currentPeriodEnd: new Date(Date.now() + 5 * DAY),
      cancelAtPeriodEnd: false,
    };
    const { service, tx } = setup({ active, lapsed: lapsedSub });

    await service.activateOrRenewPerfectpaySubscription(sale);

    const queries = (tx.subscription.findFirst.mock.calls as any[][]).map((c) => c[0].where.status);
    expect(queries).not.toContain('CANCELED');
    // PPSUB1 ≠ PPSUB2 → troca de plano: cria nova, como antes
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
  });

  it('sem código PPSUB no postback: não reabre nada', async () => {
    const { service, tx } = setup({ lapsed: lapsedSub });

    await service.activateOrRenewPerfectpaySubscription({ ...sale, subscriptionCode: undefined });

    const queries = (tx.subscription.findFirst.mock.calls as any[][]).map((c) => c[0].where.status);
    expect(queries).not.toContain('CANCELED');
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
  });

  it('LAPSED_RENEWAL_REOPEN=off volta ao comportamento antigo', async () => {
    process.env.LAPSED_RENEWAL_REOPEN = 'off';
    const { service, tx } = setup({ lapsed: lapsedSub });

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
    expect(tx.subscription.update).not.toHaveBeenCalled();
  });

  it('pré-pago (*-30d) nunca reabre recorrente cancelada', async () => {
    const prepaid = { id: 'plan-pro-30d', slug: 'pro-30d', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };
    const { service, tx, prisma } = setup({ lapsed: lapsedSub });
    prisma.plan.findUnique.mockImplementation(async () => prepaid as any);

    await service.activateOrRenewPerfectpaySubscription({ ...sale, planId: 'plan-pro-30d' });

    const queries = (tx.subscription.findFirst.mock.calls as any[][]).map((c) => c[0].where.status);
    expect(queries).not.toContain('CANCELED');
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
  });
});
