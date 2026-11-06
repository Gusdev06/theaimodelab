import { PaymentsService } from '../payments.service';
import {
  AFFILIATE_RECURRING_MAX_MONTHS,
  renewalEarnsCommission,
  resolveAffiliateRecurringWindow,
} from '../../affiliates/affiliate-recurring';

/**
 * Comissão de afiliado nas renovações da Perfect Pay/Cakto: desligada por padrão
 * (só a primeira ativação paga), ligada pela env AFFILIATE_RECURRING_MONTHS.
 */
describe('resolveAffiliateRecurringWindow', () => {
  it.each([undefined, null, '', '   ', '0', '-3', 'abc', '12 meses', '1.5'])(
    'mantém o comportamento de hoje para %p',
    (raw) => {
      expect(resolveAffiliateRecurringWindow(raw as string | undefined)).toEqual({ mode: 'first-only' });
    },
  );

  it('"all" paga enquanto a assinatura durar', () => {
    expect(resolveAffiliateRecurringWindow(' ALL ')).toEqual({ mode: 'lifetime' });
  });

  it('número vira janela em meses, com teto', () => {
    expect(resolveAffiliateRecurringWindow('12')).toEqual({ mode: 'months', months: 12 });
    expect(resolveAffiliateRecurringWindow('9999')).toEqual({
      mode: 'months',
      months: AFFILIATE_RECURRING_MAX_MONTHS,
    });
  });
});

describe('renewalEarnsCommission', () => {
  const first = new Date('2026-01-10T12:00:00Z');

  it('first-only nunca paga renovação', () => {
    expect(renewalEarnsCommission({ mode: 'first-only' }, first, new Date('2026-02-10T12:00:00Z'))).toBe(false);
  });

  it('lifetime sempre paga', () => {
    expect(renewalEarnsCommission({ mode: 'lifetime' }, first, new Date('2031-01-10T12:00:00Z'))).toBe(true);
  });

  it('janela em meses conta da primeira comissão', () => {
    const window = { mode: 'months' as const, months: 3 };
    expect(renewalEarnsCommission(window, first, new Date('2026-04-10T11:59:59Z'))).toBe(true);
    expect(renewalEarnsCommission(window, first, new Date('2026-04-10T12:00:00Z'))).toBe(false);
  });

  it('sem comissão anterior, a janela começa nesta cobrança', () => {
    expect(renewalEarnsCommission({ mode: 'months', months: 3 }, null, new Date('2026-04-10T12:00:00Z'))).toBe(true);
  });
});

describe('PaymentsService.activateOrRenewPerfectpaySubscription · comissão na renovação', () => {
  const ORIGINAL_ENV = process.env.AFFILIATE_RECURRING_MONTHS;
  const plan = { id: 'plan-pro', slug: 'pro', name: 'Pro', creditsPerMonth: 30000, billingInterval: 'month' };

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.AFFILIATE_RECURRING_MONTHS;
    else process.env.AFFILIATE_RECURRING_MONTHS = ORIGINAL_ENV;
  });

  function setup(opts: { activeSub: Record<string, unknown> | null; firstEarningAt?: Date | null }) {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      payment: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })),
      },
      subscription: {
        findFirst: jest.fn(async () => opts.activeSub),
        update: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
        updateMany: jest.fn(async () => ({ count: 0 })),
        create: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
      },
      creditBalance: { upsert: jest.fn(async () => ({})) },
      creditTransaction: { create: jest.fn(async () => ({})) },
      affiliate: {
        findUnique: jest.fn(async () => ({ id: 'aff-1', isActive: true, commissionPercent: 30 })),
      },
      affiliateEarning: {
        findFirst: jest.fn(async () =>
          opts.firstEarningAt ? { createdAt: opts.firstEarningAt } : null,
        ),
        create: jest.fn(async () => ({ id: 'ae-1' })),
      },
    };
    const prisma = {
      plan: { findUnique: jest.fn(async () => plan) },
      user: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = new PaymentsService(prisma as any, {} as any, {} as any, {} as any, {} as any);
    return { service, tx };
  }

  const renewingSub = {
    id: 'sub-1',
    planId: 'plan-pro',
    externalSubscriptionId: 'PPSUB1',
    currentPeriodEnd: new Date(Date.now() + 86_400_000),
  };

  const sale = {
    userId: 'user-1',
    planId: 'plan-pro',
    saleCode: 'PPCPMTB999',
    subscriptionCode: 'PPSUB1',
    amountCents: 3990,
    currency: 'usd',
    referredByCode: 'PARCEIRA',
  };

  it('sem a env, renovação não paga comissão (comportamento de sempre)', async () => {
    delete process.env.AFFILIATE_RECURRING_MONTHS;
    const { service, tx } = setup({ activeSub: renewingSub });

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.subscription.update).toHaveBeenCalled();
    expect(tx.affiliateEarning.create).not.toHaveBeenCalled();
  });

  it('primeira ativação paga comissão com ou sem a env', async () => {
    delete process.env.AFFILIATE_RECURRING_MONTHS;
    const { service, tx } = setup({ activeSub: null });

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.subscription.create).toHaveBeenCalled();
    expect(tx.affiliateEarning.create).toHaveBeenCalledTimes(1);
  });

  it('"all" paga a renovação sem consultar a janela', async () => {
    process.env.AFFILIATE_RECURRING_MONTHS = 'all';
    const { service, tx } = setup({ activeSub: renewingSub });

    await service.activateOrRenewPerfectpaySubscription(sale);

    expect(tx.affiliateEarning.findFirst).not.toHaveBeenCalled();
    expect(tx.affiliateEarning.create).toHaveBeenCalledTimes(1);
    const { data } = (tx.affiliateEarning.create.mock.calls[0] as any[])[0];
    expect(data).toMatchObject({ affiliateId: 'aff-1', paymentId: 'pay-1', userId: 'user-1', status: 'PENDING' });
  });

  it('janela em meses: paga dentro, não paga depois', async () => {
    process.env.AFFILIATE_RECURRING_MONTHS = '12';

    const inside = setup({ activeSub: renewingSub, firstEarningAt: new Date(Date.now() - 30 * 86_400_000) });
    await inside.service.activateOrRenewPerfectpaySubscription(sale);
    expect(inside.tx.affiliateEarning.create).toHaveBeenCalledTimes(1);

    const outside = setup({ activeSub: renewingSub, firstEarningAt: new Date(Date.now() - 400 * 86_400_000) });
    await outside.service.activateOrRenewPerfectpaySubscription(sale);
    expect(outside.tx.affiliateEarning.create).not.toHaveBeenCalled();
  });

  it('cliente sem código de afiliado nunca gera comissão', async () => {
    process.env.AFFILIATE_RECURRING_MONTHS = 'all';
    const { service, tx } = setup({ activeSub: renewingSub });

    await service.activateOrRenewPerfectpaySubscription({ ...sale, referredByCode: undefined });

    expect(tx.affiliateEarning.create).not.toHaveBeenCalled();
  });
});
