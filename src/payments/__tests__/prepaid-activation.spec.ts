import { PaymentsService } from '../payments.service';

/** Pré-pago de 30 dias: toda ativação e toda recompra grava cancelAtPeriodEnd=true. */
describe('Ativação do pré-pago (Perfect Pay, pagamento único)', () => {
  const prepaidPlan = { id: 'plan-pro-30d', slug: 'pro-30d', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };
  const recurringPlan = { id: 'plan-pro', slug: 'pro', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };

  function setup(plan: typeof prepaidPlan, activeSub: Record<string, unknown> | null = null) {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      payment: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })),
      },
      subscription: {
        findFirst: jest.fn(async () => activeSub),
        update: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
      },
      creditBalance: { upsert: jest.fn(async () => ({})), update: jest.fn(async () => ({})) },
      creditTransaction: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
      affiliate: { findUnique: jest.fn(async () => null) },
      affiliateEarning: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
    };
    const prisma = {
      plan: { findUnique: jest.fn(async () => plan) },
      user: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new PaymentsService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    return { service, tx };
  }

  const sale = { userId: 'user-1', planId: 'plan-pro-30d', saleCode: 'PPCPMT1', amountCents: 3990, currency: 'usd' };

  it('primeira compra do pré-pago: cria a assinatura já com cancelAtPeriodEnd=true', async () => {
    const { service, tx } = setup(prepaidPlan);

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
    expect((tx.subscription.create.mock.calls as any[][])[0][0].data).toMatchObject({
      planId: 'plan-pro-30d',
      status: 'ACTIVE',
      cancelAtPeriodEnd: true,
      paymentProvider: 'perfectpay',
    });
  });

  it('recompra do mesmo pré-pago: estende e mantém cancelAtPeriodEnd=true (antes zerava)', async () => {
    const currentEnd = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const { service, tx } = setup(prepaidPlan, {
      id: 'sub-1',
      planId: 'plan-pro-30d',
      externalSubscriptionId: 'PPCPMT0',
      currentPeriodEnd: currentEnd,
      cancelAtPeriodEnd: true,
    });

    await service.activateOrRenewPerfectpaySubscription({ ...sale, saleCode: 'PPCPMT2' });

    expect(tx.subscription.create).not.toHaveBeenCalled();
    const data = (tx.subscription.update.mock.calls as any[][])[0][0].data;
    expect(data.cancelAtPeriodEnd).toBe(true);
    // Período continua somando 1 mês de calendário a partir do fim vigente.
    const expectedEnd = new Date(currentEnd);
    expectedEnd.setMonth(expectedEnd.getMonth() + 1);
    expect(data.currentPeriodEnd.getTime()).toBe(expectedEnd.getTime());
    // Créditos do plano: reset para creditsPerMonth, como antes.
    expect(tx.creditBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ planCreditsRemaining: 30000, planCreditsUsed: 0 }) }),
    );
  });

  it('assinatura recorrente: renovação continua limpando o cancelAtPeriodEnd', async () => {
    const { service, tx } = setup(recurringPlan as typeof prepaidPlan, {
      id: 'sub-1',
      planId: 'plan-pro',
      externalSubscriptionId: 'PPSUB1',
      currentPeriodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    await service.activateOrRenewPerfectpaySubscription({ ...sale, planId: 'plan-pro', subscriptionCode: 'PPSUB1' });

    expect((tx.subscription.update.mock.calls as any[][])[0][0].data.cancelAtPeriodEnd).toBe(false);
  });

  it('primeira compra de plano recorrente: cancelAtPeriodEnd=false', async () => {
    const { service, tx } = setup(recurringPlan as typeof prepaidPlan);

    await service.activateOrRenewPerfectpaySubscription({ ...sale, planId: 'plan-pro', subscriptionCode: 'PPSUB9' });

    expect((tx.subscription.create.mock.calls as any[][])[0][0].data.cancelAtPeriodEnd).toBe(false);
  });
});
