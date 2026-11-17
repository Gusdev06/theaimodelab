import { PerfectpaySubscriptionExpiryService } from '../perfectpay-subscription-expiry.service';

/** Pré-pago vence no fim do período, sem carência (inclusive o liberado pelo admin). */
describe('PerfectpaySubscriptionExpiryService · pré-pago admin', () => {
  function make(expired: Array<{ id: string; userId: string }>) {
    const tx = {
      subscription: { update: jest.fn(async () => ({})) },
      creditBalance: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      subscription: { findMany: jest.fn(async () => expired) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const cronLogger = { wrap: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn()) };
    const service = new PerfectpaySubscriptionExpiryService(prisma as any, cronLogger as any);
    return { service, prisma, tx };
  }

  it('pré-pago (perfectpay/cakto/admin) sem carência, mesmo com o flag em false; recorrente segue como antes', async () => {
    const { service, prisma } = make([]);

    await service.handleExpiry();

    const where = (prisma.subscription.findMany.mock.calls as any[][])[0][0].where;
    expect(where.status).toBe('ACTIVE');
    expect(where.paymentProvider).toBeUndefined();
    expect(where.OR).toHaveLength(3);
    const [scheduled, lapsed, admin] = where.OR;
    expect(scheduled).toMatchObject({ paymentProvider: { in: ['perfectpay', 'cakto'] }, cancelAtPeriodEnd: true });
    expect(lapsed).toMatchObject({ paymentProvider: { in: ['perfectpay', 'cakto'] }, cancelAtPeriodEnd: false });
    // Carência de 3 dias só para a recorrência lapsada.
    expect(lapsed.currentPeriodEnd.lte.getTime()).toBeLessThan(scheduled.currentPeriodEnd.lte.getTime());
    expect(admin).toEqual({
      paymentProvider: { in: ['perfectpay', 'cakto', 'admin'] },
      plan: { slug: { endsWith: '-30d' } },
      currentPeriodEnd: { lte: scheduled.currentPeriodEnd.lte },
    });
  });

  it('assinatura vencida: CANCELED e zera os créditos do plano (bônus fica)', async () => {
    const { service, tx } = make([{ id: 'sub-admin', userId: 'user-9' }]);

    const result = await service.handleExpiry();

    expect(result).toEqual({ candidates: 1, expired: 1 });
    expect(tx.subscription.update).toHaveBeenCalledWith({ where: { id: 'sub-admin' }, data: { status: 'CANCELED' } });
    expect(tx.creditBalance.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-9' },
      data: { planCreditsRemaining: 0, planCreditsUsed: 0 },
    });
  });
});
