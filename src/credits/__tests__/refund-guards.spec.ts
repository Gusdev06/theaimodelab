import { CreditsService } from '../credits.service';

/** TKT-111: estorno de treino de avatar e ajuste de custo não devolvem o que não foi debitado. */
function setup(ledger: Array<{ type: string; source: string; amount: number }>) {
  const tx = {
    creditTransaction: {
      findMany: jest.fn(async () => ledger),
      create: jest.fn(async () => ({})),
    },
    $queryRawUnsafe: jest.fn(async () => [
      { user_id: 'user-1', plan_credits_remaining: 1000, bonus_credits_remaining: 500, plan_credits_used: 4000 },
    ]),
    creditBalance: { update: jest.fn(async () => ({})) },
  };
  const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  const service = new CreditsService(prisma as any, {} as any);
  return { service, tx };
}

describe('CreditsService — estornos só do que foi debitado', () => {
  it('avatar sem débito registrado: não estorna (antes virava bônus)', async () => {
    const { service, tx } = setup([]);

    await service.refundForAvatar('user-1', 'avatar-1', 3000);

    expect(tx.creditBalance.update).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('avatar estornado pelo webhook e depois pelo cron: o segundo é no-op', async () => {
    const { service, tx } = setup([
      { type: 'AVATAR_TRAINING_DEBIT', source: 'plan', amount: -3000 },
      { type: 'AVATAR_TRAINING_REFUND', source: 'plan', amount: 3000 },
    ]);

    await service.refundForAvatar('user-1', 'avatar-1', 3000);

    expect(tx.creditBalance.update).not.toHaveBeenCalled();
  });

  it('avatar com débito: devolve para a fonte original', async () => {
    const { service, tx } = setup([{ type: 'AVATAR_TRAINING_DEBIT', source: 'bonus', amount: -3000 }]);

    await service.refundForAvatar('user-1', 'avatar-1', 3000);

    expect(tx.creditBalance.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { planCreditsRemaining: 1000, bonusCreditsRemaining: 3500, planCreditsUsed: 4000 },
    });
  });

  it('ajuste de custo positivo sem débito: nada é creditado', async () => {
    const { service, tx } = setup([]);

    await service.adjustGenerationCost('user-1', 'gen-1', 500, 'teste');

    expect(tx.creditBalance.update).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('ajuste de custo nunca devolve mais do que resta do débito', async () => {
    const { service, tx } = setup([
      { type: 'GENERATION_DEBIT', source: 'plan', amount: -1000 },
      { type: 'GENERATION_REFUND', source: 'plan', amount: 800 },
    ]);

    await service.adjustGenerationCost('user-1', 'gen-1', 500, 'teste');

    expect(tx.creditTransaction.create).toHaveBeenCalledTimes(1);
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'GENERATION_REFUND', amount: 200, source: 'plan' }),
    });
  });
});
