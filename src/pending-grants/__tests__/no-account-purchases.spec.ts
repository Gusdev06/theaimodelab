import { PerfectpayWebhookService } from '../perfectpay-webhook.service';
import { CaktoWebhookService } from '../cakto-webhook.service';
import { NO_ACCOUNT_PROVIDER, NoAccountPurchasesService } from '../no-account-purchases.service';
import { NoAccountPurchasesClaimer } from '../no-account-purchases.claimer';

/**
 * B-01: plano/pacote pago antes de existir conta com o e-mail não se perde. Fica guardado em webhook_logs,
 * a compradora recebe 1 e-mail "crie sua conta" por venda e, no cadastro/login, a venda é reaplicada pelo
 * mesmo handler, com a idempotência do pagamento (código da venda) — rodar 2× nunca credita 2×.
 */
type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function setup() {
  const logs: Row[] = [];
  const users: Row[] = [];
  let seq = 0;
  const prisma = {
    webhookLog: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: `log-${++seq}`, processed: false, error: null, createdAt: new Date(Date.now() + seq), ...data };
        logs.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: { where: Row }) => logs.find((row) => matches(row, where)) ?? null),
      findMany: jest.fn(async ({ where }: { where: Row }) => logs.filter((row) => matches(row, where))),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = logs.find((r) => r.id === where.id);
        if (!row) throw new Error('log não existe');
        Object.assign(row, data);
        return row;
      }),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => users.find((u) => u.email === where.email) ?? null),
    },
    plan: { findFirst: jest.fn(async () => ({ id: 'plan-pro', slug: 'pro', name: 'Pro' })) },
    creditPackage: {
      findFirst: jest.fn(async () => ({ id: 'pkg-mega', name: 'Mega', credits: 25000 })),
    },
  };

  // Pagamentos com a idempotência real: o código da venda só entra uma vez.
  const paidSales = new Set<string>();
  const activations: string[] = [];
  const creditPurchases: string[] = [];
  const paymentsService = {
    activateOrRenewPerfectpaySubscription: jest.fn(async ({ saleCode }: { saleCode: string }) => {
      if (paidSales.has(saleCode)) return { processed: false, reason: 'duplicate sale' };
      paidSales.add(saleCode);
      activations.push(saleCode);
      return { processed: true };
    }),
    processCreditPurchase: jest.fn(async (_userId: string, _pkg: string, _amount: number, saleCode: string) => {
      if (paidSales.has(saleCode)) return;
      paidSales.add(saleCode);
      creditPurchases.push(saleCode);
    }),
  };

  const emailService = {
    sendPurchaseWithoutAccountEmail: jest.fn(async () => true),
    sendPendingGrantsEmail: jest.fn(async () => undefined),
  };
  const webhookLogs = {
    create: jest.fn(async (provider: string, eventType: string, externalId: string | null, payload: unknown) =>
      prisma.webhookLog.create({ data: { provider, eventType, externalId, payload } }),
    ),
  };
  const purchases = new NoAccountPurchasesService(prisma as any, emailService as any);
  const checkoutCodes = { findSaleTarget: jest.fn(async () => null) };

  const perfectpay = new PerfectpayWebhookService(
    { get: jest.fn((key: string) => (key === 'PERFECTPAY_WEBHOOK_TOKEN' ? 'tok' : undefined)) } as any,
    { createPending: jest.fn(async () => ({ created: true })) } as any,
    webhookLogs as any,
    emailService as any,
    prisma as any,
    paymentsService as any,
    checkoutCodes as any,
    purchases,
  );
  const cakto = new CaktoWebhookService(
    { get: jest.fn((key: string) => (key === 'CAKTO_WEBHOOK_SECRET' ? 'seg' : undefined)) } as any,
    webhookLogs as any,
    prisma as any,
    paymentsService as any,
    checkoutCodes as any,
    purchases,
  );
  const claimer = new NoAccountPurchasesClaimer(purchases, perfectpay, cakto);

  return { logs, users, prisma, perfectpay, cakto, claimer, emailService, paymentsService, activations, creditPurchases };
}

const planSale = (status: 'approved' | 'completed') => ({
  token: 'tok',
  code: 'PPSALE1',
  sale_amount: 39.9,
  sale_status_enum: status === 'approved' ? 2 : 4,
  sale_status_enum_key: status,
  sale_status_detail: status,
  customer: { email: '  Compradora@Mail.com ', country: 'MX' },
  plan: { code: 'PPPRO', name: 'Pro' },
  subscription: { code: 'PPSUB1', status: 'active', status_event: 'subscription_started' },
});

describe('Compra paga sem conta (B-01)', () => {
  it('guarda a venda, marca o log original e avisa a compradora uma vez só por venda', async () => {
    const { logs, perfectpay, emailService } = setup();

    const first = await perfectpay.handle(planSale('approved'));
    const second = await perfectpay.handle(planSale('completed'));

    expect(first).toEqual({ processed: false, reason: 'no account for email compradora@mail.com' });
    expect(second.processed).toBe(false);
    const markers = logs.filter((row) => row.provider === NO_ACCOUNT_PROVIDER);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ externalId: 'compradora@mail.com', eventType: 'perfectpay:perfectpay-PPSALE1' });
    expect(logs.filter((row) => row.provider === 'perfectpay').every((row) => row.error === 'no account: compradora@mail.com')).toBe(true);
    expect(emailService.sendPurchaseWithoutAccountEmail).toHaveBeenCalledTimes(1);
    expect(emailService.sendPurchaseWithoutAccountEmail).toHaveBeenCalledWith('compradora@mail.com', {
      locale: 'es',
      productName: 'Pro',
    });
  });

  it('no cadastro aplica a venda pelo mesmo handler; rodar 2× não ativa 2×', async () => {
    const { logs, users, perfectpay, claimer, activations, paymentsService } = setup();
    await perfectpay.handle(planSale('approved'));
    users.push({ id: 'user-1', email: 'compradora@mail.com', referredByCode: null });

    const first = await claimer.claimForUser({ id: 'user-1', email: 'Compradora@mail.com' });
    const second = await claimer.claimForUser({ id: 'user-1', email: 'compradora@mail.com' });

    expect(first).toEqual({ applied: 1, failed: 0 });
    expect(second).toEqual({ applied: 0, failed: 0 });
    expect(activations).toEqual(['perfectpay-PPSALE1']);
    expect(paymentsService.activateOrRenewPerfectpaySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', planId: 'plan-pro', saleCode: 'perfectpay-PPSALE1' }),
    );
    const marker = logs.find((row) => row.provider === NO_ACCOUNT_PROVIDER);
    expect(marker?.processed).toBe(true);
  });

  it('se o marcador voltar a pendente (corrida entre instâncias), o reprocesso não credita de novo', async () => {
    const { logs, users, perfectpay, claimer, activations } = setup();
    await perfectpay.handle(planSale('approved'));
    users.push({ id: 'user-1', email: 'compradora@mail.com', referredByCode: null });
    await claimer.claimForUser({ id: 'user-1', email: 'compradora@mail.com' });

    const marker = logs.find((row) => row.provider === NO_ACCOUNT_PROVIDER)!;
    marker.processed = false;
    const again = await claimer.claimForUser({ id: 'user-1', email: 'compradora@mail.com' });

    expect(again).toEqual({ applied: 1, failed: 0 });
    expect(activations).toHaveLength(1);
    expect(marker.processed).toBe(true);
  });

  it('o reprocesso não manda o e-mail de "crie sua conta" de novo', async () => {
    const { perfectpay, emailService } = setup();
    await perfectpay.handle(planSale('approved'));
    // ainda sem conta: o reprocesso devolve "no account" sem guardar nem avisar outra vez
    const replay = await perfectpay.replayPaidSale(planSale('approved'));
    expect(replay.processed).toBe(false);
    expect(emailService.sendPurchaseWithoutAccountEmail).toHaveBeenCalledTimes(1);
  });

  it('Cakto: pacote pago sem conta entra no cadastro, uma vez', async () => {
    const { users, prisma, cakto, claimer, creditPurchases, emailService } = setup();
    prisma.plan.findFirst.mockResolvedValue(null as never);
    const payload = {
      secret: 'seg',
      event: 'purchase_approved',
      data: { id: 'ord-9', status: 'paid', amount: 97, currency: 'BRL', offer: { id: 'mega1' }, customer: { email: 'cliente@mail.com' } },
    };

    const result = await cakto.handle(payload);
    expect(result.processed).toBe(false);
    expect(emailService.sendPurchaseWithoutAccountEmail).toHaveBeenCalledWith('cliente@mail.com', {
      locale: 'pt',
      productName: 'Mega',
    });

    users.push({ id: 'user-2', email: 'cliente@mail.com', referredByCode: null });
    await claimer.claimForUser({ id: 'user-2', email: 'cliente@mail.com' });
    await claimer.claimForUser({ id: 'user-2', email: 'cliente@mail.com' });
    expect(creditPurchases).toHaveLength(1);
  });
});
