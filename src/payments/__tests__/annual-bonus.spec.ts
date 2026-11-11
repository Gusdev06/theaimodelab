import { PaymentsService } from '../payments.service';
import {
  computeAnnualFirstMonthBonusCredits,
  resolveAnnualFirstMonthBonusPercent,
} from '../annual-bonus';

/**
 * Bônus do anual no 1º mês (env ANNUAL_FIRST_MONTH_BONUS_PERCENT, padrão 0 = desligado).
 */
describe('Bônus do plano anual (1º mês)', () => {
  const ORIGINAL = process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT;
    else process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT = ORIGINAL;
  });

  describe('cálculo puro', () => {
    const annual = { billingInterval: 'year', creditsPerMonth: 20000 };
    const monthly = { billingInterval: 'month', creditsPerMonth: 20000 };

    it('padrão (sem env), vazio, 0, negativo ou inválido: 0 = desligado', () => {
      for (const raw of [undefined, '', '0', '-10', 'abc']) {
        expect(resolveAnnualFirstMonthBonusPercent({ ANNUAL_FIRST_MONTH_BONUS_PERCENT: raw })).toBe(0);
        expect(computeAnnualFirstMonthBonusCredits(annual, { ANNUAL_FIRST_MONTH_BONUS_PERCENT: raw })).toBe(0);
      }
    });

    it('anual com percent > 0 arredonda creditsPerMonth * percent / 100', () => {
      expect(computeAnnualFirstMonthBonusCredits(annual, { ANNUAL_FIRST_MONTH_BONUS_PERCENT: '50' })).toBe(10000);
      expect(
        computeAnnualFirstMonthBonusCredits(
          { billingInterval: 'year', creditsPerMonth: 333 },
          { ANNUAL_FIRST_MONTH_BONUS_PERCENT: '10' },
        ),
      ).toBe(33);
    });

    it('mensal nunca ganha o bônus, mesmo com a env ligada', () => {
      expect(computeAnnualFirstMonthBonusCredits(monthly, { ANNUAL_FIRST_MONTH_BONUS_PERCENT: '100' })).toBe(0);
    });

    it('teto de 100% contra erro de digitação', () => {
      expect(resolveAnnualFirstMonthBonusPercent({ ANNUAL_FIRST_MONTH_BONUS_PERCENT: '1000' })).toBe(100);
    });
  });

  describe('ativação Perfect Pay', () => {
    const annualPlan = { id: 'plan-anual', slug: 'studio-anual', name: 'Studio Anual', creditsPerMonth: 20000, billingInterval: 'year' };
    const monthlyPlan = { id: 'plan-mensal', slug: 'studio', name: 'Studio', creditsPerMonth: 20000, billingInterval: 'month' };

    function setup(plan: typeof annualPlan, opts: { existingPayment?: boolean; existingBonus?: boolean; activeSub?: Record<string, unknown> | null } = {}) {
      const tx = {
        $executeRaw: jest.fn(async () => 1),
        payment: {
          findFirst: jest.fn(async () => (opts.existingPayment ? { id: 'pay-old' } : null)),
          create: jest.fn(async ({ data }: any) => ({ id: 'pay-1', ...data })),
        },
        subscription: {
          findFirst: jest.fn(async () => opts.activeSub ?? null),
          update: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
          updateMany: jest.fn(async () => ({ count: 0 })),
          create: jest.fn(async ({ data }: any) => ({ id: 'sub-1', ...data })),
        },
        creditBalance: {
          upsert: jest.fn(async () => ({})),
          update: jest.fn(async () => ({})),
        },
        creditTransaction: {
          findFirst: jest.fn(async () => (opts.existingBonus ? { id: 'ct-bonus' } : null)),
          create: jest.fn(async () => ({})),
        },
        affiliate: { findUnique: jest.fn(async () => null) },
        affiliateEarning: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
      };
      const prisma = {
        plan: { findUnique: jest.fn(async () => plan) },
        user: { findUnique: jest.fn(async () => null) },
        $transaction: jest.fn(async (fn: any) => fn(tx)),
      };
      const service = new PaymentsService(prisma as any, {} as any, {} as any, {} as any, {} as any);
      const bonusCalls = () =>
        (tx.creditTransaction.create.mock.calls as any[][]).filter(([arg]) => arg.data.metadata?.kind === 'annual_first_month');
      return { service, tx, bonusCalls };
    }

    const sale = {
      userId: 'user-1',
      planId: 'plan-anual',
      saleCode: 'PPCPMTB111',
      subscriptionCode: 'PPSUB1',
      amountCents: 29700,
      currency: 'usd',
    };

    it('com percent > 0 em plano anual: credita o bônus uma vez, na ativação', async () => {
      process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT = '50';
      const { service, tx, bonusCalls } = setup(annualPlan);

      await service.activateOrRenewPerfectpaySubscription(sale);

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: { bonusCreditsRemaining: { increment: 10000 } },
      });
      expect(bonusCalls()).toHaveLength(1);
      expect(bonusCalls()[0][0].data).toMatchObject({
        userId: 'user-1',
        type: 'ONBOARDING_BONUS',
        amount: 10000,
        source: 'bonus',
        description: 'Bônus do plano anual (1º mês)',
        paymentId: 'pay-1',
        metadata: { kind: 'annual_first_month', subscriptionId: 'sub-1' },
      });
    });

    it('plano mensal: não credita bônus mesmo com a env ligada', async () => {
      process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT = '100';
      const { service, tx, bonusCalls } = setup(monthlyPlan as typeof annualPlan);

      await service.activateOrRenewPerfectpaySubscription({ ...sale, planId: 'plan-mensal' });

      expect(tx.creditBalance.update).not.toHaveBeenCalled();
      expect(bonusCalls()).toHaveLength(0);
    });

    it('padrão desligado (sem env ou 0): nada é creditado', async () => {
      for (const raw of [undefined, '0']) {
        if (raw === undefined) delete process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT;
        else process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT = raw;
        const { service, tx, bonusCalls } = setup(annualPlan);

        await service.activateOrRenewPerfectpaySubscription(sale);

        expect(tx.creditBalance.update).not.toHaveBeenCalled();
        expect(bonusCalls()).toHaveLength(0);
      }
    });

    it('retry do webhook (venda já processada): não credita 2x', async () => {
      process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT = '50';
      const { service, tx, bonusCalls } = setup(annualPlan, { existingPayment: true });

      const result = await service.activateOrRenewPerfectpaySubscription(sale);

      expect(result).toEqual({ processed: false, reason: 'duplicate sale' });
      expect(tx.creditBalance.update).not.toHaveBeenCalled();
      expect(bonusCalls()).toHaveLength(0);
    });

    it('bônus já gravado para a assinatura: não credita de novo', async () => {
      process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT = '50';
      const { service, tx, bonusCalls } = setup(annualPlan, { existingBonus: true });

      await service.activateOrRenewPerfectpaySubscription(sale);

      expect(tx.creditBalance.update).not.toHaveBeenCalled();
      expect(bonusCalls()).toHaveLength(0);
    });

    it('renovação da mesma assinatura (cobrança seguinte): não credita bônus', async () => {
      process.env.ANNUAL_FIRST_MONTH_BONUS_PERCENT = '50';
      const { service, tx, bonusCalls } = setup(annualPlan, {
        activeSub: {
          id: 'sub-1',
          planId: 'plan-anual',
          externalSubscriptionId: 'PPSUB1',
          currentPeriodEnd: new Date('2027-11-10'),
        },
      });

      await service.activateOrRenewPerfectpaySubscription({ ...sale, saleCode: 'PPCPMTB222' });

      expect(tx.creditBalance.update).not.toHaveBeenCalled();
      expect(bonusCalls()).toHaveLength(0);
    });
  });
});
