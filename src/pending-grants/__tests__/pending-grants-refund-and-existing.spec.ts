import { PendingGrantsService } from '../pending-grants.service';
import { PerfectpayWebhookService } from '../perfectpay-webhook.service';

/** TKT-109 (isca para conta existente), reembolso da isca e roteamento de reembolso na Perfect Pay. */

function grantsPrisma(state: { grants: any[]; user?: { id: string; email: string } | null; free?: Record<string, number> }) {
  const free = state.free ?? {};
  const client: any = {
    user: { findFirst: jest.fn(async () => state.user ?? null) },
    pendingFreeGenerationGrant: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `g${state.grants.length + 1}`, consumedByUserId: null, consumedAt: null, ...data };
        state.grants.push(row);
        return row;
      }),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async ({ where }: any) =>
        state.grants.filter((g) => {
          if (where.email) return g.email === where.email && g.consumedByUserId === null;
          const ids = where.OR.map((c: any) => c.externalEventId);
          return ids.some((c: any) => (typeof c === 'string' ? g.externalEventId === c : g.externalEventId?.startsWith(c.startsWith)));
        }),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const g = state.grants.find((x) => x.id === where.id && x.consumedByUserId === null);
        if (!g) return { count: 0 };
        Object.assign(g, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(state.grants.find((x) => x.id === where.id), data)),
    },
    userFreeGeneration: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = where.userId_type.type;
        free[key] = (free[key] ?? 0) + (update.remaining?.increment ?? create.remaining);
      }),
      findUnique: jest.fn(async ({ where }: any) => ({ remaining: free[where.userId_type.type] ?? 0 })),
      update: jest.fn(async ({ where, data }: any) => {
        free[where.userId_type.type] -= data.remaining.decrement;
      }),
    },
  };
  client.$transaction = jest.fn(async (fn: any) => fn(client));
  return { client, free };
}

describe('PendingGrantsService', () => {
  it('comprador que já tem conta recebe o bundle na hora do webhook (TKT-109)', async () => {
    const state = { grants: [] as any[], user: { id: 'user-1', email: 'Buyer@Mail.com' } };
    const { client, free } = grantsPrisma(state);
    const service = new PendingGrantsService(client);

    const result = await service.createPending({
      email: 'buyer@mail.com',
      bundle: { NB2: 2, VEO_FAST: 1 },
      source: 'perfectpay',
      externalEventId: 'perfectpay-sale-ABC',
    });

    expect(result.created).toBe(true);
    expect(free).toEqual({ NB2: 2, VEO_FAST: 1 });
    expect(state.grants[0].consumedByUserId).toBe('user-1');
  });

  it('sem conta: fica pendente para o cadastro', async () => {
    const state = { grants: [] as any[], user: null };
    const { client, free } = grantsPrisma(state);
    const service = new PendingGrantsService(client);

    await service.createPending({ email: 'x@mail.com', bundle: { NB2: 2 }, source: 'perfectpay', externalEventId: 'e1' });

    expect(free).toEqual({});
    expect(state.grants[0].consumedByUserId).toBeNull();
  });

  it('consumo concorrente: só quem reserva primeiro credita', async () => {
    const state = { grants: [{ id: 'g1', email: 'a@b.com', bundle: { NB2: 2 }, consumedByUserId: 'outro', source: 'hubla' }] as any[] };
    const { client, free } = grantsPrisma(state);
    // findMany devolve a grant como se ainda estivesse livre (leu antes do outro marcar)
    client.pendingFreeGenerationGrant.findMany.mockResolvedValueOnce([{ ...state.grants[0], consumedByUserId: null }]);
    const service = new PendingGrantsService(client);

    const consumed = await service.consumeForUser('user-1', 'a@b.com');

    expect(consumed).toBe(0);
    expect(free).toEqual({});
  });

  it('reembolso da isca: grant usada perde o que sobra; grant livre vira bundle vazio; id antigo com status casa', async () => {
    const state = {
      grants: [
        { id: 'g1', email: 'a@b.com', externalEventId: 'perfectpay-sale-ABC-approved', bundle: { NB2: 2, VEO_FAST: 2 }, consumedByUserId: 'user-1', source: 'perfectpay' },
        { id: 'g2', email: 'a@b.com', externalEventId: 'perfectpay-sale-ABC', bundle: { NB2: 2 }, consumedByUserId: null, source: 'perfectpay' },
        { id: 'g3', email: 'c@d.com', externalEventId: 'perfectpay-sale-ABCD', bundle: { NB2: 9 }, consumedByUserId: null, source: 'perfectpay' },
      ] as any[],
      free: { NB2: 1, VEO_FAST: 2 },
    };
    const { client, free } = grantsPrisma(state);
    const service = new PendingGrantsService(client);

    const result = await service.revokeForRefund('perfectpay-sale-ABC', 'refund');

    expect(result.grants).toBe(2);
    expect(result.removed).toEqual({ NB2: 1, VEO_FAST: 2 });
    expect(free).toEqual({ NB2: 0, VEO_FAST: 0 });
    expect(state.grants[1]).toMatchObject({ bundle: {}, source: 'perfectpay:refunded' });
    expect(state.grants[2].source).toBe('perfectpay'); // outra venda com prefixo parecido fica intacta

    // segundo postback do reembolso: nada muda
    const again = await service.revokeForRefund('perfectpay-sale-ABC', 'refund');
    expect(again.grants).toBe(0);
  });
});

describe('PerfectpayWebhookService — reembolso não revoga assinatura por engano (TKT-099)', () => {
  function webhook(paymentRefund: any, extra: { plan?: any; pkg?: any; extraTarget?: any } = {}) {
    const paymentsService = {
      refundExternalPayment: jest.fn(async () => paymentRefund),
      revokePerfectpaySubscription: jest.fn(async () => ({ processed: true })),
    };
    const pendingGrantsService = { revokeForRefund: jest.fn(async () => ({ grants: 1, removed: { NB2: 2 } })) };
    const prisma = {
      user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
      plan: { findFirst: jest.fn(async () => extra.plan ?? null) },
      creditPackage: { findFirst: jest.fn(async () => extra.pkg ?? null) },
    };
    const config = { get: jest.fn((key: string) => (key === 'PERFECTPAY_WEBHOOK_TOKEN' ? 'tok' : undefined)) };
    const service = new PerfectpayWebhookService(
      config as any,
      pendingGrantsService as any,
      { create: jest.fn(async () => ({})) } as any,
      {} as any,
      prisma as any,
      paymentsService as any,
      { findSaleTarget: jest.fn(async () => extra.extraTarget ?? null) } as any,
    );
    return { service, paymentsService, pendingGrantsService };
  }
  const refundPayload = (extra: Record<string, any> = {}) => ({
    token: 'tok',
    code: 'PPCODE',
    sale_status_enum: 7,
    sale_status_enum_key: 'refunded',
    customer: { email: 'buyer@mail.com' },
    ...extra,
  });

  it('reembolso de pack: retira os créditos e NÃO revoga a assinatura', async () => {
    const { service, paymentsService } = webhook({ found: true, type: 'CREDIT_PURCHASE', creditsRevoked: 25000, creditsShortfall: 0 });

    const result = await service.handle(refundPayload());

    expect(paymentsService.refundExternalPayment).toHaveBeenCalledWith('perfectpay-PPCODE', 'refund');
    expect(paymentsService.revokePerfectpaySubscription).not.toHaveBeenCalled();
    expect(result.processed).toBe(true);
  });

  it('reembolso da isca: revoga o bundle da venda e NÃO revoga a assinatura', async () => {
    const { service, paymentsService, pendingGrantsService } = webhook({ found: false });

    await service.handle(refundPayload());

    expect(pendingGrantsService.revokeForRefund).toHaveBeenCalledWith('perfectpay-sale-PPCODE', 'refund');
    expect(paymentsService.revokePerfectpaySubscription).not.toHaveBeenCalled();
  });

  it('reembolso de pack sem pagamento registrado: não revoga nada', async () => {
    const { service, paymentsService, pendingGrantsService } = webhook({ found: false }, { pkg: { name: 'Mega' } });

    const result = await service.handle(refundPayload({ plan: { code: 'PPPACK' } }));

    expect(result.processed).toBe(false);
    expect(pendingGrantsService.revokeForRefund).not.toHaveBeenCalled();
    expect(paymentsService.revokePerfectpaySubscription).not.toHaveBeenCalled();
  });

  it('reembolso de pack de outra marca (código extra) sem pagamento registrado: não vira reembolso da isca', async () => {
    const { service, paymentsService, pendingGrantsService } = webhook(
      { found: false },
      { extraTarget: { kind: 'package', creditPackage: { id: 'pkg-1', name: 'Mega', credits: 25000 } } },
    );

    const result = await service.handle(refundPayload({ plan: { code: 'PPFUNV' } }));

    expect(result.processed).toBe(false);
    expect(pendingGrantsService.revokeForRefund).not.toHaveBeenCalled();
    expect(paymentsService.revokePerfectpaySubscription).not.toHaveBeenCalled();
  });

  it('reembolso de assinatura: marca o pagamento e segue revogando a assinatura', async () => {
    const { service, paymentsService } = webhook({ found: true, type: 'SUBSCRIPTION', creditsRevoked: 0 });

    await service.handle(refundPayload({ subscription: { code: 'PPSUB1', status: 'canceled' } }));

    expect(paymentsService.refundExternalPayment).toHaveBeenCalled();
    expect(paymentsService.revokePerfectpaySubscription).toHaveBeenCalledWith('user-1', expect.objectContaining({ immediate: true, reason: 'refund' }));
  });
});
