import { AffiliatesService } from '../affiliates.service';
import {
  formatAffiliatePayoutAmount,
  resolveEarningCurrency,
  summarizeByCurrency,
} from '../affiliate-currency';
import { maskEmail } from '../mask-email';

const DAY_MS = 86_400_000;

interface EarningRow {
  id: string;
  affiliateId: string;
  userId: string;
  amountCents: number;
  commissionCents: number;
  currency: string | null;
  status: 'PENDING' | 'PAID';
  createdAt: Date;
  paidAt: Date | null;
  payment: { currency: string; type: string; amountCents: number };
  user: { name: string; email: string };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function earning(overrides: Partial<EarningRow> & { id: string }): EarningRow {
  return {
    affiliateId: 'aff-1',
    userId: 'user-a',
    amountCents: 1000,
    commissionCents: 300,
    currency: 'USD',
    status: 'PENDING',
    createdAt: daysAgo(5),
    paidAt: null,
    payment: { currency: 'USD', type: 'SUBSCRIPTION', amountCents: 1200 },
    user: { name: 'Joana', email: 'joana@gmail.com' },
    ...overrides,
  };
}

/** Prisma falso: guarda as comissões em memória e responde aos filtros que o serviço usa. */
function fakePrisma(rows: EarningRow[], affiliates: Array<Record<string, unknown>>) {
  const matches = (row: EarningRow, where: any = {}): boolean => {
    if (typeof where.affiliateId === 'string' && row.affiliateId !== where.affiliateId) return false;
    if (where.affiliateId?.in && !where.affiliateId.in.includes(row.affiliateId)) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.currency === null && row.currency !== null) return false;
    if (where.currency && 'not' in where.currency && row.currency === null) return false;
    if (where.createdAt?.lte && row.createdAt.getTime() > where.createdAt.lte.getTime()) return false;
    if (where.createdAt?.gt && row.createdAt.getTime() <= where.createdAt.gt.getTime()) return false;
    return true;
  };
  const sum = (list: EarningRow[], field: 'amountCents' | 'commissionCents') =>
    list.reduce((total, row) => total + row[field], 0);

  const prisma = {
    affiliate: {
      findFirst: jest.fn(async ({ where }: any) => affiliates.find((a) => a.userId === where.userId) ?? null),
      findUnique: jest.fn(async ({ where }: any) => affiliates.find((a) => a.id === where.id) ?? null),
      findMany: jest.fn(async () => affiliates.map((a) => ({ ...a, _count: { earnings: 0 }, user: null }))),
      count: jest.fn(async () => affiliates.length),
    },
    affiliateEarning: {
      aggregate: jest.fn(async ({ where }: any = {}) => {
        const list = rows.filter((row) => matches(row, where));
        return {
          _sum: { amountCents: sum(list, 'amountCents'), commissionCents: sum(list, 'commissionCents') },
          _count: list.length,
        };
      }),
      groupBy: jest.fn(async ({ by, where }: any) => {
        const groups = new Map<string, any>();
        for (const row of rows.filter((candidate) => matches(candidate, where))) {
          const key = by.map((field: keyof EarningRow) => String(row[field])).join('|');
          const group =
            groups.get(key) ??
            Object.fromEntries([
              ...by.map((field: keyof EarningRow) => [field, row[field]]),
              ['_sum', { amountCents: 0, commissionCents: 0 }],
            ]);
          group._sum.amountCents += row.amountCents;
          group._sum.commissionCents += row.commissionCents;
          groups.set(key, group);
        }
        return Array.from(groups.values());
      }),
      findMany: jest.fn(async ({ where }: any = {}) => rows.filter((row) => matches(row, where))),
      updateMany: jest.fn(async ({ where }: any) => ({ count: rows.filter((row) => matches(row, where)).length })),
    },
    user: {
      count: jest.fn(async () => 7),
      groupBy: jest.fn(async () => []),
    },
  };
  return prisma;
}

describe('maskEmail', () => {
  it('2 primeiras letras + *** + domínio', () => {
    expect(maskEmail('joana@gmail.com')).toBe('jo***@gmail.com');
    expect(maskEmail('  Maria.Silva@Empresa.com.br ')).toBe('Ma***@Empresa.com.br');
  });

  it('parte local curta não inventa letra', () => {
    expect(maskEmail('a@x.io')).toBe('a***@x.io');
  });

  it.each([undefined, null, '', 'sem-arroba', '@dominio.com', 'nome@'])('texto que não é e-mail (%p) vira ***', (value) => {
    expect(maskEmail(value as string | undefined)).toBe('***');
  });
});

describe('resolveEarningCurrency', () => {
  it('moeda da comissão vale primeiro, em maiúsculas', () => {
    expect(resolveEarningCurrency('usd', 'BRL')).toBe('USD');
  });

  it('comissão antiga (sem moeda) usa a do pagamento; sem as duas, real', () => {
    expect(resolveEarningCurrency(null, 'usd')).toBe('USD');
    expect(resolveEarningCurrency(null, null)).toBe('BRL');
    expect(resolveEarningCurrency(undefined, undefined)).toBe('BRL');
    expect(resolveEarningCurrency('  ', '')).toBe('BRL');
  });
});

describe('summarizeByCurrency', () => {
  it('separa por moeda, com pendente disponível × em maturação e pago', () => {
    const totals = summarizeByCurrency([
      { currency: 'USD', status: 'PENDING', matured: true, amountCents: 1000, commissionCents: 300 },
      { currency: 'usd', status: 'PENDING', matured: false, amountCents: 2000, commissionCents: 600 },
      { currency: 'USD', status: 'PAID', matured: true, amountCents: 500, commissionCents: 150 },
      { currency: 'BRL', status: 'PENDING', matured: false, amountCents: 9000, commissionCents: 90 },
      { currency: null, paymentCurrency: 'BRL', status: 'PAID', matured: true, amountCents: 100, commissionCents: 10 },
      { currency: null, paymentCurrency: null, status: 'PENDING', matured: true, amountCents: 50, commissionCents: 5 },
    ]);

    expect(totals).toEqual([
      {
        currency: 'USD',
        totalRevenueCents: 3500,
        totalCommissionCents: 1050,
        pendingCommissionCents: 900,
        availableCommissionCents: 300,
        maturingCommissionCents: 600,
        paidCommissionCents: 150,
      },
      {
        currency: 'BRL',
        totalRevenueCents: 9150,
        totalCommissionCents: 105,
        pendingCommissionCents: 95,
        availableCommissionCents: 5,
        maturingCommissionCents: 90,
        paidCommissionCents: 10,
      },
    ]);
  });

  it('sem comissão, lista vazia', () => {
    expect(summarizeByCurrency([])).toEqual([]);
  });
});

describe('formatAffiliatePayoutAmount', () => {
  const normalize = (text: string) => text.replace(/\s/g, ' ');

  it('sem moeda sai em real, como o e-mail sempre saiu', () => {
    expect(normalize(formatAffiliatePayoutAmount(123456))).toBe('R$ 1.234,56');
    expect(normalize(formatAffiliatePayoutAmount(123456, 'brl'))).toBe('R$ 1.234,56');
  });

  it('dólar não é confundido com real', () => {
    expect(normalize(formatAffiliatePayoutAmount(2990, 'USD'))).toBe('US$ 29,90');
  });

  it('código que o Intl recusa aparece cru, nunca como real', () => {
    expect(normalize(formatAffiliatePayoutAmount(2990, 'dolar'))).toBe('DOLAR 29,90');
  });
});

describe('AffiliatesService · totais por moeda', () => {
  const affiliate = {
    id: 'aff-1',
    userId: 'owner-1',
    code: 'PARCEIRA',
    name: 'Parceira',
    commissionPercent: 30,
    isActive: true,
    discountPercent: null,
    discountAppliesTo: 'FIRST_PURCHASE',
    pixKey: null,
    pixKeyType: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };

  const rows: EarningRow[] = [
    // Dólar: disponível (passou dos 30 dias), em maturação e pago.
    earning({ id: 'e1', currency: 'USD', createdAt: daysAgo(45), commissionCents: 300, amountCents: 1000 }),
    earning({ id: 'e2', currency: 'USD', createdAt: daysAgo(3), commissionCents: 600, amountCents: 2000, userId: 'user-b' }),
    earning({ id: 'e3', currency: 'USD', status: 'PAID', createdAt: daysAgo(90), paidAt: daysAgo(50), commissionCents: 150, amountCents: 500 }),
    // Real, gravado na comissão.
    earning({
      id: 'e4',
      currency: 'BRL',
      createdAt: daysAgo(2),
      commissionCents: 90,
      amountCents: 9000,
      userId: 'user-c',
      payment: { currency: 'BRL', type: 'CREDIT_PURCHASE', amountCents: 9900 },
    }),
    // Comissão antiga, sem moeda: vale a do pagamento (dólar).
    earning({ id: 'e5', currency: null, createdAt: daysAgo(60), commissionCents: 40, amountCents: 400 }),
    // De outro afiliado: não pode vazar.
    earning({ id: 'e6', affiliateId: 'aff-2', currency: 'USD', commissionCents: 7777, amountCents: 7777, userId: 'user-z' }),
  ];

  function setup() {
    const prisma = fakePrisma(rows, [affiliate, { ...affiliate, id: 'aff-2', userId: 'owner-2', code: 'OUTRA' }]);
    const emailService = { sendAffiliatePaymentEmail: jest.fn(async () => undefined) };
    const service = new AffiliatesService(prisma as never, {} as never, emailService as never);
    return { service, prisma, emailService };
  }

  it('getMyAffiliate: campos antigos somam tudo; byCurrency separa; payingUsers conta clientes distintos', async () => {
    const { service } = setup();

    const result = await service.getMyAffiliate('owner-1');

    expect(result?.summary).toMatchObject({
      referredUsers: 7,
      payingUsers: 3,
      totalPayments: 5,
      totalRevenueCents: 12900,
      totalCommissionCents: 1180,
      pendingCommissionCents: 1030,
      availableCommissionCents: 340,
      maturingCommissionCents: 690,
      paidCommissionCents: 150,
      maturationDays: 30,
    });
    expect(result?.summary.byCurrency).toEqual([
      {
        currency: 'USD',
        totalRevenueCents: 3900,
        totalCommissionCents: 1090,
        pendingCommissionCents: 940,
        availableCommissionCents: 340,
        maturingCommissionCents: 600,
        paidCommissionCents: 150,
      },
      {
        currency: 'BRL',
        totalRevenueCents: 9000,
        totalCommissionCents: 90,
        pendingCommissionCents: 90,
        availableCommissionCents: 0,
        maturingCommissionCents: 90,
        paidCommissionCents: 0,
      },
    ]);
  });

  it('getMyAffiliate: cada comissão traz a moeda e o e-mail do cliente mascarado', async () => {
    const { service } = setup();

    const result = await service.getMyAffiliate('owner-1');

    expect(result?.earnings).toHaveLength(5);
    for (const item of result?.earnings ?? []) {
      expect(item.user.email).toBe('jo***@gmail.com');
      expect(item.user.name).toBe('Joana');
    }
    const currencyById = Object.fromEntries((result?.earnings ?? []).map((item) => [item.id, item.currency]));
    expect(currencyById).toEqual({ e1: 'USD', e2: 'USD', e3: 'USD', e4: 'BRL', e5: 'USD' });
  });

  it('getMyAffiliate: quem não é afiliado recebe null', async () => {
    const { service } = setup();
    await expect(service.getMyAffiliate('ninguem')).resolves.toBeNull();
  });

  it('getEarnings (admin): summary antigo + byCurrency', async () => {
    const { service } = setup();

    const result = await service.getEarnings('aff-1');

    expect(result.summary).toMatchObject({
      totalRevenueCents: 12900,
      totalCommissionCents: 1180,
      pendingCommissionCents: 1030,
      paidCommissionCents: 150,
    });
    expect(result.summary.byCurrency.map((item) => [item.currency, item.totalCommissionCents])).toEqual([
      ['USD', 1090],
      ['BRL', 90],
    ]);
  });

  it('findAll (admin): byCurrency de cada afiliado, sem misturar', async () => {
    const { service } = setup();

    const list = await service.findAll();

    const byCode = Object.fromEntries(list.map((item) => [item.code, item.byCurrency]));
    expect(byCode.PARCEIRA.map((item) => [item.currency, item.totalCommissionCents])).toEqual([
      ['USD', 1090],
      ['BRL', 90],
    ]);
    expect(byCode.OUTRA.map((item) => [item.currency, item.totalCommissionCents])).toEqual([['USD', 7777]]);
  });

  it('getDashboard (admin): totais gerais + byCurrency', async () => {
    const { service } = setup();

    const dashboard = await service.getDashboard();

    expect(dashboard.totalCommissionCents).toBe(1180 + 7777);
    expect(dashboard.byCurrency.map((item) => [item.currency, item.totalCommissionCents])).toEqual([
      ['USD', 1090 + 7777],
      ['BRL', 90],
    ]);
  });

  it('markEarningsPaid: comissões de moedas diferentes viram um e-mail por moeda', async () => {
    const { service, prisma, emailService } = setup();
    const withAffiliate = (row: EarningRow) => ({
      ...row,
      affiliate: {
        id: row.affiliateId,
        name: 'Parceira',
        pixKey: null,
        pixKeyType: null,
        user: { email: 'parceira@exemplo.test', name: 'Parceira' },
      },
    });
    prisma.affiliateEarning.findMany.mockResolvedValueOnce(
      rows.filter((row) => ['e1', 'e2', 'e4', 'e5'].includes(row.id)).map(withAffiliate) as never,
    );

    const result = await service.markEarningsPaid({ earningIds: ['e1', 'e2', 'e4', 'e5'] });

    expect(result).toEqual({ updated: 4 });
    const sent = (emailService.sendAffiliatePaymentEmail.mock.calls as any[][]).map(([params]) => ({
      currency: params.currency,
      totalCents: params.totalCents,
      earningsCount: params.earningsCount,
    }));
    expect(sent).toEqual(
      expect.arrayContaining([
        { currency: 'USD', totalCents: 940, earningsCount: 3 },
        { currency: 'BRL', totalCents: 90, earningsCount: 1 },
      ]),
    );
    expect(sent).toHaveLength(2);
  });

  it('markEarningsPaid: uma moeda só continua sendo um e-mail só', async () => {
    const { service, prisma, emailService } = setup();
    prisma.affiliateEarning.findMany.mockResolvedValueOnce(
      rows
        .filter((row) => ['e1', 'e2'].includes(row.id))
        .map((row) => ({
          ...row,
          affiliate: { id: 'aff-1', name: 'Parceira', user: { email: 'parceira@exemplo.test', name: null } },
        })) as never,
    );

    await service.markEarningsPaid({ earningIds: ['e1', 'e2'] });

    expect(emailService.sendAffiliatePaymentEmail).toHaveBeenCalledTimes(1);
    expect((emailService.sendAffiliatePaymentEmail.mock.calls as any[][])[0][0]).toMatchObject({
      to: 'parceira@exemplo.test',
      name: 'Parceira',
      currency: 'USD',
      totalCents: 900,
      earningsCount: 2,
    });
  });
});
