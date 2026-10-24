import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminService } from '../admin.service';
import { AdjustCreditsDto } from '../dto/adjust-credits.dto';

/** TKT-106: ajuste de crédito do admin com teto, autor e delta efetivo no extrato. */
function setup(bonus: number | null) {
  const balance = bonus === null ? null : { userId: 'user-1', bonusCreditsRemaining: bonus };
  const tx = {
    creditBalance: {
      findUnique: jest.fn(async () => balance),
      create: jest.fn(async () => ({})),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    creditTransaction: { create: jest.fn(async () => ({})) },
  };
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const ServiceCtor = AdminService as unknown as new (...args: unknown[]) => AdminService;
  const service = new ServiceCtor(prisma, ...Array.from({ length: 12 }, () => ({})));
  return { service, tx };
}

describe('AdminService.adjustCredits', () => {
  it('remover mais do que o bônus tem: extrato registra o que saiu de verdade e quem fez', async () => {
    const { service, tx } = setup(300);

    await service.adjustCredits('user-1', -1000, 'Correção', 'admin-9');

    expect(tx.creditBalance.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', bonusCreditsRemaining: { gte: 300 } },
      data: { bonusCreditsRemaining: { decrement: 300 } },
    });
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'ADMIN_ADJUSTMENT',
        amount: -300,
        metadata: { adminId: 'admin-9', requested: -1000, applied: -300 },
      }),
    });
  });

  it('adicionar: incremento atômico, autor no metadata', async () => {
    const { service, tx } = setup(300);

    await service.adjustCredits('user-1', 5000, 'Cortesia', 'admin-9');

    expect(tx.creditBalance.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { bonusCreditsRemaining: { increment: 5000 } },
    });
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ amount: 5000, metadata: expect.objectContaining({ adminId: 'admin-9' }) }),
    });
  });

  it('remover de quem não tem bônus: nada no extrato', async () => {
    const { service, tx } = setup(0);

    await service.adjustCredits('user-1', -500, 'Correção', 'admin-9');

    expect(tx.creditBalance.updateMany).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('DTO: zero e valores acima de 200 mil são recusados', async () => {
    const errors = async (amount: number) =>
      (await validate(plainToInstance(AdjustCreditsDto, { amount, description: 'x' }))).length;
    expect(await errors(0)).toBeGreaterThan(0);
    expect(await errors(200_001)).toBeGreaterThan(0);
    expect(await errors(-200_001)).toBeGreaterThan(0);
    expect(await errors(200_000)).toBe(0);
    expect(await errors(-50)).toBe(0);
  });
});
