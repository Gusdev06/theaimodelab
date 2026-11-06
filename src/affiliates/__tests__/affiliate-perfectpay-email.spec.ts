import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AffiliatesService } from '../affiliates.service';
import { CreateAffiliateDto } from '../dto/create-affiliate.dto';
import { UpdateAffiliateDto } from '../dto/update-affiliate.dto';
import { UpdatePayoutDto } from '../dto/update-payout.dto';

/**
 * E-mail do afiliado na Perfect Pay (ponte Pack → plataforma): decide para quem vai o cliente
 * que comprou o Pack por afiliado. Só o admin grava; pelo autoatendimento alguém poderia
 * pôr o e-mail de outro afiliado e ficar com as vendas dele.
 */
describe('perfectpayAffiliateEmail · só o admin define', () => {
  interface AffiliateRow {
    id: string;
    code: string;
    name: string;
    userId: string | null;
    perfectpayAffiliateEmail: string | null;
    discountPercent: number | null;
    stripeCouponId: string | null;
    stripePromotionCodeId: string | null;
  }

  function setup(rows: AffiliateRow[] = []) {
    const prisma = {
      affiliate: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.id !== undefined) return rows.find((row) => row.id === where.id) ?? null;
          if (where.code !== undefined) return rows.find((row) => row.code === where.code) ?? null;
          return rows.find((row) => row.perfectpayAffiliateEmail === where.perfectpayAffiliateEmail) ?? null;
        }),
        findFirst: jest.fn(async ({ where }: any) => rows.find((row) => row.userId === where.userId) ?? null),
        create: jest.fn(async ({ data }: any) => ({ id: 'aff-new', ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
      referralCode: { findUnique: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => ({ name: 'Ana', email: 'ana@example.com', emailVerified: true })) },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);
    return { service, prisma };
  }

  const existing = (extra: Partial<AffiliateRow> = {}): AffiliateRow => ({
    id: 'aff-1',
    code: 'PARCEIRA',
    name: 'Parceira',
    userId: 'partner-user',
    perfectpayAffiliateEmail: 'parceira.pp@exemplo.test',
    discountPercent: null,
    stripeCouponId: null,
    stripePromotionCodeId: null,
    ...extra,
  });

  it('admin cria o afiliado com o e-mail da Perfect Pay, em minúsculas', async () => {
    const { service, prisma } = setup();

    await service.create({ name: 'Nova', code: 'nova', perfectpayAffiliateEmail: ' Nova.PP@Exemplo.test ' } as never);

    expect(prisma.affiliate.create.mock.calls[0][0].data).toMatchObject({
      code: 'NOVA',
      perfectpayAffiliateEmail: 'nova.pp@exemplo.test',
    });
  });

  it('criação sem o campo não manda a coluna', async () => {
    const { service, prisma } = setup();

    await service.create({ name: 'Nova', code: 'NOVA' } as never);

    expect(prisma.affiliate.create.mock.calls[0][0].data).not.toHaveProperty('perfectpayAffiliateEmail');
  });

  it('e-mail da Perfect Pay que já está em outro afiliado dá conflito (criação e edição)', async () => {
    const { service, prisma } = setup([existing(), existing({ id: 'aff-2', code: 'OUTRA', perfectpayAffiliateEmail: null })]);

    await expect(
      service.create({ name: 'Nova', code: 'NOVA', perfectpayAffiliateEmail: 'PARCEIRA.pp@exemplo.test' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.affiliate.create).not.toHaveBeenCalled();

    await expect(
      service.update('aff-2', { perfectpayAffiliateEmail: 'parceira.pp@exemplo.test' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.affiliate.update).not.toHaveBeenCalled();
  });

  it('admin edita, regrava o mesmo e-mail no próprio afiliado e remove com null', async () => {
    const { service, prisma } = setup([existing()]);

    await service.update('aff-1', { perfectpayAffiliateEmail: 'Outro.PP@exemplo.test' } as never);
    await service.update('aff-1', { perfectpayAffiliateEmail: 'parceira.pp@exemplo.test' } as never);
    await service.update('aff-1', { perfectpayAffiliateEmail: null } as never);
    await service.update('aff-1', { name: 'Só o nome' } as never);

    const sent = (prisma.affiliate.update.mock.calls as any[][]).map(([args]) => args.data);
    expect(sent[0]).toEqual({ perfectpayAffiliateEmail: 'outro.pp@exemplo.test' });
    expect(sent[1]).toEqual({ perfectpayAffiliateEmail: 'parceira.pp@exemplo.test' });
    expect(sent[2]).toEqual({ perfectpayAffiliateEmail: null });
    expect(sent[3]).toEqual({ name: 'Só o nome' });
  });

  it('autoatendimento nunca grava o campo, nem quando o corpo traz', async () => {
    const { service, prisma } = setup();

    await service.createForUser('user-1', {
      pixKeyType: 'CPF',
      pixKey: '12345678900',
      perfectpayAffiliateEmail: 'parceira.pp@exemplo.test',
    } as never);
    expect(prisma.affiliate.create.mock.calls[0][0].data).not.toHaveProperty('perfectpayAffiliateEmail');

    const mine = setup([existing({ userId: 'user-1' })]);
    await mine.service.updateMyPayout('user-1', {
      payoutMethod: 'PAYPAL',
      payoutEmail: 'ana@example.com',
      perfectpayAffiliateEmail: 'vitima@exemplo.test',
    } as never);
    await mine.service.updateMyPixKey('user-1', {
      pixKeyType: 'CPF',
      pixKey: '1',
      perfectpayAffiliateEmail: 'vitima@exemplo.test',
    } as never);
    for (const [args] of mine.prisma.affiliate.update.mock.calls as any[][]) {
      expect(args.data).not.toHaveProperty('perfectpayAffiliateEmail');
    }
  });

  it('DTOs: admin aceita e valida o e-mail; o do autoatendimento recusa o campo', async () => {
    const errorsOf = async (dtoClass: new () => object, body: Record<string, unknown>) =>
      (await validate(plainToInstance(dtoClass, body), { whitelist: true, forbidNonWhitelisted: true })).map(
        (error) => error.property,
      );

    const created = plainToInstance(CreateAffiliateDto, {
      name: 'Nova',
      code: 'NOVA',
      perfectpayAffiliateEmail: ' Nova.PP@Exemplo.test ',
    });
    expect(await validate(created, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    expect(created.perfectpayAffiliateEmail).toBe('nova.pp@exemplo.test');

    expect(await errorsOf(CreateAffiliateDto, { name: 'Nova', code: 'NOVA' })).toEqual([]);
    expect(
      await errorsOf(CreateAffiliateDto, { name: 'Nova', code: 'NOVA', perfectpayAffiliateEmail: 'sem-arroba' }),
    ).toEqual(['perfectpayAffiliateEmail']);

    expect(await errorsOf(UpdateAffiliateDto, { perfectpayAffiliateEmail: 'a@b.test' })).toEqual([]);
    expect(await errorsOf(UpdateAffiliateDto, { perfectpayAffiliateEmail: null })).toEqual([]);
    expect(await errorsOf(UpdateAffiliateDto, { perfectpayAffiliateEmail: 'sem-arroba' })).toEqual([
      'perfectpayAffiliateEmail',
    ]);

    expect(
      await errorsOf(UpdatePayoutDto, {
        payoutMethod: 'PAYPAL',
        payoutEmail: 'ana@example.com',
        perfectpayAffiliateEmail: 'vitima@exemplo.test',
      }),
    ).toEqual(['perfectpayAffiliateEmail']);
  });

  it('getMyAffiliate não devolve o e-mail da Perfect Pay', async () => {
    const prisma = {
      affiliate: { findFirst: jest.fn(async () => ({ ...existing(), commissionPercent: 20, isActive: true, createdAt: new Date() })) },
      affiliateEarning: {
        aggregate: jest.fn(async () => ({ _sum: { amountCents: null, commissionCents: null }, _count: 0 })),
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async () => []),
      },
      user: { count: jest.fn(async () => 0) },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);

    const result = await service.getMyAffiliate('partner-user');

    expect(result?.affiliate).not.toHaveProperty('perfectpayAffiliateEmail');
    expect(JSON.stringify(result)).not.toContain('parceira.pp@exemplo.test');
  });
});
