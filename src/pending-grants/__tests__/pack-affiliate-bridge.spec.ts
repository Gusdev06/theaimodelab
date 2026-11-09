import { Logger } from '@nestjs/common';
import { PendingGrantsService } from '../pending-grants.service';
import { PerfectpayWebhookService } from '../perfectpay-webhook.service';

/**
 * Ponte Pack → plataforma: venda do Pack feita por afiliado da Perfect Pay deixa a conta NOVA
 * do comprador com o afiliado correspondente da plataforma. Desligada por padrão
 * (PACK_AFFILIATE_BRIDGE_ENABLED). Regras: só no cadastro (nunca login nem conta que já
 * existia), depois do commit, sem derrubar o cadastro; reembolso desfaz; o código da Perfect
 * Pay nunca é comparado com o código da plataforma; nunca troca o afiliado de quem já tem um.
 */
interface UserRow {
  id: string;
  email: string;
  emailVerified?: boolean;
  referredByCode: string | null;
  createdAt: Date;
}
interface AffiliateRow {
  id: string;
  code: string;
  isActive: boolean;
  userId: string | null;
  perfectpayAffiliateEmail?: string | null;
  perfectpayAffiliateCode?: string | null;
  payoutEmail?: string | null;
  pixKey?: string | null;
  pixKeyType?: string | null;
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
  attributedAffiliateCode?: string | null;
  createdAt: Date;
}
interface BridgeState {
  grants: GrantRow[];
  users: UserRow[];
  affiliates: AffiliateRow[];
  /** userId de quem já tem pagamento concluído. */
  paidUserIds?: string[];
  /** userId de quem já entrou pelo "indique e ganhe". */
  referredUserIds?: string[];
}

const SALE_AT = new Date('2026-11-01T10:00:00Z');
const SIGNUP_AT = new Date('2026-11-02T09:00:00Z');

function grant(overrides: Partial<GrantRow> & { id: string }): GrantRow {
  return {
    email: 'buyer@mail.com',
    bundle: { NB2: 2 },
    source: 'perfectpay',
    externalEventId: `sale-${overrides.id}`,
    consumedByUserId: null,
    consumedAt: null,
    affiliateRef: null,
    attributedAffiliateCode: null,
    createdAt: SALE_AT,
    ...overrides,
  };
}

function bridgePrisma(state: BridgeState) {
  const pickAffiliate = (row: AffiliateRow | undefined) =>
    row
      ? {
          id: row.id,
          code: row.code,
          isActive: row.isActive,
          userId: row.userId,
          perfectpayAffiliateEmail: row.perfectpayAffiliateEmail ?? null,
          payoutEmail: row.payoutEmail ?? null,
          pixKey: row.pixKey ?? null,
          pixKeyType: row.pixKeyType ?? null,
          user: row.userId ? { email: state.users.find((u) => u.id === row.userId)?.email ?? 'sem-conta@x.test' } : null,
        }
      : null;

  const grantMatches = (row: GrantRow, where: any): boolean => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if ('consumedByUserId' in where && row.consumedByUserId !== where.consumedByUserId) return false;
    if (where.affiliateRef?.not === null && (row.affiliateRef ?? null) === null) return false;
    if (where.NOT?.source?.endsWith && row.source.endsWith(where.NOT.source.endsWith)) return false;
    return true;
  };

  const client: any = {
    pendingFreeGenerationGrant: {
      findUnique: jest.fn(async ({ where }: any) =>
        state.grants.find((row) => row.externalEventId === where.externalEventId) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = grant({ id: `g${state.grants.length + 1}`, createdAt: new Date(), ...data });
        state.grants.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        where.OR
          ? state.grants.filter((row) => row.externalEventId === where.OR[0].externalEventId)
          : state.grants
              .filter((row) => row.email === where.email && row.consumedByUserId === null)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = state.grants.filter((row) => grantMatches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(state.grants.find((row) => row.id === where.id)!, data),
      ),
    },
    userFreeGeneration: {
      upsert: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({ remaining: 2 })),
      update: jest.fn(async () => ({})),
    },
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
        if (where.perfectpayAffiliateCode !== undefined) {
          return pickAffiliate(
            state.affiliates.find((a) => (a.perfectpayAffiliateCode ?? null) === where.perfectpayAffiliateCode),
          );
        }
        return pickAffiliate(
          state.affiliates.find((a) => (a.perfectpayAffiliateEmail ?? null) === where.perfectpayAffiliateEmail),
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
    payment: {
      findFirst: jest.fn(async ({ where }: any) =>
        (state.paidUserIds ?? []).includes(where.userId) && where.status === 'COMPLETED' ? { id: 'pay-1' } : null,
      ),
    },
    referral: {
      findUnique: jest.fn(async ({ where }: any) =>
        (state.referredUserIds ?? []).includes(where.referredUserId) ? { id: 'ref-1' } : null,
      ),
    },
  };
  client.$transaction = jest.fn(async (fn: any) => fn(client));
  return client;
}

describe('PendingGrantsService · ponte Pack → plataforma', () => {
  const ORIGINAL_FLAG = process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
  const ORIGINAL_LINK = process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES;

  beforeEach(() => {
    process.env.PACK_AFFILIATE_BRIDGE_ENABLED = 'true';
    delete process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES;
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
    else process.env.PACK_AFFILIATE_BRIDGE_ENABLED = ORIGINAL_FLAG;
    if (ORIGINAL_LINK === undefined) delete process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES;
    else process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES = ORIGINAL_LINK;
    jest.restoreAllMocks();
  });

  const buyer = (extra: Partial<UserRow> = {}): UserRow => ({
    id: 'buyer-1',
    email: 'buyer@mail.com',
    emailVerified: true,
    referredByCode: null,
    createdAt: SIGNUP_AT,
    ...extra,
  });
  const partnerUser = (extra: Partial<UserRow> = {}): UserRow => ({
    id: 'partner-user',
    email: 'parceira@exemplo.test',
    emailVerified: true,
    referredByCode: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...extra,
  });
  const partner = (extra: Partial<AffiliateRow> = {}): AffiliateRow => ({
    id: 'aff-1',
    code: 'PARCEIRA',
    isActive: true,
    userId: 'partner-user',
    perfectpayAffiliateEmail: 'parceira.pp@exemplo.test',
    perfectpayAffiliateCode: 'PPAJFTR',
    ...extra,
  });

  function setup(state: BridgeState) {
    const client = bridgePrisma(state);
    return { service: new PendingGrantsService(client), client, state };
  }

  /** O que o cadastro faz: consome dentro da transação e atribui depois do commit. */
  async function signup(
    service: PendingGrantsService,
    client: any,
    state: BridgeState,
    userId = 'buyer-1',
  ) {
    const user = state.users.find((row) => row.id === userId)!;
    const grants = await client.$transaction((tx: any) => service.consumeForSignup(user.id, user.email, tx));
    const attributedCode = await service.attributeSignupToPackAffiliate(
      { id: user.id, createdAt: user.createdAt },
      grants.packBridge,
    );
    return { grants, attributedCode };
  }

  describe('cadastro: quem casa com quem', () => {
    it('pelo código da Perfect Pay (ppcode) que o admin gravou no afiliado', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants.consumed).toBe(1);
      expect(attributedCode).toBe('PARCEIRA');
      expect(state.users[0].referredByCode).toBe('PARCEIRA');
      expect(state.grants[0].attributedAffiliateCode).toBe('PARCEIRA');
      expect(client.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'buyer-1', referredByCode: null },
        data: { referredByCode: 'PARCEIRA' },
      });
    });

    it('pelo e-mail da Perfect Pay que o admin gravou no afiliado', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'email:parceira.pp@exemplo.test' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner({ perfectpayAffiliateCode: null })],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBe('PARCEIRA');
      expect(state.users[0].referredByCode).toBe('PARCEIRA');
    });

    it('ppcode sem dono cai no e-mail da mesma referência', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPNOVO1|email:parceira.pp@exemplo.test' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner({ perfectpayAffiliateCode: null })],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBe('PARCEIRA');
    });

    it('pelo e-mail confirmado da conta do afiliado quando o admin não gravou nada', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'email:Parceira@Exemplo.test' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner({ perfectpayAffiliateEmail: null, perfectpayAffiliateCode: null })],
      });

      await signup(service, client, state);

      expect(state.users[0].referredByCode).toBe('PARCEIRA');
    });

    it('conta de afiliado sem e-mail confirmado não casa pelo e-mail da conta', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'email:parceira@exemplo.test' })],
        users: [buyer(), partnerUser({ emailVerified: false })],
        affiliates: [partner({ perfectpayAffiliateEmail: null, perfectpayAffiliateCode: null })],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });
  });

  describe('espaços de nomes: código da Perfect Pay × código da plataforma', () => {
    it('ppcode igual ao código de OUTRO afiliado na plataforma não dá a conta a ele', async () => {
      // O afiliado "PPAJFTR" da plataforma não tem nada a ver com o affiliation_code PPAJFTR da Perfect Pay.
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner({ code: 'PPAJFTR', perfectpayAffiliateCode: null, perfectpayAffiliateEmail: null })],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
      const lookups = (client.affiliate.findUnique.mock.calls as any[][]).map(([args]) => Object.keys(args.where)[0]);
      expect(lookups).toEqual(['perfectpayAffiliateCode']);
    });

    it('ppcode casa só pela coluna perfectpayAffiliateCode, mesmo havendo um afiliado com esse code', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser(), partnerUser({ id: 'intruso-user', email: 'intruso@x.test' })],
        affiliates: [
          partner({ id: 'aff-intruso', code: 'PPAJFTR', userId: 'intruso-user', perfectpayAffiliateCode: null, perfectpayAffiliateEmail: null }),
          partner(),
        ],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBe('PARCEIRA');
    });
  });

  describe('código do link (code:)', () => {
    const linkState = (): BridgeState => ({
      grants: [grant({ id: 'g1', affiliateRef: 'code:PARCEIRA' })],
      users: [buyer(), partnerUser()],
      affiliates: [partner()],
    });

    it('desligado por padrão: referência do link não atribui', async () => {
      for (const flag of [undefined, '', 'false', '1']) {
        if (flag === undefined) delete process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES;
        else process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES = flag;
        const { service, client, state } = setup(linkState());

        const { grants, attributedCode } = await signup(service, client, state);

        expect(grants.consumed).toBe(1);
        expect(attributedCode).toBeNull();
        expect(state.users[0].referredByCode).toBeNull();
        expect(client.affiliate.findUnique).not.toHaveBeenCalled();
      }
    });

    it('com PACK_AFFILIATE_BRIDGE_LINK_CODES=true casa pelo código da plataforma', async () => {
      process.env.PACK_AFFILIATE_BRIDGE_LINK_CODES = 'true';
      const { service, client, state } = setup(linkState());

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBe('PARCEIRA');
      expect(state.users[0].referredByCode).toBe('PARCEIRA');
    });
  });

  describe('só conta nova, só no cadastro', () => {
    it('login (consumeForUser) consome a grant e não atribui', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });

      const consumed = await service.consumeForUser('buyer-1', 'Buyer@Mail.com');

      expect(consumed).toBe(1);
      expect(state.grants[0].consumedByUserId).toBe('buyer-1');
      expect(state.users[0].referredByCode).toBeNull();
      expect(state.grants[0].attributedAffiliateCode).toBeNull();
      expect(client.affiliate.findUnique).not.toHaveBeenCalled();
      expect(client.user.updateMany).not.toHaveBeenCalled();
    });

    it('comprador que já tinha conta: o webhook credita o bundle e não atribui (createPending)', async () => {
      const { service, client, state } = setup({ grants: [], users: [buyer(), partnerUser()], affiliates: [partner()] });

      const result = await service.createPending({
        email: 'buyer@mail.com',
        bundle: { NB2: 2 },
        source: 'perfectpay',
        externalEventId: 'perfectpay-sale-ABC',
        affiliateRef: 'ppcode:PPAJFTR|email:parceira.pp@exemplo.test',
      });

      expect(result.created).toBe(true);
      expect(state.grants[0]).toMatchObject({ consumedByUserId: 'buyer-1' });
      expect(state.users[0].referredByCode).toBeNull();
      expect(client.affiliate.findUnique).not.toHaveBeenCalled();
      expect(client.user.updateMany).not.toHaveBeenCalled();
    });

    it('conta criada antes da venda do Pack não é atribuída, nem pelo caminho do cadastro', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR', createdAt: SALE_AT })],
        users: [buyer({ createdAt: new Date('2026-10-01T00:00:00Z') }), partnerUser()],
        affiliates: [partner()],
      });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants.packBridge).not.toBeNull();
      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
      expect(client.user.updateMany).not.toHaveBeenCalled();
    });

    it('conta que já tem pagamento concluído não muda de dono', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
        paidUserIds: ['buyer-1'],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
      expect(client.payment.findFirst).toHaveBeenCalledWith({
        where: { userId: 'buyer-1', status: 'COMPLETED' },
        select: { id: true },
      });
    });

    it('conta que já entrou pelo "indique e ganhe" não ganha afiliado', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
        referredUserIds: ['buyer-1'],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });

    it('não sobrescreve: conta que nasceu com afiliado (link de convite) fica com ele e a isca não guarda marca', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer({ referredByCode: 'OUTRA' }), partnerUser()],
        affiliates: [partner()],
      });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants.consumed).toBe(1);
      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBe('OUTRA');
      expect(state.grants[0].attributedAffiliateCode).toBeNull();
    });
  });

  describe('flag e referência', () => {
    it('ponte desligada: consome a grant, não devolve venda candidata e não mexe na conta', async () => {
      for (const flag of [undefined, '', 'false', '1']) {
        if (flag === undefined) delete process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
        else process.env.PACK_AFFILIATE_BRIDGE_ENABLED = flag;
        const { service, client, state } = setup({
          grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
          users: [buyer(), partnerUser()],
          affiliates: [partner()],
        });

        const { grants, attributedCode } = await signup(service, client, state);

        expect(grants).toEqual({ consumed: 1, packBridge: null });
        expect(attributedCode).toBeNull();
        expect(state.users[0].referredByCode).toBeNull();
        expect(client.affiliate.findUnique).not.toHaveBeenCalled();
        expect(client.user.updateMany).not.toHaveBeenCalled();
      }
    });

    it('ponte desligada entre a transação e o commit: a venda candidata não é usada', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      const grants = await service.consumeForSignup('buyer-1', 'buyer@mail.com', client);
      process.env.PACK_AFFILIATE_BRIDGE_ENABLED = 'false';

      const attributedCode = await service.attributeSignupToPackAffiliate(
        { id: 'buyer-1', createdAt: SIGNUP_AT },
        grants.packBridge,
      );

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });

    it('afiliado inativo não recebe a conta', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner({ isActive: false })],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
      expect(client.user.updateMany).not.toHaveBeenCalled();
    });

    it('referência sem afiliado correspondente ou torta: nada é atribuído e a grant é consumida', async () => {
      const { service, client, state } = setup({
        grants: [
          grant({ id: 'g1', affiliateRef: 'formato-torto', createdAt: new Date('2026-10-30T10:00:00Z') }),
          grant({ id: 'g2', affiliateRef: 'email:desconhecida@exemplo.test' }),
        ],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants.consumed).toBe(2);
      // a torta é pulada; a candidata é a venda com referência válida
      expect(grants.packBridge).toMatchObject({ grantId: 'g2' });
      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });

    it('grant sem referência (venda sem afiliado): sem candidata e nenhuma consulta de afiliado', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: null })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants).toEqual({ consumed: 1, packBridge: null });
      expect(attributedCode).toBeNull();
      expect(client.affiliate.findUnique).not.toHaveBeenCalled();
      expect(client.affiliate.findFirst).not.toHaveBeenCalled();
    });

    it('duas vendas com afiliados diferentes: vale o da venda mais antiga', async () => {
      const { service, client, state } = setup({
        grants: [
          grant({ id: 'g-nova', affiliateRef: 'ppcode:PPOUTRA', createdAt: new Date('2026-11-01T18:00:00Z') }),
          grant({ id: 'g-antiga', affiliateRef: 'ppcode:PPAJFTR', createdAt: new Date('2026-11-01T10:00:00Z') }),
        ],
        users: [buyer(), partnerUser(), partnerUser({ id: 'outra-user', email: 'outra@exemplo.test' })],
        affiliates: [
          partner(),
          partner({ id: 'aff-2', code: 'OUTRA', userId: 'outra-user', perfectpayAffiliateEmail: null, perfectpayAffiliateCode: 'PPOUTRA' }),
        ],
      });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants.consumed).toBe(2);
      expect(grants.packBridge).toMatchObject({ grantId: 'g-antiga', affiliateRef: 'ppcode:PPAJFTR' });
      expect(attributedCode).toBe('PARCEIRA');
      expect(state.grants.find((row) => row.id === 'g-nova')?.attributedAffiliateCode).toBeNull();
    });

    it('a venda mais antiga é de afiliado que não está na plataforma: a mais nova não herda a conta', async () => {
      const { service, client, state } = setup({
        grants: [
          grant({ id: 'g-antiga', affiliateRef: 'ppcode:PPSEMDONO', createdAt: new Date('2026-11-01T10:00:00Z') }),
          grant({ id: 'g-nova', affiliateRef: 'ppcode:PPAJFTR', createdAt: new Date('2026-11-01T18:00:00Z') }),
        ],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants.packBridge).toMatchObject({ grantId: 'g-antiga' });
      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });

    it('só é candidata a grant cuja reserva deu certo (outro processo consumiu antes)', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR', consumedByUserId: 'outro' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      // leu a grant como livre antes de o outro processo marcar
      client.pendingFreeGenerationGrant.findMany.mockResolvedValueOnce([{ ...state.grants[0], consumedByUserId: null }]);

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants).toEqual({ consumed: 0, packBridge: null });
      expect(attributedCode).toBeNull();
      expect(client.affiliate.findUnique).not.toHaveBeenCalled();
    });

    it('createPending sem referência grava a grant como sempre (sem a coluna nova)', async () => {
      const { service, client } = setup({ grants: [], users: [], affiliates: [] });

      await service.createPending({ email: 'x@mail.com', bundle: { NB2: 2 }, source: 'hubla', externalEventId: 'e1' });
      await service.createPending({ email: 'y@mail.com', bundle: { NB2: 2 }, source: 'hubla', externalEventId: 'e2', affiliateRef: null });

      for (const [args] of client.pendingFreeGenerationGrant.create.mock.calls as any[][]) {
        expect(args.data).not.toHaveProperty('affiliateRef');
      }
    });
  });

  describe('autoindicação: o comprador é o próprio afiliado', () => {
    const selfCases: Array<[string, Partial<AffiliateRow>, Partial<UserRow>]> = [
      ['e-mail da Perfect Pay do afiliado', { perfectpayAffiliateEmail: 'Buyer@Mail.com' }, {}],
      ['e-mail da conta do afiliado', {}, { email: 'BUYER@mail.com' }],
      ['e-mail de recebimento (PayPal/Wise) do afiliado', { payoutEmail: 'buyer@MAIL.com' }, {}],
      ['chave Pix do tipo e-mail do afiliado', { pixKeyType: 'EMAIL', pixKey: 'buyer@mail.com' }, {}],
    ];

    it.each(selfCases)('e-mail do comprador igual ao %s: não atribui', async (_label, affiliateExtra, partnerExtra) => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser(partnerExtra)],
        affiliates: [partner(affiliateExtra)],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
      expect(client.user.updateMany).not.toHaveBeenCalled();
    });

    it('a conta nova é a do próprio afiliado (affiliate.userId): não vira cliente de si mesmo', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', email: 'outro-email@mail.com', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [partnerUser({ email: 'outro-email@mail.com', createdAt: SIGNUP_AT })],
        affiliates: [partner()],
      });

      const { grants, attributedCode } = await signup(service, client, state, 'partner-user');

      expect(grants.consumed).toBe(1);
      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });

    it('chave Pix que não é e-mail não entra na comparação', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner({ pixKeyType: 'RANDOM', pixKey: 'buyer@mail.com' })],
      });

      const { attributedCode } = await signup(service, client, state);

      expect(attributedCode).toBe('PARCEIRA');
    });
  });

  describe('o cadastro nunca falha pela ponte', () => {
    it('erro ao procurar o afiliado: devolve null, avisa no log com o e-mail mascarado e não lança', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      client.affiliate.findUnique.mockRejectedValue(new Error('conexão caiu'));

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants.consumed).toBe(1);
      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
      const messages = warn.mock.calls.map(([message]) => String(message));
      expect(messages.some((message) => message.includes('conexão caiu') && message.includes('bu***@mail.com'))).toBe(true);
      expect(messages.join(' ')).not.toContain('buyer@mail.com');
    });

    it('erro ao gravar na conta: a marca da isca não fica e nada é lançado', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      // transação de verdade desfaz a marca quando a gravação seguinte falha
      client.$transaction.mockImplementation(async (fn: any) => {
        const snapshot = state.grants.map((row) => ({ ...row }));
        try {
          return await fn(client);
        } catch (error) {
          state.grants.splice(0, state.grants.length, ...snapshot);
          throw error;
        }
      });
      const grants = await service.consumeForSignup('buyer-1', 'buyer@mail.com', client);
      client.user.updateMany.mockRejectedValue(new Error('deadlock'));

      const attributedCode = await service.attributeSignupToPackAffiliate(
        { id: 'buyer-1', createdAt: SIGNUP_AT },
        grants.packBridge,
      );

      expect(attributedCode).toBeNull();
      expect(state.grants[0].attributedAffiliateCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });

    it('a transação do cadastro só consome: nenhuma leitura de afiliado nem gravação na conta dentro dela', async () => {
      const { service, client } = setup({
        grants: [grant({ id: 'g1', affiliateRef: 'ppcode:PPAJFTR|email:parceira.pp@exemplo.test' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });

      const grants = await service.consumeForSignup('buyer-1', 'buyer@mail.com', client);

      expect(grants).toEqual({
        consumed: 1,
        packBridge: {
          grantId: 'g1',
          affiliateRef: 'ppcode:PPAJFTR|email:parceira.pp@exemplo.test',
          buyerEmail: 'buyer@mail.com',
          grantCreatedAt: SALE_AT,
        },
      });
      expect(client.affiliate.findUnique).not.toHaveBeenCalled();
      expect(client.affiliate.findFirst).not.toHaveBeenCalled();
      expect(client.user.updateMany).not.toHaveBeenCalled();
      expect(client.payment.findFirst).not.toHaveBeenCalled();
    });

    it('sem venda candidata não consulta nada', async () => {
      const { service, client } = setup({ grants: [], users: [buyer()], affiliates: [partner()] });

      await expect(
        service.attributeSignupToPackAffiliate({ id: 'buyer-1', createdAt: SIGNUP_AT }, null),
      ).resolves.toBeNull();
      await expect(
        service.attributeSignupToPackAffiliate({ id: 'buyer-1', createdAt: SIGNUP_AT }, undefined),
      ).resolves.toBeNull();
      expect(client.affiliate.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('reembolso do Pack', () => {
    it('venda reembolsada antes do cadastro nunca atribui (a referência sai da isca)', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', externalEventId: 'perfectpay-sale-ABC', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });

      const refund = await service.revokeForRefund('perfectpay-sale-ABC', 'refund');
      expect(refund.grants).toBe(1);
      expect(state.grants[0]).toMatchObject({ source: 'perfectpay:refunded', affiliateRef: null, bundle: {} });

      const { grants, attributedCode } = await signup(service, client, state);

      expect(grants).toEqual({ consumed: 1, packBridge: null });
      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
    });

    it('grant com source ":refunded" não é candidata nem que ainda traga referência', async () => {
      for (const source of ['perfectpay:refunded', 'hubla:refunded']) {
        const { service, client, state } = setup({
          grants: [grant({ id: 'g1', source, affiliateRef: 'ppcode:PPAJFTR' })],
          users: [buyer(), partnerUser()],
          affiliates: [partner()],
        });

        const { grants, attributedCode } = await signup(service, client, state);

        expect(grants).toEqual({ consumed: 1, packBridge: null });
        expect(attributedCode).toBeNull();
        expect(state.users[0].referredByCode).toBeNull();
      }
    });

    it('reembolso depois do cadastro desfaz a atribuição que ESTA venda fez', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', externalEventId: 'perfectpay-sale-ABC', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      await signup(service, client, state);
      expect(state.users[0].referredByCode).toBe('PARCEIRA');

      const refund = await service.revokeForRefund('perfectpay-sale-ABC', 'chargeback');

      expect(refund.grants).toBe(1);
      expect(state.grants[0]).toMatchObject({ source: 'perfectpay:refunded', affiliateRef: null });
      expect(state.users[0].referredByCode).toBeNull();
      expect(client.user.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'buyer-1', referredByCode: 'PARCEIRA' },
        data: { referredByCode: null },
      });
    });

    it('reembolso não tira afiliado que veio de outro lugar (link de convite ou outra venda)', async () => {
      const { service, client, state } = setup({
        grants: [
          grant({ id: 'g1', externalEventId: 'perfectpay-sale-ABC', affiliateRef: 'ppcode:PPAJFTR', consumedByUserId: 'buyer-1' }),
        ],
        users: [buyer({ referredByCode: 'OUTRA' }), partnerUser()],
        affiliates: [partner()],
      });

      await service.revokeForRefund('perfectpay-sale-ABC', 'refund');

      expect(state.users[0].referredByCode).toBe('OUTRA');
      expect(client.user.updateMany).not.toHaveBeenCalled();
    });

    it('a conta trocou de afiliado depois (admin): o reembolso só desfaz se ainda for o mesmo código', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', externalEventId: 'perfectpay-sale-ABC', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      await signup(service, client, state);
      state.users[0].referredByCode = 'OUTRA';

      await service.revokeForRefund('perfectpay-sale-ABC', 'refund');

      expect(state.users[0].referredByCode).toBe('OUTRA');
    });

    it('reembolso entre o commit do cadastro e a atribuição: a venda já reembolsada não atribui', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', externalEventId: 'perfectpay-sale-ABC', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      const grants = await service.consumeForSignup('buyer-1', 'buyer@mail.com', client);
      await service.revokeForRefund('perfectpay-sale-ABC', 'refund');

      const attributedCode = await service.attributeSignupToPackAffiliate(
        { id: 'buyer-1', createdAt: SIGNUP_AT },
        grants.packBridge,
      );

      expect(attributedCode).toBeNull();
      expect(state.users[0].referredByCode).toBeNull();
      expect(state.grants[0].attributedAffiliateCode).toBeNull();
    });

    it('segundo postback do reembolso não mexe em mais nada', async () => {
      const { service, client, state } = setup({
        grants: [grant({ id: 'g1', externalEventId: 'perfectpay-sale-ABC', affiliateRef: 'ppcode:PPAJFTR' })],
        users: [buyer(), partnerUser()],
        affiliates: [partner()],
      });
      await signup(service, client, state);
      await service.revokeForRefund('perfectpay-sale-ABC', 'refund');
      state.users[0].referredByCode = 'PARCEIRA'; // voltou a ser dela por outro caminho

      const again = await service.revokeForRefund('perfectpay-sale-ABC', 'refund');

      expect(again.grants).toBe(0);
      expect(state.users[0].referredByCode).toBe('PARCEIRA');
    });
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

  /** Postback no formato da documentação: `commission` em lista, `metadata` com src/utm, `customer` objeto. */
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
      {
        affiliation_code: 'PPAJFTR',
        affiliation_type_enum: 5,
        name: 'Parceira',
        email: 'Parceira.PP@exemplo.test',
        identification_number: '07958658745',
        commission_amount: 9,
      },
      { affiliation_code: 'PPAGSDE', affiliation_type_enum: 1, name: 'Produtor', email: 'produtor@casa.test', commission_amount: 3 },
      { affiliation_type_enum: 0, name: 'PerfectPay', commission_amount: 0.99 },
    ],
    metadata: { src: null, utm_source: 'ig', utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null, utm_perfect: null },
    ...extra,
  });
  const ON = { PACK_AFFILIATE_BRIDGE_ENABLED: 'true' };

  it('flag desligada (padrão): a grant nasce sem referência, como hoje', async () => {
    for (const flag of [undefined, '', 'false']) {
      const { service, pendingGrantsService, storedRef } = webhook({ PACK_AFFILIATE_BRIDGE_ENABLED: flag });

      const result = await service.handle(packSale());

      expect(result.processed).toBe(true);
      expect(pendingGrantsService.createPending).toHaveBeenCalledTimes(1);
      expect(storedRef()).toBeNull();
    }
  });

  it('flag ligada: guarda o código da Perfect Pay (ppcode) e o e-mail do afiliado da venda', async () => {
    const { service, pendingGrantsService, storedRef } = webhook(ON);

    await service.handle(packSale());

    expect(storedRef()).toBe('ppcode:PPAJFTR|email:parceira.pp@exemplo.test');
    expect((pendingGrantsService.createPending.mock.calls as any[][])[0][0]).toMatchObject({
      email: 'buyer@mail.com',
      source: 'perfectpay',
      externalEventId: 'perfectpay-sale-PPCPMTB123',
    });
  });

  it('e-mail ofuscado no postback: guarda só o ppcode', async () => {
    const { service, storedRef } = webhook(ON);
    const [affiliateLine, ...otherLines] = packSale().commission;

    await service.handle(
      packSale({
        commission: [
          { ...affiliateLine, email: 'pa***@exemplo.test' },
          ...otherLines,
        ],
      }),
    );

    expect(storedRef()).toBe('ppcode:PPAJFTR');
  });

  it('venda sem afiliado: sem referência', async () => {
    const { service, storedRef } = webhook(ON);

    await service.handle(packSale({ commission: packSale().commission.slice(1) }));

    expect(storedRef()).toBeNull();
  });

  it('código do link (src=convite:CODIGO): ignorado por padrão', async () => {
    const { service, storedRef } = webhook(ON);

    await service.handle(packSale({ commission: packSale().commission.slice(1), metadata: { src: 'convite:parceira' } }));

    expect(storedRef()).toBeNull();
  });

  it('código do link com PACK_AFFILIATE_BRIDGE_LINK_CODES=true: vale em venda sem afiliado da Perfect Pay', async () => {
    const { service, storedRef } = webhook({ ...ON, PACK_AFFILIATE_BRIDGE_LINK_CODES: 'true' });

    await service.handle(packSale({ commission: packSale().commission.slice(1), metadata: { src: 'convite:parceira' } }));

    expect(storedRef()).toBe('code:PARCEIRA');
  });

  it('código do link ignorado quando a venda tem afiliado tipo 5, mesmo com a env ligada', async () => {
    const { service, storedRef } = webhook({ ...ON, PACK_AFFILIATE_BRIDGE_LINK_CODES: 'true' });

    await service.handle(packSale({ metadata: { src: 'convite:OUTRA', utm_content: 'aff:OUTRA' } }));

    expect(storedRef()).toBe('ppcode:PPAJFTR|email:parceira.pp@exemplo.test');
  });

  it('produto fora de PERFECTPAY_PACK_PRODUCTS não entra na ponte', async () => {
    const outside = webhook({ ...ON, PERFECTPAY_PACK_PRODUCTS: 'PPPBFJAR,PPPBFHC5' });
    await outside.service.handle(packSale());
    expect(outside.storedRef()).toBeNull();
    expect(outside.pendingGrantsService.createPending).toHaveBeenCalledTimes(1);

    const inside = webhook({ ...ON, PERFECTPAY_PACK_PRODUCTS: 'pppbfjaq, PPPBFJAR' });
    await inside.service.handle(packSale());
    expect(inside.storedRef()).toBe('ppcode:PPAJFTR|email:parceira.pp@exemplo.test');
  });

  it('conta própria como "afiliada" (PERFECTPAY_OWN_ACCOUNT_EMAILS) é ignorada', async () => {
    const { service, storedRef } = webhook({
      ...ON,
      PERFECTPAY_OWN_ACCOUNT_EMAILS: 'produtor@casa.test, PARCEIRA.pp@exemplo.test',
    });

    await service.handle(packSale());

    expect(storedRef()).toBeNull();
  });

  it('linha sem affiliation_type_enum não conta, nem com as contas próprias configuradas', async () => {
    const { service, storedRef } = webhook({ ...ON, PERFECTPAY_OWN_ACCOUNT_EMAILS: 'produtor@casa.test' });

    await service.handle(
      packSale({
        commission: [
          { affiliation_code: 'PPAJFTR', email: 'parceira.pp@exemplo.test', commission_amount: 9 },
          { affiliation_code: 'PPAGSDE', email: 'produtor@casa.test', commission_amount: 3 },
        ],
      }),
    );

    expect(storedRef()).toBeNull();
  });

  it('payload torto no lugar da comissão não derruba o webhook', async () => {
    const { service, storedRef } = webhook({ ...ON, PACK_AFFILIATE_BRIDGE_LINK_CODES: 'true' });

    const result = await service.handle(packSale({ commission: 'lixo', metadata: 7, affiliate: 'PARCEIRA' }));

    expect(result.processed).toBe(true);
    expect(storedRef()).toBeNull();
  });
});
