import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AffiliatesService } from '../affiliates.service';

/**
 * Segundo nível no serviço de afiliados: quem é o pai (autoatendimento pelo
 * referredByCode, admin pelo parentAffiliateCode) e o resumo no painel do afiliado.
 */
type AffiliateRow = {
  id: string;
  code: string;
  userId?: string | null;
  isActive?: boolean;
  parentAffiliateId?: string | null;
};

function affiliateLookup(rows: AffiliateRow[]) {
  return jest.fn(async ({ where }: { where: { code?: string; id?: string } }) => {
    const row = where.code
      ? rows.find((r) => r.code === where.code)
      : rows.find((r) => r.id === where.id);
    return row ?? null;
  });
}

describe('AffiliatesService.createForUser · pai pelo código de indicação', () => {
  function setup(opts: { referredByCode?: string | null; affiliates?: AffiliateRow[] }) {
    const prisma = {
      affiliate: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: affiliateLookup(opts.affiliates ?? []),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'aff-novo', ...data })),
      },
      referralCode: { findUnique: jest.fn().mockResolvedValue(null) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          name: 'Nova Afiliada',
          email: 'nova@exemplo.test',
          emailVerified: true,
          referredByCode: opts.referredByCode ?? null,
        }),
      },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }
  const payout = { pixKey: 'x@exemplo.test', pixKeyType: 'EMAIL' } as never;

  it('sem código de indicação: sem pai (o campo nem vai no create, como hoje)', async () => {
    const { service, prisma } = setup({});
    const created = await service.createForUser('user-nova', payout);
    expect(created).not.toHaveProperty('parentAffiliateId');
    expect(prisma.affiliate.findUnique).not.toHaveBeenCalled();
  });

  it('código de afiliado ativo vira pai', async () => {
    const { service, prisma } = setup({
      referredByCode: 'PARCEIRA',
      affiliates: [{ id: 'aff-pai', code: 'PARCEIRA', userId: 'user-pai', isActive: true }],
    });
    const created = await service.createForUser('user-nova', payout);
    expect(created.parentAffiliateId).toBe('aff-pai');
    expect(prisma.user.findUnique.mock.calls[0][0].select).toMatchObject({ referredByCode: true });
  });

  it('código que é só indicação de usuário (não afiliado) ou afiliado inativo: sem pai', async () => {
    const semAfiliado = setup({ referredByCode: 'K7Q3M9XP' });
    expect(await semAfiliado.service.createForUser('user-nova', payout)).not.toHaveProperty('parentAffiliateId');

    const inativo = setup({
      referredByCode: 'PARCEIRA',
      affiliates: [{ id: 'aff-pai', code: 'PARCEIRA', userId: 'user-pai', isActive: false }],
    });
    expect(await inativo.service.createForUser('user-nova', payout)).not.toHaveProperty('parentAffiliateId');
  });

  it('o próprio afiliado como pai (código do próprio usuário) é ignorado', async () => {
    const { service } = setup({
      referredByCode: 'EUMESMA',
      affiliates: [{ id: 'aff-eu', code: 'EUMESMA', userId: 'user-nova', isActive: true }],
    });
    expect(await service.createForUser('user-nova', payout)).not.toHaveProperty('parentAffiliateId');
  });
});

describe('AffiliatesService admin · parentAffiliateCode', () => {
  const tree: AffiliateRow[] = [
    { id: 'aff-pai', code: 'PAI', isActive: true, parentAffiliateId: null },
    { id: 'aff-filho', code: 'FILHO', isActive: true, parentAffiliateId: 'aff-pai' },
    { id: 'aff-neto', code: 'NETO', isActive: true, parentAffiliateId: 'aff-filho' },
  ];

  function setup(rows: AffiliateRow[] = tree) {
    const prisma = {
      affiliate: {
        findUnique: affiliateLookup(rows),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'aff-novo', ...data })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'x', ...data })),
      },
      referralCode: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }

  it('create: pai resolvido pelo código (maiúsculas), gravado como id', async () => {
    const { service, prisma } = setup();
    await service.create({ name: 'Nova', code: 'NOVA', parentAffiliateCode: 'pai' } as never);
    expect(prisma.affiliate.create.mock.calls[0][0].data).toMatchObject({ code: 'NOVA', parentAffiliateId: 'aff-pai' });
  });

  it('create sem pai não manda o campo (como hoje)', async () => {
    const { service, prisma } = setup();
    await service.create({ name: 'Nova', code: 'NOVA' } as never);
    expect(prisma.affiliate.create.mock.calls[0][0].data).not.toHaveProperty('parentAffiliateId');
  });

  it('create: código de pai inexistente dá 404 e nada é criado', async () => {
    const { service, prisma } = setup();
    await expect(
      service.create({ name: 'Nova', code: 'NOVA', parentAffiliateCode: 'NAOEXISTE' } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.affiliate.create).not.toHaveBeenCalled();
  });

  it('update: o próprio afiliado como pai dá 400', async () => {
    const { service, prisma } = setup();
    await expect(service.update('aff-filho', { parentAffiliateCode: 'FILHO' } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.affiliate.update).not.toHaveBeenCalled();
  });

  it('update: pai que é descendente do afiliado (ciclo) dá 400', async () => {
    const { service, prisma } = setup();
    await expect(service.update('aff-pai', { parentAffiliateCode: 'NETO' } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.affiliate.update).not.toHaveBeenCalled();
  });

  it('update: árvore com mais de 10 níveis acima é recusada', async () => {
    const deep: AffiliateRow[] = [{ id: 'aff-alvo', code: 'ALVO', isActive: true, parentAffiliateId: null }];
    for (let i = 0; i < 12; i++) {
      deep.push({ id: `aff-${i}`, code: `N${i}`, isActive: true, parentAffiliateId: i === 0 ? null : `aff-${i - 1}` });
    }
    const { service } = setup(deep);
    await expect(service.update('aff-alvo', { parentAffiliateCode: 'N11' } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('update: pai válido grava o id; null remove; ausente não mexe', async () => {
    const { service, prisma } = setup();

    await service.update('aff-neto', { parentAffiliateCode: 'PAI' } as never);
    expect(prisma.affiliate.update.mock.calls[0][0].data).toMatchObject({ parentAffiliateId: 'aff-pai' });

    await service.update('aff-neto', { parentAffiliateCode: null } as never);
    expect(prisma.affiliate.update.mock.calls[1][0].data).toMatchObject({ parentAffiliateId: null });

    await service.update('aff-neto', { name: 'Neto' } as never);
    expect(prisma.affiliate.update.mock.calls[2][0].data).not.toHaveProperty('parentAffiliateId');
  });
});

describe('AffiliatesService.getMyAffiliate · secondLevel', () => {
  const ORIGINAL = process.env.AFFILIATE_SECOND_LEVEL_PERCENT;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AFFILIATE_SECOND_LEVEL_PERCENT;
    else process.env.AFFILIATE_SECOND_LEVEL_PERCENT = ORIGINAL;
  });

  const me = { id: 'aff-pai', code: 'PAI', name: 'Pai', commissionPercent: 30, isActive: true, createdAt: new Date() };
  const direct = {
    id: 'ae-1',
    amountCents: 3792,
    commissionCents: 1138,
    currency: 'USD',
    status: 'PENDING',
    paidAt: null,
    createdAt: new Date(),
    level: 1,
    sourceEarningId: null,
    user: { name: 'Cliente Direta', email: 'direta@exemplo.test' },
    payment: { type: 'SUBSCRIPTION', amountCents: 3990, currency: 'USD', subscription: null, creditPackage: null },
  };
  const fromChild = {
    ...direct,
    id: 'ae-3',
    commissionCents: 57,
    level: 2,
    sourceEarningId: 'ae-2',
    user: { name: 'Cliente Do Filho', email: 'filho.cliente@exemplo.test' },
  };
  const legacy = { ...direct, id: 'ae-0', level: null, sourceEarningId: null };

  function setup() {
    const prisma = {
      affiliate: {
        findFirst: jest.fn().mockResolvedValue(me),
        count: jest.fn(async () => 2),
      },
      affiliateEarning: {
        aggregate: jest.fn(async ({ where }: any) =>
          where.level === 2
            ? { _sum: { commissionCents: 57, amountCents: 3792 }, _count: 1 }
            : { _sum: { commissionCents: 1195, amountCents: 7584 }, _count: 2 },
        ),
        groupBy: jest.fn(async ({ by, where }: any) => {
          if (by.includes('userId')) return [{ userId: 'u1' }, { userId: 'u2' }];
          // Só a janela já madura devolve linha, para o total por moeda não sair em dobro.
          if (!by.includes('currency') || !where.createdAt?.lte) return [];
          return [
            {
              affiliateId: 'aff-pai',
              currency: 'USD',
              status: 'PENDING',
              _sum: where.level === 2 ? { amountCents: 3792, commissionCents: 57 } : { amountCents: 7584, commissionCents: 1195 },
            },
          ];
        }),
        findMany: jest.fn(async ({ where }: any) =>
          where.id ? [{ id: 'ae-2', affiliate: { code: 'FILHO' } }] : [fromChild, direct, legacy],
        ),
      },
      payment: { groupBy: jest.fn(async () => []) },
      user: { count: jest.fn(async () => 5) },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }

  it('ligado: resumo do segundo nível e o código do filho em cada comissão de nível 2', async () => {
    process.env.AFFILIATE_SECOND_LEVEL_PERCENT = '5';
    const { service, prisma } = setup();

    const result = await service.getMyAffiliate('user-pai');

    expect(result?.summary.secondLevel).toEqual({
      enabled: true,
      percent: 5,
      childrenCount: 2,
      commissionCents: 57,
      byCurrency: [
        expect.objectContaining({ currency: 'USD', totalCommissionCents: 57, totalRevenueCents: 3792 }),
      ],
    });
    // Os totais de sempre seguem somando os dois níveis.
    expect(result?.summary.totalCommissionCents).toBe(1195);
    expect(prisma.affiliate.count).toHaveBeenCalledWith({ where: { parentAffiliateId: 'aff-pai' } });

    const [second, first, old] = result!.earnings as Array<Record<string, any>>;
    expect(second).toMatchObject({ id: 'ae-3', level: 2, fromAffiliate: { code: 'FILHO' } });
    expect(second).not.toHaveProperty('sourceEarningId');
    expect(JSON.stringify(second.fromAffiliate)).not.toContain('@');
    expect(first).toMatchObject({ id: 'ae-1', level: 1 });
    expect(first).not.toHaveProperty('fromAffiliate');
    // Comissão antiga sem nível conta como direta.
    expect(old).toMatchObject({ id: 'ae-0', level: 1 });
    // O código do filho vem da comissão direta que originou a do pai.
    expect(prisma.affiliateEarning.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['ae-2'] } } }),
    );
  });

  it('desligado: o resumo aparece com enabled=false e o histórico segue', async () => {
    delete process.env.AFFILIATE_SECOND_LEVEL_PERCENT;
    const { service } = setup();

    const result = await service.getMyAffiliate('user-pai');

    expect(result?.summary.secondLevel).toMatchObject({ enabled: false, percent: 0, childrenCount: 2, commissionCents: 57 });
    expect(result?.earnings).toHaveLength(3);
  });
});
