import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DailyCreditsService } from '../daily-credits.service';

/**
 * "Créditos de hoje": 1 claim por dia UTC, sequência de dias consecutivos,
 * desligado por padrão (DAILY_CREDITS_AMOUNT = 0).
 */
describe('DailyCreditsService', () => {
  const AMOUNT = 50;
  const day = (iso: string) => new Date(`${iso}T15:00:00.000Z`);

  type Row = { createdAt: Date; metadata: { dayKey: string; streakDays: number } };

  function setup(options: { amount?: string; rows?: Row[]; user?: Record<string, unknown> | null } = {}) {
    const rows: Row[] = options.rows ?? [];
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      creditTransaction: {
        findFirst: jest.fn(async () =>
          rows.length ? [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] : null,
        ),
        create: jest.fn(async ({ data }: any) => {
          rows.push({ createdAt: new Date(), metadata: data.metadata });
          return { id: 'ct-1' };
        }),
      },
      creditBalance: { upsert: jest.fn(async () => ({})) },
    };
    const prisma = {
      user: {
        findUnique: jest.fn(async () =>
          options.user === undefined ? { isActive: true, emailVerified: true } : options.user,
        ),
      },
      creditTransaction: { findFirst: tx.creditTransaction.findFirst },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const config = { get: jest.fn(() => options.amount ?? String(AMOUNT)) } as unknown as ConfigService;
    const credits = {
      getBalance: jest.fn(async () => ({ bonusCreditsRemaining: AMOUNT, totalCreditsAvailable: AMOUNT })),
    };
    const service = new DailyCreditsService(prisma as any, config, credits as any);
    return { service, tx, prisma, credits, rows };
  }

  it('desligado (env vazia, 0 ou inválida): enabled=false e o claim dá 404', async () => {
    for (const amount of ['', '0', '-5', 'abc']) {
      const { service, tx } = setup({ amount });
      await expect(service.getStatus('u1')).resolves.toEqual({
        enabled: false,
        amount: 0,
        claimedToday: false,
        streakDays: 0,
      });
      await expect(service.claim('u1')).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.creditBalance.upsert).not.toHaveBeenCalled();
    }
  });

  it('1º claim: credita o bônus, grava o extrato e devolve granted, streak 1 e o saldo', async () => {
    const { service, tx, credits } = setup();

    const result = await service.claim('u1', day('2026-11-10'));

    expect(result.granted).toBe(AMOUNT);
    expect(result.streakDays).toBe(1);
    expect(result.balance).toMatchObject({ bonusCreditsRemaining: AMOUNT });
    expect(credits.getBalance).toHaveBeenCalledWith('u1');
    expect(tx.creditBalance.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { bonusCreditsRemaining: { increment: AMOUNT } } }),
    );
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        amount: AMOUNT,
        source: 'daily',
        metadata: { dayKey: '2026-11-10', streakDays: 1 },
      }),
    });
  });

  it('2º claim no mesmo dia UTC: 409 e nenhum crédito extra', async () => {
    const { service, tx } = setup({
      rows: [{ createdAt: day('2026-11-10'), metadata: { dayKey: '2026-11-10', streakDays: 3 } }],
    });

    await expect(service.claim('u1', day('2026-11-10'))).rejects.toBeInstanceOf(ConflictException);
    expect(tx.creditBalance.upsert).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('claim às 23h59 UTC e outro às 00h01 UTC do dia seguinte contam como dias diferentes', async () => {
    const { service } = setup({
      rows: [
        {
          createdAt: new Date('2026-11-10T23:59:00.000Z'),
          metadata: { dayKey: '2026-11-10', streakDays: 1 },
        },
      ],
    });

    const result = await service.claim('u1', new Date('2026-11-11T00:01:00.000Z'));
    expect(result.streakDays).toBe(2);
  });

  it('streak: claim no dia seguinte soma 1', async () => {
    const { service } = setup({
      rows: [{ createdAt: day('2026-11-09'), metadata: { dayKey: '2026-11-09', streakDays: 4 } }],
    });

    const result = await service.claim('u1', day('2026-11-10'));
    expect(result.streakDays).toBe(5);
  });

  it('streak: pulou um dia, volta para 1', async () => {
    const { service } = setup({
      rows: [{ createdAt: day('2026-11-08'), metadata: { dayKey: '2026-11-08', streakDays: 6 } }],
    });

    const result = await service.claim('u1', day('2026-11-10'));
    expect(result.streakDays).toBe(1);
  });

  it('status: claimedToday e streak vivos (hoje/ontem) e zerados quando pulou um dia', async () => {
    const hoje = setup({
      rows: [{ createdAt: day('2026-11-10'), metadata: { dayKey: '2026-11-10', streakDays: 3 } }],
    });
    await expect(hoje.service.getStatus('u1', day('2026-11-10'))).resolves.toEqual({
      enabled: true,
      amount: AMOUNT,
      claimedToday: true,
      streakDays: 3,
    });

    const ontem = setup({
      rows: [{ createdAt: day('2026-11-09'), metadata: { dayKey: '2026-11-09', streakDays: 3 } }],
    });
    await expect(ontem.service.getStatus('u1', day('2026-11-10'))).resolves.toMatchObject({
      claimedToday: false,
      streakDays: 3,
    });

    const pulou = setup({
      rows: [{ createdAt: day('2026-11-07'), metadata: { dayKey: '2026-11-07', streakDays: 3 } }],
    });
    await expect(pulou.service.getStatus('u1', day('2026-11-10'))).resolves.toMatchObject({
      claimedToday: false,
      streakDays: 0,
    });
  });

  it('conta suspensa ou e-mail não verificado: 403 e nada creditado', async () => {
    const suspensa = setup({ user: { isActive: false, emailVerified: true } });
    await expect(suspensa.service.claim('u1')).rejects.toBeInstanceOf(ForbiddenException);

    const semEmail = setup({ user: { isActive: true, emailVerified: false } });
    await expect(semEmail.service.claim('u1')).rejects.toBeInstanceOf(ForbiddenException);

    expect(suspensa.tx.creditBalance.upsert).not.toHaveBeenCalled();
    expect(semEmail.tx.creditBalance.upsert).not.toHaveBeenCalled();
  });
});
