import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RewardsService } from '../rewards.service';
import {
  DEFAULT_WEEKLY_CLAIM_CREDITS,
  LEGACY_WEEKLY_FREE_GENERATIONS,
  MAX_WEEKLY_CLAIM_CREDITS,
  resolveWeeklyReward,
} from '../weekly-reward';

// quarta 04/11/2026 12:00 em Brasília (15:00 UTC) e terça 03/11/2026 12:00 em Brasília
const WEDNESDAY = new Date('2026-11-04T15:00:00Z');
const TUESDAY = new Date('2026-11-03T15:00:00Z');

function makePrisma({ paying = true, claimed = false, duplicate = false } = {}) {
  const tx = {
    weeklyClaim: {
      create: jest.fn(async () => {
        if (duplicate) throw Object.assign(new Error('unique'), { code: 'P2002' });
        return {};
      }),
    },
    creditBalance: { upsert: jest.fn(async () => ({})) },
    creditTransaction: { create: jest.fn(async () => ({})) },
    userFreeGeneration: { upsert: jest.fn(async () => ({})) },
  };
  const prisma = {
    user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
    subscription: {
      findFirst: jest.fn(async () => (paying ? { plan: { slug: 'pro' } } : null)),
    },
    weeklyClaim: {
      findUnique: jest.fn(async () => (claimed ? { id: 'w1' } : null)),
    },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, tx };
}

function makeService(env: string | undefined, prismaOpts?: Parameters<typeof makePrisma>[0]) {
  const { prisma, tx } = makePrisma(prismaOpts);
  const config = { get: jest.fn(() => env) } as unknown as ConfigService;
  return { service: new RewardsService(prisma as never, config), prisma, tx };
}

describe('resolveWeeklyReward', () => {
  it('sem env: 300 créditos', () => {
    expect(resolveWeeklyReward(undefined)).toEqual({ kind: 'credits', amount: DEFAULT_WEEKLY_CLAIM_CREDITS });
    expect(resolveWeeklyReward('  ')).toEqual({ kind: 'credits', amount: DEFAULT_WEEKLY_CLAIM_CREDITS });
  });

  it('valor válido vira o crédito da semana; acima do teto fica no teto', () => {
    expect(resolveWeeklyReward('500')).toEqual({ kind: 'credits', amount: 500 });
    expect(resolveWeeklyReward('999999')).toEqual({ kind: 'credits', amount: MAX_WEEKLY_CLAIM_CREDITS });
  });

  it('valor inválido cai no padrão (nunca derruba o resgate)', () => {
    expect(resolveWeeklyReward('abc')).toEqual({ kind: 'credits', amount: DEFAULT_WEEKLY_CLAIM_CREDITS });
    expect(resolveWeeklyReward('-5')).toEqual({ kind: 'credits', amount: DEFAULT_WEEKLY_CLAIM_CREDITS });
    expect(resolveWeeklyReward('12.5')).toEqual({ kind: 'credits', amount: DEFAULT_WEEKLY_CLAIM_CREDITS });
  });

  it('0 volta ao bônus antigo de 4 gerações grátis', () => {
    expect(resolveWeeklyReward('0')).toEqual({ kind: 'free_generations', amount: LEGACY_WEEKLY_FREE_GENERATIONS });
  });
});

describe('RewardsService · bônus de quarta', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('status diz o que entrega: 300 créditos, resgate aberto na quarta para quem paga', async () => {
    jest.setSystemTime(WEDNESDAY);
    const { service } = makeService(undefined);
    const status = await service.getWeeklyClaimStatus('u1');
    expect(status).toMatchObject({ canClaim: true, isPaying: true, amount: 300, rewardKind: 'credits', weekKey: '2026-11-04', isWindowOpen: true });
  });

  it('resgate em créditos: linha da semana, +300 no bônus e extrato WEEKLY_BONUS', async () => {
    jest.setSystemTime(WEDNESDAY);
    const { service, tx } = makeService(undefined);
    await service.claimWeekly('u1');
    expect(tx.weeklyClaim.create).toHaveBeenCalledWith({ data: { userId: 'u1', weekKey: '2026-11-04', amount: 300 } });
    expect(tx.creditBalance.upsert).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      create: { userId: 'u1', bonusCreditsRemaining: 300, planCreditsRemaining: 0, planCreditsUsed: 0 },
      update: { bonusCreditsRemaining: { increment: 300 } },
    });
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', type: 'WEEKLY_BONUS', amount: 300, source: 'bonus', metadata: { weekKey: '2026-11-04' } }),
    });
    expect(tx.userFreeGeneration.upsert).not.toHaveBeenCalled();
  });

  it('WEEKLY_CLAIM_CREDITS=0: bônus antigo (4 gerações, sem crédito)', async () => {
    jest.setSystemTime(WEDNESDAY);
    const { service, tx } = makeService('0');
    const status = await service.claimWeekly('u1');
    expect(tx.userFreeGeneration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ remaining: 4 }), update: { remaining: 4 } }),
    );
    expect(tx.creditBalance.upsert).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    expect(status.rewardKind).toBe('free_generations');
  });

  it('fora da quarta: recusa sem tocar no saldo', async () => {
    jest.setSystemTime(TUESDAY);
    const { service, prisma } = makeService(undefined);
    await expect(service.claimWeekly('u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('quem não paga: recusa sem tocar no saldo', async () => {
    jest.setSystemTime(WEDNESDAY);
    const { service, prisma } = makeService(undefined, { paying: false });
    await expect(service.claimWeekly('u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('2º resgate na mesma semana: 409 e nenhum crédito', async () => {
    jest.setSystemTime(WEDNESDAY);
    const { service, tx } = makeService(undefined, { duplicate: true });
    await expect(service.claimWeekly('u1')).rejects.toBeInstanceOf(ConflictException);
    expect(tx.creditBalance.upsert).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });
});
