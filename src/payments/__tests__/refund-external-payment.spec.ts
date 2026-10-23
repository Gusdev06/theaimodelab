import { PaymentsService } from '../payments.service';

/**
 * Reembolso/chargeback de venda registrada (TKT-099 / TKT-110): pack perde o
 * bônus que sobra, pagamento vira REFUNDED, comissão PENDING some, idempotente.
 */
function setup(opts: {
  payment: Record<string, any> | null;
  bonus?: number;
  paidEarnings?: number;
  conditionalUpdateCount?: number;
}) {
  const balance = { userId: 'user-1', bonusCreditsRemaining: opts.bonus ?? 0 };
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    payment: {
      findFirst: jest.fn(async () => opts.payment),
      update: jest.fn(async () => ({})),
    },
    creditBalance: {
      findUnique: jest.fn(async () => balance),
      updateMany: jest.fn(async ({ data }: any) => {
        const count = opts.conditionalUpdateCount ?? 1;
        if (count === 1) balance.bonusCreditsRemaining -= data.bonusCreditsRemaining.decrement;
        return { count };
      }),
    },
    creditTransaction: {
      create: jest.fn(async () => ({})),
      aggregate: jest.fn(async () => ({ _sum: { amount: 0 } })),
    },
    affiliateEarning: {
      deleteMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => opts.paidEarnings ?? 0),
    },
  };
  const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const service = new PaymentsService(prisma as any, {} as any, {} as any, {} as any, {} as any);
  return { service, tx, balance };
}

const pack = (overrides: Record<string, any> = {}) => ({
  id: 'pay-1',
  userId: 'user-1',
  type: 'CREDIT_PURCHASE',
  status: 'COMPLETED',
  externalPaymentId: 'perfectpay-PPCODE',
  creditPackage: { name: 'Mega', credits: 25000 },
  ...overrides,
});

describe('PaymentsService.refundExternalPayment', () => {
  it('pack com bônus suficiente: retira o pacote inteiro, marca REFUNDED e cancela a comissão PENDING', async () => {
    const { service, tx, balance } = setup({ payment: pack(), bonus: 30000 });

    const result = await service.refundExternalPayment('perfectpay-PPCODE', 'refund');

    expect(result).toEqual({
      found: true,
      type: 'CREDIT_PURCHASE',
      creditsRevoked: 25000,
      creditsShortfall: 0,
      earningsCanceled: 1,
    });
    expect(balance.bonusCreditsRemaining).toBe(5000);
    expect(tx.creditBalance.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', bonusCreditsRemaining: { gte: 25000 } },
      data: { bonusCreditsRemaining: { decrement: 25000 } },
    });
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'PURCHASE', amount: -25000, source: 'bonus', paymentId: 'pay-1' }),
    });
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'pay-1' }, data: { status: 'REFUNDED' } });
    expect(tx.affiliateEarning.deleteMany).toHaveBeenCalledWith({ where: { paymentId: 'pay-1', status: 'PENDING' } });
    expect(tx.$executeRaw).toHaveBeenCalled(); // lock por venda
  });

  it('cliente já gastou parte: retira só o que sobra e informa o já consumido', async () => {
    const { service, balance } = setup({ payment: pack(), bonus: 4000 });

    const result = await service.refundExternalPayment('perfectpay-PPCODE', 'chargeback');

    expect(result).toMatchObject({ creditsRevoked: 4000, creditsShortfall: 21000 });
    expect(balance.bonusCreditsRemaining).toBe(0);
  });

  it('sem bônus nenhum: não cria transação negativa, mas marca o pagamento', async () => {
    const { service, tx } = setup({ payment: pack(), bonus: 0 });

    const result = await service.refundExternalPayment('perfectpay-PPCODE', 'refund');

    expect(result).toMatchObject({ creditsRevoked: 0, creditsShortfall: 25000 });
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalled();
  });

  it('segundo postback do mesmo reembolso é no-op', async () => {
    const { service, tx } = setup({ payment: pack({ status: 'REFUNDED' }), bonus: 30000 });

    const result = await service.refundExternalPayment('perfectpay-PPCODE', 'refund');

    expect(result).toEqual({ found: true, type: 'CREDIT_PURCHASE', alreadyRefunded: true });
    expect(tx.creditBalance.updateMany).not.toHaveBeenCalled();
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it('pagamento de assinatura: marca REFUNDED e cancela comissão, sem mexer em bônus', async () => {
    const { service, tx } = setup({ payment: pack({ type: 'SUBSCRIPTION', creditPackage: null }), bonus: 30000 });

    const result = await service.refundExternalPayment('perfectpay-PPSUBSALE', 'refund');

    expect(result).toMatchObject({ found: true, type: 'SUBSCRIPTION', creditsRevoked: 0 });
    expect(tx.creditBalance.updateMany).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalledWith({ where: { id: 'pay-1' }, data: { status: 'REFUNDED' } });
    expect(tx.affiliateEarning.deleteMany).toHaveBeenCalled();
  });

  it('venda desconhecida: found=false e nada muda', async () => {
    const { service, tx } = setup({ payment: null });

    await expect(service.refundExternalPayment('perfectpay-NADA', 'refund')).resolves.toEqual({ found: false });
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it('débito concorrente mudou o saldo nas duas tentativas: não fica negativo, registra o não retirado', async () => {
    const { service, tx } = setup({ payment: pack(), bonus: 30000, conditionalUpdateCount: 0 });

    const result = await service.refundExternalPayment('perfectpay-PPCODE', 'refund');

    expect(tx.creditBalance.updateMany).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ creditsRevoked: 0, creditsShortfall: 25000 });
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });
});
