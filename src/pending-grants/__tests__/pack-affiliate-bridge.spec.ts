import { PendingGrantsService } from '../pending-grants.service';
import { PerfectpayWebhookService } from '../perfectpay-webhook.service';

/**
 * Ponte Pack → plataforma: venda do Pack feita por afiliado da Perfect Pay deixa a conta do
 * comprador com o afiliado correspondente da plataforma. Desligada por padrão
 * (PACK_AFFILIATE_BRIDGE_ENABLED); nunca troca o afiliado de quem já tem um.
 */
interface UserRow {
  id: string;
  email: string;
  emailVerified?: boolean;
  referredByCode: string | null;
}
interface AffiliateRow {
  id: string;
  code: string;
  isActive: boolean;
  userId: string | null;
  perfectpayAffiliateEmail?: string | null;
}
interface GrantRow {
  id: string;
  email: string;
  bundle: Record<string, number>;
  source: string;
  externalEventId: string | null;
  consumedByUserId: string | null;
  consumedAt: Date | null;
  affiliateRef?: string | null;
  createdAt: Date;
}

function grant(overrides: Partial<GrantRow> & { id: string }): GrantRow {
  return {
    email: 'buyer@mail.com',
    bundle: { NB2: 2 },
    source: 'perfectpay',
    externalEventId: `sale-${overrides.id}`,
    consumedByUserId: null,
    consumedAt: null,
    affiliateRef: null,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    ...overrides,
  };
}

function bridgePrisma(state: { grants: GrantRow[]; users: UserRow[]; affiliates: AffiliateRow[] }) {
  const pickAffiliate = (row: AffiliateRow | undefined) =>
    row ? { id: row.id, code: row.code, isActive: row.isActive, userId: row.userId } : null;

  const client: any = {
    pendingFreeGenerationGrant: {
      findUnique: jest.fn(async ({ where }: any) =>
        state.grants.find((row) => row.externalEventId === where.externalEventId) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = grant({ id: `g${state.grants.length + 1}`, ...data });
        state.grants.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        state.grants
          .filter((row) => row.email === where.email && row.consumedByUserId === null)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = state.grants.find((g) => g.id === where.id && g.consumedByUserId === null);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    userFreeGeneration: { upsert: jest.fn(async () => ({})) },
    user: {
      findFirst: jest.fn(async ({ where }: any) =>
        state.users.find((row) => row.email.toLowerCase() === String(where.email.equals).toLowerCase()) ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = state.users.find((u) => u.id === where.id && u.referredByCode === where.referredByCode);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    affiliate: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.code !== undefined) return pickAffiliate(state.affiliates.find((a) => a.code === where.code));
        return pickAffiliate(
          state.affiliates.find((a) => a.perfectpayAffiliateEmail === where.perfectpayAffiliateEmail),
        );
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const email = String(where.user.email.equals).toLowerCase();
        const owner = state.users.find(
          (u) => u.email.toLowerCase() === email && (u.emailVerified ?? false) === where.user.emailVerified,
        );
        return pickAffiliate(owner ? state.affiliates.find((a) => a.userId === owner.id) : undefined);
      }),
    },
  };
  client.$transaction = jest.fn(async (fn: any) => fn(client));
  return client;
}

describe('PendingGrantsService.consumeForUser · ponte Pack → plataforma', () => {
  const ORIGINAL_FLAG = process.env.PACK_AFFILIATE_BRIDGE_ENABLED;

  beforeEach(() => {
    process.env.PACK_AFFILIATE_BRIDGE_ENABLED = 'true';
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
    else process.env.PACK_AFFILIATE_BRIDGE_ENABLED = ORIGINAL_FLAG;
  });

  const buyer = (extra: Partial<UserRow> = {}): UserRow => ({
    id: 'buyer-1',
    email: 'buyer@mail.com',
    emailVerified: true,
    referredByCode: null,
    ...extra,
  });
  const partner = (extra: Partial<AffiliateRow> = {}): AffiliateRow => ({
    id: 'aff-1',
    code: 'PARCEIRA',
    isActive: true,
    userId: 'partner-user',
    perfectpayAffiliateEmail: 'parceira.pp@exemplo.test',
    ...extra,
  });

  function setup(state: { grants: GrantRow[]; users: UserRow[]; affiliates: AffiliateRow[] }) {
    const client = bridgePrisma(state);
    return { service: new PendingGrantsService(client), client, state };
  }

  it('atribui pelo e-mail da Perfect Pay que o admin gravou no afiliado', async () => {
    const { service, state } = setup({
      grants: [grant({ id: 'g1', affiliateRef: 'email:parceira.pp@exemplo.test' })],
      users: [buyer()],
      affiliates: [partner()],
    });

    const consumed = await service.consumeForUser('buyer-1', 'Buyer@Mail.com');

    expect(consumed).toBe(1);
    expect(state.users[0].referredByCode).toBe('PARCEIRA');
  });

  it('atribui pelo e-mail da conta do afiliado quando o admin não gravou o da Perfect Pay', async () => {
    const { service, state } = setup({
      grants: [grant({ id: 'g1', affiliateRef: 'email:Parceira@Exemplo.test' })],
      users: [buyer(), { id: 'partner-user', email: 'parceira@exemplo.test', emailVerified: true, referredByCode: null }],
      affiliates: [partner({ perfectpayAffiliateEmail: null })],
    });

    await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(state.users[0].referredByCode).toBe('PARCEIRA');
  });

  it('conta de afiliado sem e-mail confirmado não casa pelo e-mail da conta', async () => {
    const { service, state } = setup({
      grants: [grant({ id: 'g1', affiliateRef: 'email:parceira@exemplo.test' })],
      users: [buyer(), { id: 'partner-user', email: 'parceira@exemplo.test', emailVerified: false, referredByCode: null }],
      affiliates: [partner({ perfectpayAffiliateEmail: null })],
    });

    await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(state.users[0].referredByCode).toBeNull();
  });

  it('atribui pelo código do link (code:)', async () => {
    const { service, state, client } = setup({
      grants: [grant({ id: 'g1', affiliateRef: 'code:PARCEIRA' })],
      users: [buyer()],
      affiliates: [partner()],
    });

    await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(state.users[0].referredByCode).toBe('PARCEIRA');
    expect(client.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'buyer-1', referredByCode: null },
      data: { referredByCode: 'PARCEIRA' },
    });
  });

  it('não sobrescreve: conta que já tem afiliado fica com ele', async () => {
    const { service, state } = setup({
      grants: [grant({ id: 'g1', affiliateRef: 'code:PARCEIRA' })],
      users: [buyer({ referredByCode: 'OUTRA' })],
      affiliates: [partner()],
    });

    const consumed = await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(consumed).toBe(1);
    expect(state.users[0].referredByCode).toBe('OUTRA');
  });

  it('flag desligada: consome a grant e não mexe na conta', async () => {
    for (const flag of [undefined, '', 'false', '1']) {
      if (flag === undefined) delete process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
      else process.env.PACK_AFFILIATE_BRIDGE_ENABLED = flag;
      const { service, state, client } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'code:PARCEIRA' })],
        users: [buyer()],
        affiliates: [partner()],
      });

      const consumed = await service.consumeForUser('buyer-1', 'buyer@mail.com');

      expect(consumed).toBe(1);
      expect(state.users[0].referredByCode).toBeNull();
      expect(client.affiliate.findUnique).not.toHaveBeenCalled();
      expect(client.user.updateMany).not.toHaveBeenCalled();
    }
  });

  it('afiliado inativo não recebe a conta', async () => {
    const { service, state, client } = setup({
      grants: [grant({ id: 'g1', affiliateRef: 'email:parceira.pp@exemplo.test' })],
      users: [buyer()],
      affiliates: [partner({ isActive: false })],
    });

    await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(state.users[0].referredByCode).toBeNull();
    expect(client.user.updateMany).not.toHaveBeenCalled();
  });

  it('autoatribuição: o afiliado que compra o próprio Pack não vira cliente de si mesmo', async () => {
    const { service, state, client } = setup({
      grants: [grant({ id: 'g1', email: 'parceira@exemplo.test', affiliateRef: 'code:PARCEIRA' })],
      users: [{ id: 'partner-user', email: 'parceira@exemplo.test', emailVerified: true, referredByCode: null }],
      affiliates: [partner()],
    });

    const consumed = await service.consumeForUser('partner-user', 'parceira@exemplo.test');

    expect(consumed).toBe(1);
    expect(state.users[0].referredByCode).toBeNull();
    expect(client.user.updateMany).not.toHaveBeenCalled();
  });

  it('referência sem afiliado correspondente: nada é atribuído e a grant é consumida', async () => {
    const { service, state } = setup({
      grants: [
        grant({ id: 'g1', affiliateRef: 'email:desconhecida@exemplo.test' }),
        grant({ id: 'g2', affiliateRef: 'code:NAOEXISTE' }),
        grant({ id: 'g3', affiliateRef: 'formato-torto' }),
      ],
      users: [buyer()],
      affiliates: [partner()],
    });

    const consumed = await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(consumed).toBe(3);
    expect(state.users[0].referredByCode).toBeNull();
  });

  it('grant sem referência (venda sem afiliado) não consulta afiliado nenhum', async () => {
    const { service, client } = setup({
      grants: [grant({ id: 'g1', affiliateRef: null })],
      users: [buyer()],
      affiliates: [partner()],
    });

    await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(client.affiliate.findUnique).not.toHaveBeenCalled();
    expect(client.affiliate.findFirst).not.toHaveBeenCalled();
  });

  it('duas vendas com afiliados diferentes: vale o da venda mais antiga', async () => {
    const { service, state } = setup({
      grants: [
        grant({ id: 'g-nova', affiliateRef: 'code:OUTRA', createdAt: new Date('2026-11-05T10:00:00Z') }),
        grant({ id: 'g-antiga', affiliateRef: 'code:PARCEIRA', createdAt: new Date('2026-11-01T10:00:00Z') }),
      ],
      users: [buyer()],
      affiliates: [partner(), partner({ id: 'aff-2', code: 'OUTRA', userId: 'outra-user', perfectpayAffiliateEmail: null })],
    });

    const consumed = await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(consumed).toBe(2);
    expect(state.users[0].referredByCode).toBe('PARCEIRA');
  });

  it('só atribui quando a reserva da grant deu certo (outro processo consumiu antes)', async () => {
    const { service, state, client } = setup({
      grants: [grant({ id: 'g1', affiliateRef: 'code:PARCEIRA', consumedByUserId: 'outro' })],
      users: [buyer()],
      affiliates: [partner()],
    });
    // leu a grant como livre antes de o outro processo marcar
    client.pendingFreeGenerationGrant.findMany.mockResolvedValueOnce([{ ...state.grants[0], consumedByUserId: null }]);

    const consumed = await service.consumeForUser('buyer-1', 'buyer@mail.com');

    expect(consumed).toBe(0);
    expect(state.users[0].referredByCode).toBeNull();
    expect(client.affiliate.findUnique).not.toHaveBeenCalled();
  });

  it('comprador que já tem conta: a atribuição acontece na hora do webhook (createPending)', async () => {
    const { service, state } = setup({ grants: [], users: [buyer()], affiliates: [partner()] });

    const result = await service.createPending({
      email: 'buyer@mail.com',
      bundle: { NB2: 2 },
      source: 'perfectpay',
      externalEventId: 'perfectpay-sale-ABC',
      affiliateRef: 'email:parceira.pp@exemplo.test',
    });

    expect(result.created).toBe(true);
    expect(state.grants[0]).toMatchObject({ affiliateRef: 'email:parceira.pp@exemplo.test', consumedByUserId: 'buyer-1' });
    expect(state.users[0].referredByCode).toBe('PARCEIRA');
  });

  it('createPending sem referência grava a grant como sempre (sem a coluna nova)', async () => {
    const { service, client } = setup({ grants: [], users: [], affiliates: [] });

    await service.createPending({ email: 'x@mail.com', bundle: { NB2: 2 }, source: 'hubla', externalEventId: 'e1' });
    await service.createPending({ email: 'y@mail.com', bundle: { NB2: 2 }, source: 'hubla', externalEventId: 'e2', affiliateRef: null });

    for (const [args] of client.pendingFreeGenerationGrant.create.mock.calls as any[][]) {
      expect(args.data).not.toHaveProperty('affiliateRef');
    }
  });

  it('reembolso do Pack não desfaz a atribuição: o cliente continua do afiliado', async () => {
    const state = {
      grants: [grant({ id: 'g1', externalEventId: 'perfectpay-sale-ABC', affiliateRef: 'code:PARCEIRA' })],
      users: [buyer()],
      affiliates: [partner()],
    };
    const client = bridgePrisma(state);
    client.pendingFreeGenerationGrant.findMany.mockImplementation(async ({ where }: any) =>
      where.OR
        ? state.grants.filter((row) => row.externalEventId === where.OR[0].externalEventId)
        : state.grants.filter((row) => row.email === where.email && row.consumedByUserId === null),
    );
    client.pendingFreeGenerationGrant.update = jest.fn(async ({ where, data }: any) =>
      Object.assign(state.grants.find((row) => row.id === where.id)!, data),
    );
    client.userFreeGeneration.findUnique = jest.fn(async () => ({ remaining: 2 }));
    client.userFreeGeneration.update = jest.fn(async () => ({}));
    const service = new PendingGrantsService(client);

    await service.consumeForUser('buyer-1', 'buyer@mail.com');
    expect(state.users[0].referredByCode).toBe('PARCEIRA');

    const refund = await service.revokeForRefund('perfectpay-sale-ABC', 'refund');

    expect(refund.grants).toBe(1);
    expect(state.grants[0].source).toBe('perfectpay:refunded');
    expect(state.users[0].referredByCode).toBe('PARCEIRA');
    expect(client.user.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('PerfectpayWebhookService · referência do afiliado na venda do Pack', () => {
  function webhook(env: Record<string, string | undefined>) {
    const pendingGrantsService = { createPending: jest.fn(async () => ({ created: true, id: 'g1' })) };
    const config = {
      get: jest.fn((key: string) => (key === 'PERFECTPAY_WEBHOOK_TOKEN' ? 'tok' : env[key])),
    };
    const prisma = {
      plan: { findFirst: jest.fn(async () => null) },
      creditPackage: { findFirst: jest.fn(async () => null) },
    };
    const service = new PerfectpayWebhookService(
      config as any,
      pendingGrantsService as any,
      { create: jest.fn(async () => ({})) } as any,
      { sendPendingGrantsEmail: jest.fn(async () => undefined) } as any,
      prisma as any,
      {} as any,
      { findSaleTarget: jest.fn(async () => null) } as any,
    );
    const storedRef = () => (pendingGrantsService.createPending.mock.calls as any[][])[0]?.[0]?.affiliateRef;
    return { service, pendingGrantsService, storedRef };
  }

  const packSale = (extra: Record<string, unknown> = {}) => ({
    token: 'tok',
    code: 'PPCPMTB123',
    sale_amount: 12.99,
    sale_status_enum: 2,
    sale_status_detail: 'approved',
    customer: { email: 'Buyer@Mail.com', full_name: 'Buyer Name' },
    product: { code: 'PPPBFJAQ', name: 'Pack 300' },
    plan: { code: 'PPLQQQXXX', name: 'Completo' },
    commission: [
      { affiliation_code: 'PPAJFTR', affiliation_type_enum: 5, email: 'Parceira.PP@exemplo.test', commission_amount: 9 },
      { affiliation_code: 'PPAGSDE', affiliation_type_enum: 1, email: 'produtor@casa.test', commission_amount: 3 },
      { affiliation_type_enum: 0, name: 'PerfectPay', commission_amount: 0.99 },
    ],
    ...extra,
  });

  it('flag desligada (padrão): a grant nasce sem referência, como hoje', async () => {
    for (const flag of [undefined, '', 'false']) {
      const { service, pendingGrantsService, storedRef } = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: flag });

      const result = await service.handle(packSale());

      expect(result.processed).toBe(true);
      expect(pendingGrantsService.createPending).toHaveBeenCalledTimes(1);
      expect(storedRef()).toBeNull();
    }
  });

  it('flag ligada: guarda o e-mail do afiliado da venda', async () => {
    const { service, pendingGrantsService, storedRef } = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: 'true' });

    await service.handle(packSale());

    expect(storedRef()).toBe('email:parceira.pp@exemplo.test');
    expect((pendingGrantsService.createPending.mock.calls as any[][])[0][0]).toMatchObject({
      email: 'buyer@mail.com',
      source: 'perfectpay',
      externalEventId: 'perfectpay-sale-PPCPMTB123',
    });
  });

  it('venda sem afiliado: sem referência', async () => {
    const { service, storedRef } = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: 'true' });

    await service.handle(packSale({ commission: packSale().commission.slice(1) }));

    expect(storedRef()).toBeNull();
  });

  it('código do link (src=convite:CODIGO) vale quando não há afiliado na comissão', async () => {
    const { service, storedRef } = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: 'true' });

    await service.handle(packSale({ commission: undefined, metadata: { src: 'convite:parceira' } }));

    expect(storedRef()).toBe('code:PARCEIRA');
  });

  it('produto fora de PERFECTPAY_PACK_PRODUCTS não entra na ponte', async () => {
    const outside = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: 'true', PERFECTPAY_PACK_PRODUCTS: 'PPPBFJAR,PPPBFHC5' });
    await outside.service.handle(packSale());
    expect(outside.storedRef()).toBeNull();
    expect(outside.pendingGrantsService.createPending).toHaveBeenCalledTimes(1);

    const inside = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: 'true', PERFECTPAY_PACK_PRODUCTS: 'pppbfjaq, PPPBFJAR' });
    await inside.service.handle(packSale());
    expect(inside.storedRef()).toBe('email:parceira.pp@exemplo.test');
  });

  it('conta própria como "afiliada" (PERFECTPAY_OWN_ACCOUNT_EMAILS) é ignorada', async () => {
    const { service, storedRef } = webhook({
      PACK_AFFILIATE_BRIDGE_ENABLED: 'true',
      PERFECTPAY_OWN_ACCOUNT_EMAILS: 'produtor@casa.test, PARCEIRA.pp@exemplo.test',
    });

    await service.handle(packSale());

    expect(storedRef()).toBeNull();
  });

  it('payload torto no lugar da comissão não derruba o webhook', async () => {
    const { service, storedRef } = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: 'true' });

    const result = await service.handle(packSale({ commission: 'lixo', metadata: 7, affiliate: [] }));

    expect(result.processed).toBe(true);
    expect(storedRef()).toBeNull();
  });
});
