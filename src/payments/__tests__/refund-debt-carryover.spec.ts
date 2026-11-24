import { PaymentsService } from '../payments.service';
import {
  REFUND_DEBT_ENV,
  REFUND_DEBT_KIND,
  REFUND_DEBT_SETTLEMENT_KIND,
  computeOutstandingRefundDebt,
  isRefundDebtCarryoverEnabled,
} from '../refund-debt';

/**
 * TKT-363 · reembolso depois do uso. Com REFUND_DEBT_CARRYOVER ligada, o que o
 * estorno não recupera vira dívida no extrato e é descontado da próxima concessão
 * paga. Desligada, tudo segue idêntico ao de antes.
 *
 * Banco em memória (só o que o PaymentsService usa nestes caminhos), para seguir o
 * fluxo de ponta a ponta: compra → gasto → estorno → nova compra.
 */

type Row = Record<string, any>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR')
      return (condition as Row[]).some((sub) => matches(row, sub));
    if (
      condition &&
      typeof condition === 'object' &&
      !(condition instanceof Date)
    ) {
      if ('path' in condition) {
        const value = (row[key] ?? {})[condition.path[0]];
        return value === condition.equals;
      }
      if ('gt' in condition) return row[key] > condition.gt;
      if ('in' in condition) return condition.in.includes(row[key]);
    }
    return row[key] === condition;
  });
}

function createStore(opts: { packages?: Row[]; plans?: Row[] } = {}) {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;
  const clock = { now: 1_700_000_000_000 };
  const db = {
    payments: [] as Row[],
    transactions: [] as Row[],
    balances: new Map<string, Row>(),
    subscriptions: [] as Row[],
    packages: opts.packages ?? [],
    plans: opts.plans ?? [],
    locks: [] as string[],
  };

  const tx = {
    $executeRaw: jest.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        db.locks.push(String(values[0]));
        return 1;
      },
    ),
    payment: {
      findFirst: jest.fn(async ({ where, include }: Row) => {
        const found = db.payments.find((p) => matches(p, where));
        if (!found) return null;
        if (include?.creditPackage) {
          const pkg = db.packages.find((p) => p.id === found.creditPackageId);
          return {
            ...found,
            creditPackage: pkg
              ? { name: pkg.name, credits: pkg.credits }
              : null,
          };
        }
        return { ...found };
      }),
      create: jest.fn(async ({ data }: Row) => {
        const row = {
          id: nextId('pay'),
          createdAt: new Date(clock.now++),
          subscriptionId: null,
          ...data,
        };
        db.payments.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        const row = db.payments.find((p) => p.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    },
    creditBalance: {
      findUnique: jest.fn(async ({ where }: Row) => {
        const row = db.balances.get(where.userId);
        return row ? { ...row } : null;
      }),
      upsert: jest.fn(async ({ where, create, update }: Row) => {
        const current = db.balances.get(where.userId);
        if (!current) {
          db.balances.set(where.userId, { ...create });
          return { ...create };
        }
        for (const [key, value] of Object.entries(update)) {
          if (
            value &&
            typeof value === 'object' &&
            'increment' in (value as Row)
          )
            current[key] += (value as Row).increment;
          else current[key] = value;
        }
        return { ...current };
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        const current = db.balances.get(where.userId)!;
        for (const [key, value] of Object.entries(data)) {
          const op = value as Row;
          if ('increment' in op) current[key] += op.increment;
          if ('decrement' in op) current[key] -= op.decrement;
        }
        return { ...current };
      }),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const current = db.balances.get(where.userId);
        if (!current) return { count: 0 };
        const guard = where.bonusCreditsRemaining?.gte;
        if (guard != null && current.bonusCreditsRemaining < guard)
          return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          const op = value as Row;
          if (op && typeof op === 'object' && 'decrement' in op)
            current[key] -= op.decrement;
          else current[key] = value;
        }
        return { count: 1 };
      }),
    },
    creditTransaction: {
      create: jest.fn(async ({ data }: Row) => {
        const row = {
          id: nextId('ctx'),
          createdAt: new Date(clock.now++),
          metadata: null,
          ...data,
        };
        db.transactions.push(row);
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where, orderBy }: Row) => {
        const rows = db.transactions.filter((t) => matches(t, where));
        if (orderBy?.createdAt === 'desc')
          rows.sort((a, b) => b.createdAt - a.createdAt);
        return rows[0] ? { ...rows[0] } : null;
      }),
      findMany: jest.fn(async ({ where }: Row) =>
        db.transactions.filter((t) => matches(t, where)).map((t) => ({ ...t })),
      ),
      aggregate: jest.fn(async ({ where }: Row) => ({
        _sum: {
          amount: db.transactions
            .filter((t) => matches(t, where))
            .reduce((sum, t) => sum + t.amount, 0),
        },
      })),
    },
    subscription: {
      findFirst: jest.fn(async ({ where }: Row) => {
        const rows = db.subscriptions.filter((s) => matches(s, where));
        return rows.length ? { ...rows[rows.length - 1] } : null;
      }),
      findUnique: jest.fn(async ({ where }: Row) => {
        const row = db.subscriptions.find((s) => s.id === where.id);
        return row ? { ...row } : null;
      }),
      create: jest.fn(async ({ data }: Row) => {
        const row = { id: nextId('sub'), ...data };
        db.subscriptions.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        const row = db.subscriptions.find((s) => s.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const rows = db.subscriptions.filter((s) => matches(s, where));
        rows.forEach((s) => Object.assign(s, data));
        return { count: rows.length };
      }),
    },
    plan: {
      findUnique: jest.fn(
        async ({ where }: Row) =>
          db.plans.find((p) => p.id === where.id) ?? null,
      ),
    },
    affiliate: { findUnique: jest.fn(async () => null) },
    affiliateEarning: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
    },
  };

  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(tx)),
    creditPackage: {
      findUnique: jest.fn(
        async ({ where }: Row) =>
          db.packages.find((p) => p.id === where.id) ?? null,
      ),
    },
    plan: {
      findUnique: jest.fn(
        async ({ where }: Row) =>
          db.plans.find((p) => p.id === where.id) ?? null,
      ),
    },
    user: { findUnique: jest.fn(async () => null) },
    subscription: tx.subscription,
  };
  const service = new PaymentsService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  jest
    .spyOn((service as any).logger, 'log')
    .mockImplementation(() => undefined);

  /** Simula gerações gastando do bônus (o débito real é do CreditsService). */
  const spendBonus = (userId: string, credits: number) => {
    db.balances.get(userId)!.bonusCreditsRemaining -= credits;
  };
  const spendPlan = (userId: string, credits: number) => {
    const balance = db.balances.get(userId)!;
    balance.planCreditsRemaining -= credits;
    balance.planCreditsUsed += credits;
  };
  const debtRows = () =>
    db.transactions.filter((t) => t.metadata?.kind === REFUND_DEBT_KIND);
  const settlementRows = () =>
    db.transactions.filter(
      (t) => t.metadata?.kind === REFUND_DEBT_SETTLEMENT_KIND,
    );

  return { service, db, tx, spendBonus, spendPlan, debtRows, settlementRows };
}

const MEGA = { id: 'pkg-mega', name: 'Mega', credits: 25000 };
const PACK = { id: 'pkg-pack', name: 'Pack', credits: 2000 };
const PRO = {
  id: 'plan-pro',
  slug: 'pro',
  name: 'Pro',
  creditsPerMonth: 30000,
  billingInterval: 'month',
};

describe('isRefundDebtCarryoverEnabled', () => {
  it('desligada quando vazia, ausente ou com valor estranho; ligada só com 1/true/on/yes', () => {
    expect(isRefundDebtCarryoverEnabled({})).toBe(false);
    expect(isRefundDebtCarryoverEnabled({ [REFUND_DEBT_ENV]: '' })).toBe(false);
    expect(isRefundDebtCarryoverEnabled({ [REFUND_DEBT_ENV]: 'off' })).toBe(
      false,
    );
    expect(isRefundDebtCarryoverEnabled({ [REFUND_DEBT_ENV]: '0' })).toBe(
      false,
    );
    expect(isRefundDebtCarryoverEnabled({ [REFUND_DEBT_ENV]: ' ON ' })).toBe(
      true,
    );
    expect(isRefundDebtCarryoverEnabled({ [REFUND_DEBT_ENV]: 'true' })).toBe(
      true,
    );
    expect(isRefundDebtCarryoverEnabled({ [REFUND_DEBT_ENV]: '1' })).toBe(true);
  });

  it('saldo devedor = dívidas − quitações, nunca negativo, ignora metadata de outro tipo', () => {
    expect(
      computeOutstandingRefundDebt([
        { metadata: { kind: REFUND_DEBT_KIND, debtCredits: 21000 } },
        {
          metadata: { kind: REFUND_DEBT_SETTLEMENT_KIND, settledCredits: 2000 },
        },
        { metadata: { kind: 'annual_first_month', debtCredits: 999 } },
        { metadata: null },
      ]),
    ).toBe(19000);
    expect(
      computeOutstandingRefundDebt([
        { metadata: { kind: REFUND_DEBT_SETTLEMENT_KIND, settledCredits: 5 } },
      ]),
    ).toBe(0);
  });
});

describe('TKT-363 · dívida de estorno (REFUND_DEBT_CARRYOVER)', () => {
  const original = process.env[REFUND_DEBT_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[REFUND_DEBT_ENV];
    else process.env[REFUND_DEBT_ENV] = original;
  });

  async function packRefundedAfterUse(store: ReturnType<typeof createStore>) {
    await store.service.processCreditPurchase(
      'user-1',
      MEGA.id,
      5490,
      'PPSALE1',
      'usd',
      undefined,
      'perfectpay',
    );
    store.spendBonus('user-1', 21000); // gastou 21 mil dos 25 mil
    return store.service.refundExternalPayment('PPSALE1', 'refund');
  }

  it('flag desligada: estorno e compra seguinte iguais ao de antes (sem dívida, sem desconto, sem lock novo)', async () => {
    delete process.env[REFUND_DEBT_ENV];
    const store = createStore({ packages: [MEGA, PACK] });

    const refund = await packRefundedAfterUse(store);
    expect(refund).toEqual({
      found: true,
      type: 'CREDIT_PURCHASE',
      creditsRevoked: 4000,
      creditsShortfall: 21000,
      earningsCanceled: 0,
    });
    expect(refund).not.toHaveProperty('debtRecorded');

    await store.service.processCreditPurchase(
      'user-1',
      PACK.id,
      1299,
      'PPSALE2',
      'usd',
      undefined,
      'perfectpay',
    );

    expect(store.db.balances.get('user-1')!.bonusCreditsRemaining).toBe(2000);
    expect(store.debtRows()).toHaveLength(0);
    expect(store.settlementRows()).toHaveLength(0);
    expect(store.tx.creditTransaction.findMany).not.toHaveBeenCalled();
    expect(store.db.locks.some((key) => key.startsWith('refund-debt:'))).toBe(
      false,
    );
  });

  it('estorno de pack com gasto: o não recuperado vira dívida no extrato (amount 0, saldo nunca negativo)', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ packages: [MEGA] });

    const refund = await packRefundedAfterUse(store);

    expect(refund).toMatchObject({
      creditsRevoked: 4000,
      creditsShortfall: 21000,
      debtRecorded: 21000,
    });
    expect(store.db.balances.get('user-1')!.bonusCreditsRemaining).toBe(0);
    const [debt] = store.debtRows();
    expect(store.debtRows()).toHaveLength(1);
    expect(debt).toMatchObject({
      userId: 'user-1',
      type: 'PURCHASE',
      amount: 0,
      source: 'bonus',
      metadata: expect.objectContaining({
        kind: REFUND_DEBT_KIND,
        debtCredits: 21000,
        externalPaymentId: 'PPSALE1',
      }),
    });
    expect(store.db.payments[0].status).toBe('REFUNDED');
  });

  it('estorno sem gasto (tudo recuperado): não registra dívida', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ packages: [MEGA] });
    await store.service.processCreditPurchase(
      'user-1',
      MEGA.id,
      5490,
      'PPSALE1',
      'usd',
      undefined,
      'perfectpay',
    );

    const refund = await store.service.refundExternalPayment(
      'PPSALE1',
      'refund',
    );

    expect(refund).toMatchObject({
      creditsRevoked: 25000,
      creditsShortfall: 0,
      debtRecorded: 0,
    });
    expect(store.debtRows()).toHaveLength(0);
  });

  it('próxima compra paga quita a dívida antes de creditar e registra a quitação; a seguinte quita o resto', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ packages: [MEGA, PACK] });
    await packRefundedAfterUse(store); // dívida 21.000

    await store.service.processCreditPurchase(
      'user-1',
      MEGA.id,
      5490,
      'PPSALE2',
      'usd',
      undefined,
      'perfectpay',
    );

    // 25.000 concedidos − 21.000 de dívida = 4.000 líquidos
    expect(store.db.balances.get('user-1')!.bonusCreditsRemaining).toBe(4000);
    expect(store.settlementRows()).toHaveLength(1);
    expect(store.settlementRows()[0]).toMatchObject({
      type: 'PURCHASE',
      amount: -21000,
      source: 'bonus',
      metadata: expect.objectContaining({
        settledCredits: 21000,
        outstandingBefore: 21000,
        outstandingAfter: 0,
      }),
    });

    // Dívida zerada: a compra seguinte entra inteira.
    await store.service.processCreditPurchase(
      'user-1',
      PACK.id,
      1299,
      'PPSALE3',
      'usd',
      undefined,
      'perfectpay',
    );
    expect(store.db.balances.get('user-1')!.bonusCreditsRemaining).toBe(6000);
    expect(store.settlementRows()).toHaveLength(1);
  });

  it('compra menor que a dívida: desconta só o que entrou agora, nunca o saldo antigo, e carrega o resto', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ packages: [MEGA, PACK] });
    await packRefundedAfterUse(store); // dívida 21.000
    store.db.balances.get('user-1')!.bonusCreditsRemaining = 500; // ganhou bônus grátis depois

    await store.service.processCreditPurchase(
      'user-1',
      PACK.id,
      1299,
      'PPSALE2',
      'usd',
      undefined,
      'perfectpay',
    );

    expect(store.db.balances.get('user-1')!.bonusCreditsRemaining).toBe(500);
    expect(store.settlementRows()[0].amount).toBe(-2000);
    expect(computeOutstandingRefundDebt(store.db.transactions)).toBe(19000);
  });

  it('webhook de estorno repetido não registra a dívida 2x', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ packages: [MEGA] });
    await packRefundedAfterUse(store);

    const second = await store.service.refundExternalPayment(
      'PPSALE1',
      'refund',
    );
    const third = await store.service.refundExternalPayment(
      'PPSALE1',
      'chargeback',
    );

    expect(second).toEqual({
      found: true,
      type: 'CREDIT_PURCHASE',
      alreadyRefunded: true,
    });
    expect(third).toEqual({
      found: true,
      type: 'CREDIT_PURCHASE',
      alreadyRefunded: true,
    });
    expect(store.debtRows()).toHaveLength(1);
    expect(computeOutstandingRefundDebt(store.db.transactions)).toBe(21000);
  });

  it('webhook da compra nova repetido não quita (nem credita) 2x', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ packages: [MEGA, PACK] });
    await packRefundedAfterUse(store);

    await store.service.processCreditPurchase(
      'user-1',
      PACK.id,
      1299,
      'PPSALE2',
      'usd',
      undefined,
      'perfectpay',
    );
    await store.service.processCreditPurchase(
      'user-1',
      PACK.id,
      1299,
      'PPSALE2',
      'usd',
      undefined,
      'perfectpay',
    );

    expect(store.settlementRows()).toHaveLength(1);
    expect(store.db.balances.get('user-1')!.bonusCreditsRemaining).toBe(0);
    expect(computeOutstandingRefundDebt(store.db.transactions)).toBe(19000);
  });

  it('assinatura estornada com gasto vira dívida (plano) e a renovação paga seguinte quita', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ plans: [PRO] });
    const sale = {
      userId: 'user-1',
      planId: PRO.id,
      amountCents: 4990,
      currency: 'usd',
    };

    await store.service.activateOrRenewPerfectpaySubscription({
      ...sale,
      saleCode: 'PPSUBSALE1',
      subscriptionCode: 'PPSUB1',
    });
    store.spendPlan('user-1', 12000);
    const refund = await store.service.refundExternalPayment(
      'PPSUBSALE1',
      'chargeback',
    );

    expect(refund).toMatchObject({
      type: 'SUBSCRIPTION',
      creditsShortfall: 12000,
      debtRecorded: 12000,
    });
    expect(store.debtRows()[0]).toMatchObject({ amount: 0, source: 'plan' });

    // O webhook revoga a assinatura (zera o que sobrou) e depois ela volta a assinar.
    await store.service.revokePerfectpaySubscription('user-1', {
      immediate: true,
      reason: 'chargeback',
    });
    expect(store.db.balances.get('user-1')!.planCreditsRemaining).toBe(0);
    await store.service.activateOrRenewPerfectpaySubscription({
      ...sale,
      saleCode: 'PPSUBSALE2',
      subscriptionCode: 'PPSUB2',
    });

    const balance = store.db.balances.get('user-1')!;
    expect(balance.planCreditsRemaining).toBe(30000 - 12000);
    expect(store.settlementRows()).toHaveLength(1);
    expect(store.settlementRows()[0]).toMatchObject({
      amount: -12000,
      source: 'plan',
    });
    expect(computeOutstandingRefundDebt(store.db.transactions)).toBe(0);
  });

  it('estorno de ciclo antigo de assinatura (já houve recarga depois) não vira dívida', async () => {
    process.env[REFUND_DEBT_ENV] = 'on';
    const store = createStore({ plans: [PRO] });
    const sale = {
      userId: 'user-1',
      planId: PRO.id,
      amountCents: 4990,
      currency: 'usd',
      subscriptionCode: 'PPSUB1',
    };
    await store.service.activateOrRenewPerfectpaySubscription({
      ...sale,
      saleCode: 'PPSUBSALE1',
    });
    await store.service.activateOrRenewPerfectpaySubscription({
      ...sale,
      saleCode: 'PPSUBSALE2',
    }); // renovação
    store.spendPlan('user-1', 30000);

    const refund = await store.service.refundExternalPayment(
      'PPSUBSALE1',
      'refund',
    );

    expect(refund).toMatchObject({ type: 'SUBSCRIPTION', debtRecorded: 0 });
    expect(store.debtRows()).toHaveLength(0);
  });
});
