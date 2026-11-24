import {
  activationPlanCredits,
  addBillingPeriod,
  affiliateMaxPercentForPlan,
  billingPeriodMonths,
  bumpPackageNameForCodes,
  candyCheckoutUrls,
  candyPlanSlugForCodes,
  inSubscribersOnlyArm,
  isCandyBillingPlan,
  lockPackagesForNonSubscribers,
  resolveFirstMonthCredits,
  resolvePacksSubscribersOnlyPct,
  subscriptionBillingNote,
  userBucket,
} from '../candy-vitrine';
import { computeAnnualFirstMonthBonusCredits } from '../../payments/annual-bonus';
import { PlansService } from '../plans.service';
import { PaymentsService } from '../../payments/payments.service';
import { PerfectpayWebhookService } from '../../pending-grants/perfectpay-webhook.service';

/**
 * candy-vitrine (24/11/2026): 1º mês de entrada (L03), bônus do anual por slug (L08), bump de créditos no plano
 * (L09), trimestral (L13), 28 dias (L21) e pacote só para assinante (L28). Regra: env vazia = igual a hoje.
 */
const OFF = {} as Record<string, string | undefined>;

describe('candy-vitrine · flags desligadas = comportamento de hoje', () => {
  it('sem env: nenhum link, nenhum código, nenhum bump, nenhum A/B, créditos cheios', () => {
    expect(candyCheckoutUrls('USD', OFF).size).toBe(0);
    expect(candyCheckoutUrls('BRL', OFF).size).toBe(0);
    expect(candyPlanSlugForCodes(['PPLX'], OFF)).toBeNull();
    expect(bumpPackageNameForCodes(['PPLX'], OFF)).toBeNull();
    expect(resolvePacksSubscribersOnlyPct(OFF)).toBe(0);
    expect(resolveFirstMonthCredits(OFF)).toBe(0);
    expect(activationPlanCredits({ slug: 'creator-entrada', creditsPerMonth: 12000 }, OFF)).toBe(12000);
    expect(activationPlanCredits({ slug: 'creator', creditsPerMonth: 12000 }, OFF)).toBe(12000);
  });

  it('planos de sempre: período e soma de datas iguais aos de antes', () => {
    expect(billingPeriodMonths({ slug: 'creator', billingInterval: 'month' })).toBe(1);
    expect(billingPeriodMonths({ slug: 'creator-anual', billingInterval: 'year' })).toBe(12);
    expect(billingPeriodMonths({ slug: 'creator-90d', billingInterval: 'month' })).toBe(3);
    const d = new Date('2026-01-31T12:00:00Z');
    const expected = new Date(d);
    expected.setMonth(expected.getMonth() + 1);
    expect(addBillingPeriod(new Date(d), { billingInterval: 'month' }, 1).getTime()).toBe(expected.getTime());
    expect(isCandyBillingPlan({ slug: 'creator', billingInterval: 'month' })).toBe(false);
    expect(subscriptionBillingNote({ slug: 'pro', billingInterval: 'month', creditsPerMonth: 30000 }, { firstMonthCredits: 0, amountCents: 3990, currency: 'USD' })).toBeNull();
  });

  it('teto de afiliado só nos planos novos', () => {
    expect(affiliateMaxPercentForPlan('creator', OFF)).toBeNull();
    expect(affiliateMaxPercentForPlan('pro-anual', OFF)).toBeNull();
  });

  it('ANNUAL_BONUS_PLANS vazia: todo anual como antes', () => {
    const env = { ANNUAL_FIRST_MONTH_BONUS_PERCENT: '50' };
    expect(computeAnnualFirstMonthBonusCredits({ billingInterval: 'year', creditsPerMonth: 30000, slug: 'studio-anual' }, env)).toBe(15000);
  });
});

describe('candy-vitrine · flags ligadas', () => {
  it('links só https, por moeda; código do postback → slug', () => {
    const env = {
      CANDY_CHECKOUT_USD: 'creator-entrada=https://checkout.x/pay/A?x=1,creator-trimestral=http://inseguro,pro-28d=',
      CANDY_CHECKOUT_BRL: 'creator-entrada=https://pay.cakto.com.br/b',
      CANDY_PLAN_CODES: 'PPLENTRADA=creator-entrada, ckOfer=creator-trimestral',
    };
    const usd = candyCheckoutUrls('USD', env);
    expect([...usd.entries()]).toEqual([['creator-entrada', 'https://checkout.x/pay/A?x=1']]);
    expect(candyCheckoutUrls('brl', env).get('creator-entrada')).toBe('https://pay.cakto.com.br/b');
    expect(candyPlanSlugForCodes(['nada', 'PPLENTRADA'], env)).toBe('creator-entrada');
    expect(candyPlanSlugForCodes(['CKOFER'], env)).toBe('creator-trimestral');
  });

  it('L03: 1º mês com FIRST_MONTH_CREDITS (nunca acima do cheio); só no plano *-entrada', () => {
    const env = { FIRST_MONTH_CREDITS: '8000' };
    expect(activationPlanCredits({ slug: 'creator-entrada', creditsPerMonth: 12000 }, env)).toBe(8000);
    expect(activationPlanCredits({ slug: 'creator', creditsPerMonth: 12000 }, env)).toBe(12000);
    expect(activationPlanCredits({ slug: 'creator-entrada', creditsPerMonth: 5000 }, env)).toBe(5000);
    expect(affiliateMaxPercentForPlan('creator-entrada', OFF)).toBe(25);
    expect(affiliateMaxPercentForPlan('creator-entrada', { CANDY_AFFILIATE_MAX_PCT: 'creator-entrada=20' })).toBe(20);
  });

  it('L08: ANNUAL_BONUS_PLANS limita o bônus aos slugs listados (Advanced/Studio fora)', () => {
    const env = { ANNUAL_FIRST_MONTH_BONUS_PERCENT: '50', ANNUAL_BONUS_PLANS: 'creator-anual, pro-anual' };
    expect(computeAnnualFirstMonthBonusCredits({ billingInterval: 'year', creditsPerMonth: 12000, slug: 'creator-anual' }, env)).toBe(6000);
    expect(computeAnnualFirstMonthBonusCredits({ billingInterval: 'year', creditsPerMonth: 30000, slug: 'pro-anual' }, env)).toBe(15000);
    expect(computeAnnualFirstMonthBonusCredits({ billingInterval: 'year', creditsPerMonth: 60000, slug: 'studio-anual' }, env)).toBe(0);
    expect(computeAnnualFirstMonthBonusCredits({ billingInterval: 'year', creditsPerMonth: 45000, slug: 'advanced-anual' }, env)).toBe(0);
  });

  it('L09: código do bump → nome do pacote', () => {
    expect(bumpPackageNameForCodes(['PPLBUMP'], { PERFECTPAY_PLAN_BUMP_CODES: 'pplbump=Plus' })).toBe('Plus');
  });

  it('L13: trimestral cobre 3 meses e conta como plano novo', () => {
    expect(billingPeriodMonths({ slug: 'creator-trimestral', billingInterval: 'quarter' })).toBe(3);
    expect(isCandyBillingPlan({ slug: 'creator-trimestral', billingInterval: 'quarter' })).toBe(true);
    expect(
      subscriptionBillingNote({ slug: 'creator-trimestral', billingInterval: 'quarter', creditsPerMonth: 12000 }, { firstMonthCredits: 12000, amountCents: 4490, currency: 'USD' }),
    ).toBe('Billed US$ 44.90 every 3 months. 12,000 credits land every month. Cancel anytime.');
  });

  it('L21: 28 dias avança 28 dias (13 cobranças/ano)', () => {
    const start = new Date('2026-12-01T00:00:00Z');
    const end = addBillingPeriod(new Date(start), { billingInterval: '28d' }, 1);
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(28);
    expect(billingPeriodMonths({ slug: 'creator-28d', billingInterval: '28d' })).toBe(1);
  });

  it('L03: e-mail escreve a renovação cheia', () => {
    expect(
      subscriptionBillingNote(
        { slug: 'creator-entrada', billingInterval: 'month', creditsPerMonth: 12000 },
        { firstMonthCredits: 8000, amountCents: 6990, currency: 'BRL', renewalPriceCents: 8990 },
      ),
    ).toBe('Your first month: 8,000 credits. From month 2 it renews at R$ 89,90/month with 12,000 credits a month. Cancel anytime before the renewal date.');
  });

  it('L28: balde estável por usuário; braço B tranca tudo menos o pacote de entrada', () => {
    expect(userBucket('user-1')).toBe(userBucket('user-1'));
    expect(inSubscribersOnlyArm('user-1', 0)).toBe(false);
    expect(inSubscribersOnlyArm('user-1', 100)).toBe(true);
    expect(resolvePacksSubscribersOnlyPct({ PACKS_SUBSCRIBERS_ONLY_PCT: '50' })).toBe(50);
    expect(resolvePacksSubscribersOnlyPct({ PACKS_SUBSCRIBERS_ONLY_PCT: '500' })).toBe(100);
    const locked = lockPackagesForNonSubscribers(
      [
        { name: 'Mini', checkoutUrl: 'https://a' },
        { name: 'Plus', checkoutUrl: 'https://b' },
      ],
      new Set(['mini']),
    );
    expect(locked).toEqual([
      { name: 'Mini', checkoutUrl: 'https://a' },
      { name: 'Plus', checkoutUrl: null, locked: true },
    ]);
  });
});

describe('PlansService.findCandyOfferPlans', () => {
  const creatorEntrada = {
    id: 'p-entrada', slug: 'creator-entrada', name: 'Creator', description: null, creditsPerMonth: 12000,
    maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: null, hasApiAccess: false,
    sortOrder: 4, billingInterval: 'month', basePlanSlug: 'creator', prices: [{ priceCents: 1490 }],
  };

  it('sem env: lista vazia e nenhuma consulta ao banco', async () => {
    const prisma = { plan: { findMany: jest.fn() } };
    const service = new PlansService(prisma as any, { get: jest.fn() } as any);
    await expect(service.findCandyOfferPlans('USD', OFF)).resolves.toEqual([]);
    expect(prisma.plan.findMany).not.toHaveBeenCalled();
  });

  it('com link: devolve o plano com o link da env; o de entrada só com FIRST_MONTH_CREDITS', async () => {
    const prisma = { plan: { findMany: jest.fn(async () => [creatorEntrada]) } };
    const service = new PlansService(prisma as any, { get: jest.fn() } as any);
    const env = { CANDY_CHECKOUT_USD: 'creator-entrada=https://checkout.x/A' };
    await expect(service.findCandyOfferPlans('USD', env)).resolves.toEqual([]);
    const offers = await service.findCandyOfferPlans('USD', { ...env, FIRST_MONTH_CREDITS: '8000' });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ slug: 'creator-entrada', priceCents: 1490, currency: 'USD', checkoutUrl: 'https://checkout.x/A', firstMonthCredits: 8000, basePlanSlug: 'creator' });
  });
});

describe('PaymentsService · ativação dos planos novos', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  function setup(plan: Record<string, unknown>) {
    const tx = {
      $executeRaw: jest.fn(async () => 1),
      payment: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })),
      },
      subscription: {
        findFirst: jest.fn(async () => null),
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

  const sale = { userId: 'user-1', planId: 'p', saleCode: 'perfectpay-PP1', subscriptionCode: 'PPSUB1', amountCents: 1490, currency: 'usd' };

  it('Creator mensal com FIRST_MONTH_CREDITS ligado: créditos cheios (só o *-entrada muda)', async () => {
    process.env.FIRST_MONTH_CREDITS = '8000';
    const { service, tx } = setup({ id: 'p', slug: 'creator', name: 'Creator', creditsPerMonth: 12000, billingInterval: 'month' });
    await service.activateOrRenewPerfectpaySubscription(sale);
    expect((tx.creditBalance.upsert.mock.calls as any[][])[0][0].create.planCreditsRemaining).toBe(12000);
  });

  it('creator-entrada com FIRST_MONTH_CREDITS=8000: 8.000 créditos na ativação', async () => {
    process.env.FIRST_MONTH_CREDITS = '8000';
    const { service, tx } = setup({ id: 'p', slug: 'creator-entrada', name: 'Creator', creditsPerMonth: 12000, billingInterval: 'month', basePlanSlug: 'creator' });
    await service.activateOrRenewPerfectpaySubscription(sale);
    const upsert = (tx.creditBalance.upsert.mock.calls as any[][])[0][0];
    expect(upsert.create.planCreditsRemaining).toBe(8000);
    expect(upsert.update.planCreditsRemaining).toBe(8000);
  });

  it('creator-28d: assinatura nasce com período de 28 dias', async () => {
    const { service, tx } = setup({ id: 'p', slug: 'creator-28d', name: 'Creator', creditsPerMonth: 12000, billingInterval: '28d', basePlanSlug: 'creator' });
    const before = Date.now();
    await service.activateOrRenewPerfectpaySubscription({ ...sale, amountCents: 1990 });
    const created = (tx.subscription.create.mock.calls as any[][])[0][0].data;
    const days = (created.currentPeriodEnd.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(27.9);
    expect(days).toBeLessThan(28.1);
  });
});

describe('Perfect Pay · bump de créditos no checkout do plano (L09)', () => {
  const ORIGINAL = process.env.PERFECTPAY_PLAN_BUMP_CODES;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PERFECTPAY_PLAN_BUMP_CODES;
    else process.env.PERFECTPAY_PLAN_BUMP_CODES = ORIGINAL;
  });

  function perfectpay() {
    const paymentsService = {
      activateOrRenewPerfectpaySubscription: jest.fn(async () => ({ processed: true })),
      processCreditPurchase: jest.fn(async () => undefined),
    };
    const pendingGrantsService = { createPending: jest.fn(async () => ({ created: true })) };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 'user-1', referredByCode: null })) },
      plan: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      creditPackage: {
        findFirst: jest.fn(async ({ where }: any) => (where?.name ? { id: 'pkg-plus', name: 'Plus', credits: 5000 } : null)),
      },
    };
    const config = { get: jest.fn((key: string) => (key === 'PERFECTPAY_WEBHOOK_TOKEN' ? 'tok' : undefined)) };
    const service = new PerfectpayWebhookService(
      config as any,
      pendingGrantsService as any,
      { create: jest.fn(async () => ({})) } as any,
      { sendPendingGrantsEmail: jest.fn(async () => undefined), sendPendingGrantsEmailEs: jest.fn(async () => undefined) } as any,
      prisma as any,
      paymentsService as any,
      { findSaleTarget: jest.fn(async () => null) } as any,
    );
    return { service, paymentsService, pendingGrantsService };
  }

  const bumpSale = {
    token: 'tok',
    code: 'PPSALE1',
    sale_amount: 11.9,
    sale_status_enum: 2,
    sale_status_enum_key: 'approved',
    sale_status_detail: 'approved',
    customer: { email: 'buyer@mail.com' },
    plan: { code: 'PPLBUMP', name: 'Plus bump' },
  };

  it('env vazia: o código do bump segue o caminho de hoje (isca), sem crédito de pacote', async () => {
    delete process.env.PERFECTPAY_PLAN_BUMP_CODES;
    const { service, paymentsService, pendingGrantsService } = perfectpay();
    await service.handle(bumpSale);
    expect(paymentsService.processCreditPurchase).not.toHaveBeenCalled();
    expect(pendingGrantsService.createPending).toHaveBeenCalled();
  });

  it('env ligada: credita o Plus com id próprio "<venda>-bump" (não colide com o plano)', async () => {
    process.env.PERFECTPAY_PLAN_BUMP_CODES = 'PPLBUMP=Plus';
    const { service, paymentsService, pendingGrantsService } = perfectpay();
    const result = await service.handle(bumpSale);
    expect(result.processed).toBe(true);
    expect(paymentsService.processCreditPurchase).toHaveBeenCalledWith(
      'user-1',
      'pkg-plus',
      expect.any(Number),
      'perfectpay-PPSALE1-bump',
      expect.anything(),
      undefined,
      'perfectpay',
    );
    expect(pendingGrantsService.createPending).not.toHaveBeenCalled();
  });
});
