import {
  buildBuyersReport,
  countryFromPhone,
  durationStats,
  histogram,
  resolveCountry,
  saleRefOf,
  type BuyerGrantRow,
  type BuyerPaymentRow,
  type BuyerUserRow,
} from '../buyers-report';

const NOW = new Date('2026-10-23T15:00:00Z');
const H = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);

function user(id: string, extra: Partial<BuyerUserRow> = {}): BuyerUserRow {
  return {
    id,
    email: `${id}@x.com`,
    country: null,
    locale: 'pt-BR',
    phone: null,
    utmSource: null,
    utmCampaign: null,
    createdAt: ago(24 * 10),
    ...extra,
  };
}

let seq = 0;
function pay(
  userId: string,
  at: Date,
  extra: Partial<BuyerPaymentRow> = {},
): BuyerPaymentRow {
  seq += 1;
  return {
    id: `p${seq}`,
    userId,
    type: 'SUBSCRIPTION',
    amountCents: 1990,
    currency: 'USD',
    createdAt: at,
    planSlug: 'creator',
    planName: 'Creator',
    billingInterval: 'month',
    packageName: null,
    packageCredits: null,
    ...extra,
  };
}

function grant(
  email: string,
  at: Date,
  extra: Partial<BuyerGrantRow> = {},
): BuyerGrantRow {
  return {
    email,
    source: 'perfectpay',
    externalEventId: null,
    consumedByUserId: null,
    consumedAt: null,
    createdAt: at,
    ...extra,
  };
}

describe('país do comprador', () => {
  it('usa o país do IP do cadastro e cai para o DDI só com "+"', () => {
    expect(resolveCountry({ country: 'mx', phone: '+5511999999999' })).toEqual({
      country: 'MX',
      source: 'ip',
    });
    expect(resolveCountry({ country: null, phone: '+34 612 345 678' })).toEqual(
      { country: 'ES', source: 'phone' },
    );
    expect(resolveCountry({ country: 'XX', phone: '11999999999' })).toEqual({
      country: null,
      source: 'unknown',
    });
    expect(countryFromPhone('+1 809 555 1234')).toBe('DO');
    expect(countryFromPhone('+1 305 555 1234')).toBe('US');
    expect(countryFromPhone('+351 912 345 678')).toBe('PT');
  });
});

describe('código da venda', () => {
  it('tira o prefixo e o status do evento da Perfect Pay', () => {
    expect(saleRefOf('perfectpay-sale-PPCPMTB58C2SA-2')).toBe('PPCPMTB58C2SA');
    expect(saleRefOf('hubla-evt-1')).toBe('hubla-evt-1');
    expect(saleRefOf(null)).toBeNull();
  });
});

describe('tempos', () => {
  it('mediana, quartis e faixas', () => {
    const stats = durationStats([1, 2, 3, 4, 100]);
    expect(stats).toMatchObject({
      count: 5,
      medianHours: 3,
      p25Hours: 2,
      p75Hours: 4,
    });
    expect(durationStats([])).toBeNull();
    const buckets = histogram([0.5, 5, 30, 100, 200, 400, 2000]);
    expect(buckets.map((b) => b.count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe('buildBuyersReport', () => {
  it('separa cliente novo de recompra, mede a isca e agrega por país, plano e campanha', () => {
    const ana = user('ana', {
      country: 'MX',
      utmCampaign: 'GG ESP|123',
      utmSource: 'fb',
      createdAt: ago(24 * 5),
    });
    const bia = user('bia', {
      country: 'BR',
      utmCampaign: 'GG ESP|123',
      utmSource: 'fb',
      createdAt: ago(24 * 3),
    });
    const caio = user('caio', { country: 'US', createdAt: ago(24 * 200) }); // cliente antigo que renovou
    const davi = user('davi', {
      country: null,
      phone: '+5491112345678',
      createdAt: ago(24 * 2),
    }); // comprou isca, não pagou
    const eva = user('eva', { country: 'CO', createdAt: ago(24 * 80) }); // já era cliente antes da isca

    const anaFirst = pay('ana', ago(24 * 4)); // isca em -5d → compra em -4d = 24 h
    const anaRepeat = pay('ana', ago(24 * 1), {
      type: 'CREDIT_PURCHASE',
      planSlug: null,
      planName: null,
      billingInterval: null,
      packageName: 'Pack 500',
      packageCredits: 500,
      amountCents: 900,
    });
    const biaFirst = pay('bia', ago(24 * 2), {
      type: 'CREDIT_PURCHASE',
      planSlug: null,
      planName: null,
      billingInterval: null,
      packageName: 'Pack 500',
      packageCredits: 500,
      currency: 'BRL',
      amountCents: 4990,
    });
    const caioOld = pay('caio', ago(24 * 150));
    const caioRenew = pay('caio', ago(24 * 6));
    const evaOld = pay('eva', ago(24 * 70));

    const report = buildBuyersReport({
      days: 30,
      now: NOW,
      signups: [ana, bia, davi],
      windowPayments: [anaFirst, anaRepeat, biaFirst, caioRenew],
      users: [ana, bia, caio, davi, eva],
      allPaymentsOfKnownUsers: [
        anaFirst,
        anaRepeat,
        biaFirst,
        caioOld,
        caioRenew,
        evaOld,
      ],
      windowGrants: [
        grant('ana@x.com', ago(24 * 5), {
          consumedByUserId: 'ana',
          consumedAt: ago(24 * 5 - 2),
          externalEventId: 'perfectpay-sale-PPCPMTA01-2',
        }),
        grant('ANA@x.com', ago(24 * 5 - 1), {
          externalEventId: 'perfectpay-sale-PPCPMTA02-2',
        }), // bump do mesmo e-mail: conta 1 compradora
        grant('davi@x.com', ago(24 * 2), {
          externalEventId: 'perfectpay-sale-PPCPMTD01-2',
        }),
        grant('eva@x.com', ago(24 * 10), {
          consumedByUserId: 'eva',
          source: 'hubla',
        }),
        grant('fantasma@x.com', ago(24 * 1)), // comprou a isca e nunca se cadastrou
      ],
      grantsOfNewBuyers: [
        grant('ana@x.com', ago(24 * 5), { consumedByUserId: 'ana' }),
      ],
    });

    expect(report.totals.newBuyers).toBe(2); // ana e bia
    expect(report.totals.payments).toBe(4);
    expect(report.totals.repeatPayments).toBe(2); // pack da ana + renovação do caio
    expect(report.totals.newBuyersFromIsca).toBe(1);
    expect(report.totals.firstPurchase).toEqual({
      subscription: 1,
      credits: 1,
    });
    expect(report.totals.revenue).toEqual({
      usdCents: 1990 + 900 + 1990,
      brlCents: 4990,
    });

    const mx = report.countries.find((c) => c.country === 'MX')!;
    expect(mx).toMatchObject({ newBuyers: 1, payments: 2, signups: 1 });
    expect(report.countries.find((c) => c.country === 'AR')?.signups).toBe(1); // davi pelo DDI
    expect(report.countryCoverage).toEqual({ ip: 2, phone: 0, unknown: 0 });

    const creator = report.plans.find((p) => p.key === 'creator')!;
    expect(creator).toMatchObject({
      firstPurchases: 1,
      payments: 2,
      repeatPayments: 1,
    });
    const pack = report.plans.find((p) => p.key === 'pack:Pack 500')!;
    expect(pack).toMatchObject({
      kind: 'credits',
      firstPurchases: 1,
      payments: 2,
      credits: 500,
    });

    expect(report.isca.buyers).toBe(4); // ana, davi, eva, fantasma
    expect(report.isca.signedUp).toBe(3);
    expect(report.isca.alreadyCustomer).toBe(1); // eva
    expect(report.isca.paidAfter).toBe(1);
    expect(report.isca.paidSubscription).toBe(1);
    expect(report.isca.conversionPct).toBe(33.3); // 1 de 3 (fora quem já era cliente)
    expect(report.isca.hoursToPurchase?.medianHours).toBe(24);
    expect(report.isca.hoursToSignup).toMatchObject({
      count: 2,
      medianHours: 1,
    }); // ana 2 h, davi na hora; eva já tinha conta
    expect(report.isca.histogram.find((b) => b.key === 'lt3d')?.count).toBe(1);
    expect(report.isca.bySource).toEqual(
      expect.arrayContaining([
        { source: 'perfectpay', buyers: 3, paid: 1 },
        { source: 'hubla', buyers: 1, paid: 0 },
      ]),
    );
    expect(report.isca.firstPlans[0]).toMatchObject({
      key: 'creator',
      count: 1,
    });

    const gg = report.campaigns.find((c) => c.campaign === 'GG ESP|123')!;
    expect(gg).toMatchObject({
      signups: 2,
      newBuyers: 2,
      fromIsca: 1,
      payments: 3,
      source: 'fb',
    });
    expect(report.signupToPurchase.stats?.count).toBe(2);

    // venda da isca por código (para o cockpit casar com a campanha da Perfect Pay)
    const anaSale = report.isca.sales.find((x) =>
      x.refs.includes('PPCPMTA01'),
    )!;
    expect(anaSale.refs.sort()).toEqual(['PPCPMTA01', 'PPCPMTA02']);
    expect(anaSale).toMatchObject({
      paid: true,
      hoursToPurchase: 24,
      firstKind: 'subscription',
      firstPlan: 'Creator',
    });
    expect(
      report.isca.sales.find((x) => x.refs.includes('PPCPMTD01')),
    ).toMatchObject({ signedUp: true, paid: false });
    expect(report.isca.sales).toHaveLength(2); // grant sem código não entra na lista

    // nenhum dado pessoal sai no relatório
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/@x\.com|"(ana|bia|caio|davi|eva)"|5491112345678/);
  });

  it('janela vazia não quebra', () => {
    const report = buildBuyersReport({
      days: 7,
      now: NOW,
      signups: [],
      windowPayments: [],
      users: [],
      allPaymentsOfKnownUsers: [],
      windowGrants: [],
      grantsOfNewBuyers: [],
    });
    expect(report.totals.newBuyers).toBe(0);
    expect(report.isca.conversionPct).toBeNull();
    expect(report.isca.hoursToPurchase).toBeNull();
    expect(report.daily.length).toBeGreaterThanOrEqual(7);
  });
});
