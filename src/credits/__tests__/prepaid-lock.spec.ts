import { CreditsService } from '../credits.service';

/**
 * Trava do pré-pago vencido: sem geração grátis (cai no INSUFFICIENT_CREDITS que o site
 * já trata). Créditos de pacote/bônus não passam por aqui e seguem valendo.
 */
describe('CreditsService · trava do pré-pago vencido', () => {
  const ORIGINAL = process.env.PREPAID_LOCK_ON_EXPIRY;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PREPAID_LOCK_ON_EXPIRY;
    else process.env.PREPAID_LOCK_ON_EXPIRY = ORIGINAL;
  });

  const HOUR = 60 * 60 * 1000;
  const ended = new Date(Date.now() - 2 * 24 * HOUR);
  const expiredPrepaid = {
    status: 'CANCELED',
    currentPeriodEnd: ended,
    updatedAt: new Date(ended.getTime() + HOUR),
    plan: { slug: 'pro-30d' },
  };

  function make(opts: { remaining: number; active?: boolean; latest?: Record<string, unknown> | null }) {
    const findFirst = jest.fn(async (args: any) => {
      if (args.where.status === 'ACTIVE') return opts.active ? { id: 'sub-active' } : null;
      return opts.latest ?? null;
    });
    const prisma = {
      userFreeGeneration: {
        findUnique: jest.fn(async () => ({ remaining: opts.remaining })),
        findMany: jest.fn(async () => [{ type: 'NB2', remaining: opts.remaining }]),
      },
      creditBalance: { findUnique: jest.fn(async () => null) },
      subscription: { findFirst },
    };
    const plansService = { calculateGenerationCost: jest.fn(async () => 10) };
    return { service: new CreditsService(prisma as any, plansService as any), findFirst };
  }

  it('pré-pago vencido sem assinatura ativa: não tem geração grátis', async () => {
    delete process.env.PREPAID_LOCK_ON_EXPIRY;
    const { service } = make({ remaining: 3, latest: expiredPrepaid });
    await expect(service.hasFreeGeneration('u-1', 'NB2' as any)).resolves.toBe(false);
  });

  it('a estimativa também não promete geração grátis', async () => {
    const { service } = make({ remaining: 3, latest: expiredPrepaid });
    const estimate = await service.estimateCost('u-1', 'TEXT_TO_IMAGE' as any, 'HD' as any, undefined, false, 1, 'NB2');
    expect(estimate.canUseFreeGeneration).toBe(false);
    expect(estimate.hasSufficientBalance).toBe(false);
  });

  it('PREPAID_LOCK_ON_EXPIRY=off desliga a trava', async () => {
    process.env.PREPAID_LOCK_ON_EXPIRY = 'off';
    const { service, findFirst } = make({ remaining: 3, latest: expiredPrepaid });
    await expect(service.hasFreeGeneration('u-1', 'NB2' as any)).resolves.toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('recomprou (assinatura ACTIVE): grátis liberado', async () => {
    const { service } = make({ remaining: 3, active: true, latest: expiredPrepaid });
    await expect(service.hasFreeGeneration('u-1', 'NB2' as any)).resolves.toBe(true);
  });

  it('estorno (cancelado antes do fim) e plano recorrente vencido não travam', async () => {
    const refunded = { ...expiredPrepaid, updatedAt: new Date(ended.getTime() - 10 * 24 * HOUR) };
    await expect(make({ remaining: 1, latest: refunded }).service.hasFreeGeneration('u-1', 'NB2' as any)).resolves.toBe(true);
    const recurring = { ...expiredPrepaid, plan: { slug: 'pro' } };
    await expect(make({ remaining: 1, latest: recurring }).service.hasFreeGeneration('u-1', 'NB2' as any)).resolves.toBe(true);
  });

  it('vencido há mais de 120 dias: não trava mais', async () => {
    const oldEnd = new Date(Date.now() - 121 * 24 * HOUR);
    const old = { ...expiredPrepaid, currentPeriodEnd: oldEnd, updatedAt: new Date(oldEnd.getTime() + HOUR) };
    await expect(make({ remaining: 1, latest: old }).service.hasFreeGeneration('u-1', 'NB2' as any)).resolves.toBe(true);
  });

  it('sem geração grátis no saldo: nem consulta assinatura', async () => {
    const { service, findFirst } = make({ remaining: 0, latest: expiredPrepaid });
    await expect(service.hasFreeGeneration('u-1', 'NB2' as any)).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
