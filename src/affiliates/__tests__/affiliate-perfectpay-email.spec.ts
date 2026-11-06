import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AffiliatesService } from '../affiliates.service';
import { CreateAffiliateDto } from '../dto/create-affiliate.dto';
import { UpdateAffiliateDto } from '../dto/update-affiliate.dto';
import { UpdatePayoutDto } from '../dto/update-payout.dto';

/**
 * E-mail e código do afiliado na Perfect Pay (ponte Pack → plataforma): decidem para quem vai
 * o cliente que comprou o Pack por afiliado. Só o admin grava; pelo autoatendimento alguém
 * poderia pôr o e-mail ou o código de outro afiliado e ficar com as vendas dele.
 */
describe('perfectpayAffiliateEmail e perfectpayAffiliateCode · só o admin define', () => {
  interface AffiliateRow {
    id: string;
    code: string;
    name: string;
    userId: string | null;
    perfectpayAffiliateEmail: string | null;
    perfectpayAffiliateCode?: string | null;
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
          if (where.perfectpayAffiliateCode !== undefined) {
            return rows.find((row) => (row.perfectpayAffiliateCode ?? null) === where.perfectpayAffiliateCode) ?? null;
          }
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
    perfectpayAffiliateCode: 'PPAJFTR',
    discountPercent: null,
    stripeCouponId: null,
    stripePromotionCodeId: null,
    ...extra,
  });

  const uniqueViolation = (target: string[]) =>
    Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

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

  it('admin cria e edita o código da Perfect Pay, em maiúsculas; null remove', async () => {
    const { service, prisma } = setup([existing({ perfectpayAffiliateCode: null })]);

    await service.create({ name: 'Nova', code: 'nova', perfectpayAffiliateCode: ' ppnova1 ' } as never);
    expect(prisma.affiliate.create.mock.calls[0][0].data).toMatchObject({
      code: 'NOVA',
      perfectpayAffiliateCode: 'PPNOVA1',
    });

    await service.update('aff-1', { perfectpayAffiliateCode: 'ppajftr' } as never);
    await service.update('aff-1', { perfectpayAffiliateCode: null } as never);
    await service.update('aff-1', { name: 'Só o nome' } as never);

    const sent = (prisma.affiliate.update.mock.calls as any[][]).map(([args]) => args.data);
    expect(sent[0]).toEqual({ perfectpayAffiliateCode: 'PPAJFTR' });
    expect(sent[1]).toEqual({ perfectpayAffiliateCode: null });
    expect(sent[2]).toEqual({ name: 'Só o nome' });
  });

  it('criação sem o código não manda a coluna', async () => {
    const { service, prisma } = setup();

    await service.create({ name: 'Nova', code: 'NOVA' } as never);

    expect(prisma.affiliate.create.mock.calls[0][0].data).not.toHaveProperty('perfectpayAffiliateCode');
  });

  it('código da Perfect Pay que já está em outro afiliado dá conflito (criação e edição)', async () => {
    const { service, prisma } = setup([
      existing(),
      existing({ id: 'aff-2', code: 'OUTRA', perfectpayAffiliateEmail: null, perfectpayAffiliateCode: null }),
    ]);

    await expect(
      service.create({ name: 'Nova', code: 'NOVA', perfectpayAffiliateCode: 'ppajftr' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.affiliate.create).not.toHaveBeenCalled();

    await expect(
      service.update('aff-2', { perfectpayAffiliateCode: 'PPAJFTR' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.affiliate.update).not.toHaveBeenCalled();

    // regravar o próprio código não é conflito
    await service.update('aff-1', { perfectpayAffiliateCode: 'PPAJFTR' } as never);
    expect(prisma.affiliate.update).toHaveBeenCalledTimes(1);
  });

  it('o código da Perfect Pay não disputa espaço com o código da plataforma', async () => {
    // Existe um afiliado cujo code da plataforma é "PPAJFTR": outro afiliado pode ter PPAJFTR como código da Perfect Pay.
    const { service, prisma } = setup([
      existing({ id: 'aff-x', code: 'PPAJFTR', perfectpayAffiliateEmail: null, perfectpayAffiliateCode: null }),
      existing({ id: 'aff-2', code: 'OUTRA', perfectpayAffiliateEmail: null, perfectpayAffiliateCode: null }),
    ]);

    await service.update('aff-2', { perfectpayAffiliateCode: 'PPAJFTR' } as never);

    expect(prisma.affiliate.update.mock.calls[0][0].data).toEqual({ perfectpayAffiliateCode: 'PPAJFTR' });
  });

  it('corrida entre dois admins: o índice único (P2002) vira 409, não 500', async () => {
    const racing = setup([existing({ id: 'aff-2', code: 'OUTRA', perfectpayAffiliateEmail: null, perfectpayAffiliateCode: null })]);

    racing.prisma.affiliate.update.mockRejectedValueOnce(uniqueViolation(['perfectpay_affiliate_code']));
    const byCode = racing.service.update('aff-2', { perfectpayAffiliateCode: 'PPNOVO1' } as never);
    await expect(byCode).rejects.toBeInstanceOf(ConflictException);
    await expect(byCode).rejects.toMatchObject({ message: expect.stringContaining('código da Perfect Pay') });

    racing.prisma.affiliate.update.mockRejectedValueOnce(uniqueViolation(['perfectpay_affiliate_email']));
    const byEmail = racing.service.update('aff-2', { perfectpayAffiliateEmail: 'nova.pp@exemplo.test' } as never);
    await expect(byEmail).rejects.toBeInstanceOf(ConflictException);
    await expect(byEmail).rejects.toMatchObject({ message: expect.stringContaining('e-mail da Perfect Pay') });

    racing.prisma.affiliate.create.mockRejectedValueOnce(uniqueViolation(['perfectpay_affiliate_email']));
    await expect(
      racing.service.create({ name: 'Nova', code: 'NOVA', perfectpayAffiliateEmail: 'nova.pp@exemplo.test' } as never),
    ).rejects.toBeInstanceOf(ConflictException);

    racing.prisma.affiliate.create.mockRejectedValueOnce(uniqueViolation(['perfectpay_affiliate_code']));
    await expect(
      racing.service.create({ name: 'Nova', code: 'NOVA2', perfectpayAffiliateCode: 'PPNOVO1' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('erro que não é de índice único segue como veio', async () => {
    const { service, prisma } = setup([existing()]);
    prisma.affiliate.update.mockRejectedValueOnce(new Error('conexão caiu'));

    await expect(service.update('aff-1', { name: 'X' } as never)).rejects.toThrow('conexão caiu');
  });

  it('autoatendimento nunca grava os campos, nem quando o corpo traz', async () => {
    const { service, prisma } = setup();

    await service.createForUser('user-1', {
      pixKeyType: 'CPF',
      pixKey: '12345678900',
      perfectpayAffiliateEmail: 'parceira.pp@exemplo.test',
      perfectpayAffiliateCode: 'PPAJFTR',
    } as never);
    expect(prisma.affiliate.create.mock.calls[0][0].data).not.toHaveProperty('perfectpayAffiliateEmail');
    expect(prisma.affiliate.create.mock.calls[0][0].data).not.toHaveProperty('perfectpayAffiliateCode');

    const mine = setup([existing({ userId: 'user-1' })]);
    await mine.service.updateMyPayout('user-1', {
      payoutMethod: 'PAYPAL',
      payoutEmail: 'ana@example.com',
      perfectpayAffiliateEmail: 'vitima@exemplo.test',
      perfectpayAffiliateCode: 'PPVITIMA',
    } as never);
    await mine.service.updateMyPixKey('user-1', {
      pixKeyType: 'CPF',
      pixKey: '1',
      perfectpayAffiliateEmail: 'vitima@exemplo.test',
      perfectpayAffiliateCode: 'PPVITIMA',
    } as never);
    for (const [args] of mine.prisma.affiliate.update.mock.calls as any[][]) {
      expect(args.data).not.toHaveProperty('perfectpayAffiliateEmail');
      expect(args.data).not.toHaveProperty('perfectpayAffiliateCode');
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

  it('DTOs: admin aceita e valida o código da Perfect Pay; o do autoatendimento recusa o campo', async () => {
    const errorsOf = async (dtoClass: new () => object, body: Record<string, unknown>) =>
      (await validate(plainToInstance(dtoClass, body), { whitelist: true, forbidNonWhitelisted: true })).map(
        (error) => error.property,
      );

    const created = plainToInstance(CreateAffiliateDto, { name: 'Nova', code: 'NOVA', perfectpayAffiliateCode: ' ppajftr ' });
    expect(await validate(created, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    expect(created.perfectpayAffiliateCode).toBe('PPAJFTR');

    for (const invalid of ['A', 'cod!go', 'com espaco', 'x'.repeat(41), 'ppcode:PPAJFTR', 'a|b', 12345]) {
      expect(await errorsOf(CreateAffiliateDto, { name: 'Nova', code: 'NOVA', perfectpayAffiliateCode: invalid })).toEqual([
        'perfectpayAffiliateCode',
      ]);
    }

    expect(await errorsOf(UpdateAffiliateDto, { perfectpayAffiliateCode: 'PPAJFTR' })).toEqual([]);
    expect(await errorsOf(UpdateAffiliateDto, { perfectpayAffiliateCode: null })).toEqual([]);
    expect(await errorsOf(UpdateAffiliateDto, { perfectpayAffiliateCode: 'cod!go' })).toEqual(['perfectpayAffiliateCode']);

    expect(
      await errorsOf(UpdatePayoutDto, {
        payoutMethod: 'PAYPAL',
        payoutEmail: 'ana@example.com',
        perfectpayAffiliateCode: 'PPVITIMA',
      }),
    ).toEqual(['perfectpayAffiliateCode']);
  });

  it('getMyAffiliate não devolve o e-mail nem o código da Perfect Pay', async () => {
    const prisma = {
      affiliate: { findFirst: jest.fn(async () => ({ ...existing(), commissionPercent: 20, isActive: true, createdAt: new Date() })) },
      affiliateEarning: {
        aggregate: jest.fn(async () => ({ _sum: { amountCents: null, commissionCents: null }, _count: 0 })),
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async () => []),
      },
      payment: { groupBy: jest.fn(async () => []) },
      user: { count: jest.fn(async () => 0) },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);

    const result = await service.getMyAffiliate('partner-user');

    expect(result?.affiliate).not.toHaveProperty('perfectpayAffiliateEmail');
    expect(result?.affiliate).not.toHaveProperty('perfectpayAffiliateCode');
    expect(JSON.stringify(result)).not.toContain('parceira.pp@exemplo.test');
    expect(JSON.stringify(result)).not.toContain('PPAJFTR');
  });
});
