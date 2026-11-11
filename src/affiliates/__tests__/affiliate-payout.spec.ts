import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AffiliatesService } from '../affiliates.service';
import {
  describePayoutDestination,
  resolvePayout,
  resolveSelfServiceCommissionPercent,
} from '../affiliate-payout';
import { UpdatePayoutDto } from '../dto/update-payout.dto';

/**
 * Recebimento fora do Brasil: além da chave Pix, o afiliado pode receber por PayPal
 * ou Wise (e-mail da conta). O corpo antigo, só com a chave Pix, continua valendo.
 */
describe('resolvePayout', () => {
  it('PIX explícito', () => {
    expect(resolvePayout({ payoutMethod: 'PIX', pixKeyType: 'CPF', pixKey: ' 12345678900 ' })).toEqual({
      ok: true,
      data: { payoutMethod: 'PIX', payoutEmail: null, pixKey: '12345678900', pixKeyType: 'CPF' },
    });
  });

  it('corpo antigo (sem payoutMethod) vale como PIX', () => {
    expect(resolvePayout({ pixKeyType: 'EMAIL', pixKey: 'ana@exemplo.test' })).toEqual({
      ok: true,
      data: { payoutMethod: 'PIX', payoutEmail: null, pixKey: 'ana@exemplo.test', pixKeyType: 'EMAIL' },
    });
  });

  it('PIX ignora e-mail de PayPal que venha junto', () => {
    const result = resolvePayout({
      payoutMethod: 'PIX',
      pixKeyType: 'RANDOM',
      pixKey: 'chave-aleatoria',
      payoutEmail: 'sobra@exemplo.test',
    });
    expect(result).toMatchObject({ ok: true, data: { payoutEmail: null } });
  });

  it.each(['PAYPAL', 'WISE'])('%s: e-mail em minúsculas e chave Pix limpa', (payoutMethod) => {
    expect(
      resolvePayout({ payoutMethod, payoutEmail: '  Ana.Lopez@Example.COM ', pixKey: 'velha', pixKeyType: 'CPF' }),
    ).toEqual({
      ok: true,
      data: { payoutMethod, payoutEmail: 'ana.lopez@example.com', pixKey: null, pixKeyType: null },
    });
  });

  it.each([
    [{ payoutMethod: 'BOLETO', pixKeyType: 'CPF', pixKey: '1' }],
    [{ payoutMethod: 'paypal', payoutEmail: 'ana@example.com' }],
    [{ payoutMethod: 'PIX', pixKeyType: 'CPF' }],
    [{ payoutMethod: 'PIX', pixKeyType: 'CPF', pixKey: '   ' }],
    [{ payoutMethod: 'PIX', pixKeyType: 'TELEFONE', pixKey: '11999999999' }],
    [{ payoutMethod: 'PIX', pixKeyType: 'CPF', pixKey: 'x'.repeat(141) }],
    [{ pixKey: '12345678900' }],
    [{}],
    [{ payoutMethod: 'PAYPAL' }],
    [{ payoutMethod: 'PAYPAL', payoutEmail: 'sem-arroba' }],
    [{ payoutMethod: 'WISE', payoutEmail: 'ana@semponto' }],
    [{ payoutMethod: 'WISE', payoutEmail: 'ana maria@example.com' }],
    [{ payoutMethod: 'WISE', pixKeyType: 'CPF', pixKey: '12345678900' }],
    [{ payoutMethod: 'PAYPAL', payoutEmail: `${'a'.repeat(250)}@example.com` }],
  ])('recusa %p', (input) => {
    const result = resolvePayout(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('resolveSelfServiceCommissionPercent', () => {
  it.each([undefined, null, '', '  ', '0', '51', '100', '-5', '20.5', '20%', 'abc', '1e1'])(
    'vazio ou inválido (%p) = 20, o de sempre',
    (raw) => {
      expect(resolveSelfServiceCommissionPercent(raw as string | undefined)).toBe(20);
    },
  );

  it('inteiro de 1 a 50 vale', () => {
    expect(resolveSelfServiceCommissionPercent('1')).toBe(1);
    expect(resolveSelfServiceCommissionPercent(' 30 ')).toBe(30);
    expect(resolveSelfServiceCommissionPercent('50')).toBe(50);
  });
});

describe('describePayoutDestination', () => {
  it('sem forma gravada continua falando da chave Pix', () => {
    expect(describePayoutDestination(undefined)).toBe('sua chave Pix cadastrada');
    expect(describePayoutDestination(null)).toBe('sua chave Pix cadastrada');
    expect(describePayoutDestination('PIX')).toBe('sua chave Pix cadastrada');
  });

  it('PayPal e Wise têm a frase certa', () => {
    expect(describePayoutDestination('PAYPAL')).toBe('sua conta PayPal cadastrada');
    expect(describePayoutDestination('WISE')).toBe('sua conta Wise cadastrada');
  });
});

describe('UpdatePayoutDto', () => {
  // Mesmo ValidationPipe global da API: whitelist + recusa de campo desconhecido + transform.
  async function errorsOf(body: Record<string, unknown>) {
    const dto = plainToInstance(UpdatePayoutDto, body);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return { dto, properties: errors.map((error) => error.property).sort() };
  }

  it('PIX explícito e corpo antigo passam', async () => {
    expect((await errorsOf({ payoutMethod: 'PIX', pixKeyType: 'CPF', pixKey: '12345678900' })).properties).toEqual([]);
    expect((await errorsOf({ pixKeyType: 'PHONE', pixKey: '+5511999999999' })).properties).toEqual([]);
  });

  it('PAYPAL e WISE passam com e-mail, que sai em minúsculas e sem espaço', async () => {
    const paypal = await errorsOf({ payoutMethod: 'PAYPAL', payoutEmail: '  Ana@Example.COM ' });
    expect(paypal.properties).toEqual([]);
    expect(paypal.dto.payoutEmail).toBe('ana@example.com');

    expect((await errorsOf({ payoutMethod: 'WISE', payoutEmail: 'ana@example.com' })).properties).toEqual([]);
  });

  it('PIX sem chave ou com tipo inválido é recusado', async () => {
    expect((await errorsOf({ payoutMethod: 'PIX' })).properties).toEqual(['pixKey', 'pixKeyType']);
    expect((await errorsOf({})).properties).toEqual(['pixKey', 'pixKeyType']);
    expect((await errorsOf({ pixKeyType: 'TELEFONE', pixKey: '1' })).properties).toEqual(['pixKeyType']);
    expect((await errorsOf({ pixKeyType: 'CPF', pixKey: '' })).properties).toEqual(['pixKey']);
  });

  it('PAYPAL/WISE sem e-mail válido é recusado; a chave Pix não substitui o e-mail', async () => {
    expect((await errorsOf({ payoutMethod: 'PAYPAL' })).properties).toEqual(['payoutEmail']);
    expect((await errorsOf({ payoutMethod: 'WISE', payoutEmail: 'sem-arroba' })).properties).toEqual(['payoutEmail']);
    expect(
      (await errorsOf({ payoutMethod: 'WISE', pixKeyType: 'CPF', pixKey: '12345678900' })).properties,
    ).toEqual(['payoutEmail']);
  });

  it('forma desconhecida e campo fora do contrato são recusados', async () => {
    expect((await errorsOf({ payoutMethod: 'BOLETO', payoutEmail: 'ana@example.com' })).properties).toContain(
      'payoutMethod',
    );
    expect(
      (await errorsOf({ payoutMethod: 'PAYPAL', payoutEmail: 'ana@example.com', perfectpayAffiliateEmail: 'x@y.com' }))
        .properties,
    ).toEqual(['perfectpayAffiliateEmail']);
    expect(
      (await errorsOf({ pixKeyType: 'CPF', pixKey: '1', commissionPercent: 90 })).properties,
    ).toEqual(['commissionPercent']);
  });
});

describe('AffiliatesService · forma de recebimento', () => {
  const ORIGINAL_PERCENT = process.env.AFFILIATE_SELF_SERVICE_PERCENT;

  afterEach(() => {
    if (ORIGINAL_PERCENT === undefined) delete process.env.AFFILIATE_SELF_SERVICE_PERCENT;
    else process.env.AFFILIATE_SELF_SERVICE_PERCENT = ORIGINAL_PERCENT;
  });

  function setup(opts: {
    existingAffiliate?: Record<string, unknown> | null;
    user?: Record<string, unknown> | null;
  } = {}) {
    const user =
      opts.user === undefined ? { name: 'Ana Lopez', email: 'ana@example.com', emailVerified: true } : opts.user;
    const prisma = {
      affiliate: {
        findFirst: jest.fn(async () => opts.existingAffiliate ?? null),
        create: jest.fn(async ({ data }: any) => ({ id: 'aff-new', ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
      referralCode: { findUnique: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => user) },
    };
    const service = new AffiliatesService(prisma as never, {} as never, {} as never);
    const createdData = () => (prisma.affiliate.create.mock.calls as any[][])[0]?.[0]?.data;
    const updatedData = () => (prisma.affiliate.update.mock.calls as any[][])[0]?.[0]?.data;
    return { service, prisma, createdData, updatedData };
  }

  describe('createForUser', () => {
    it('corpo antigo: vira PIX com 20% (o de sempre)', async () => {
      delete process.env.AFFILIATE_SELF_SERVICE_PERCENT;
      const { service, createdData } = setup();

      await service.createForUser('user-1', { pixKeyType: 'CPF', pixKey: ' 12345678900 ' } as never);

      expect(createdData()).toEqual({
        name: 'Ana Lopez',
        code: 'ANALOPEZ',
        commissionPercent: 20,
        userId: 'user-1',
        payoutMethod: 'PIX',
        payoutEmail: null,
        pixKey: '12345678900',
        pixKeyType: 'CPF',
      });
    });

    it('PAYPAL: grava o e-mail e nenhuma chave Pix', async () => {
      const { service, createdData } = setup();

      await service.createForUser('user-1', { payoutMethod: 'PAYPAL', payoutEmail: 'Ana@Example.com' } as never);

      expect(createdData()).toMatchObject({
        payoutMethod: 'PAYPAL',
        payoutEmail: 'ana@example.com',
        pixKey: null,
        pixKeyType: null,
      });
    });

    it('percentual vem da env AFFILIATE_SELF_SERVICE_PERCENT; env inválida = 20', async () => {
      process.env.AFFILIATE_SELF_SERVICE_PERCENT = '30';
      const withEnv = setup();
      await withEnv.service.createForUser('user-1', { payoutMethod: 'WISE', payoutEmail: 'ana@example.com' } as never);
      expect(withEnv.createdData().commissionPercent).toBe(30);

      process.env.AFFILIATE_SELF_SERVICE_PERCENT = '90';
      const invalidEnv = setup();
      await invalidEnv.service.createForUser('user-1', { pixKeyType: 'CPF', pixKey: '1' } as never);
      expect(invalidEnv.createdData().commissionPercent).toBe(20);
    });

    it('quem já é afiliado recebe 409, antes de qualquer outra checagem', async () => {
      const { service, prisma } = setup({ existingAffiliate: { id: 'aff-1' } });

      await expect(service.createForUser('user-1', {} as never)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.affiliate.create).not.toHaveBeenCalled();
    });

    it('corpo inválido chamando o serviço direto: 400 e nada gravado', async () => {
      const { service, prisma } = setup();

      await expect(
        service.createForUser('user-1', { payoutMethod: 'PAYPAL', payoutEmail: 'sem-arroba' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.createForUser('user-1', { payoutMethod: 'PIX' } as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.affiliate.create).not.toHaveBeenCalled();
    });

    it('conta sem e-mail confirmado não vira afiliada', async () => {
      const { service, prisma } = setup({
        user: { name: 'Ana', email: 'ana@example.com', emailVerified: false },
      });

      const attempt = service.createForUser('user-1', { pixKeyType: 'CPF', pixKey: '12345678900' } as never);

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toMatchObject({ response: { code: 'EMAIL_NOT_VERIFIED' } });
      expect(prisma.affiliate.create).not.toHaveBeenCalled();
    });

    it('usuário inexistente: 404', async () => {
      const { service } = setup({ user: null });
      await expect(
        service.createForUser('fantasma', { pixKeyType: 'CPF', pixKey: '1' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateMyPayout', () => {
    it('troca de PIX para WISE limpa a chave Pix', async () => {
      const { service, prisma, updatedData } = setup({
        existingAffiliate: { id: 'aff-1', pixKey: '12345678900', pixKeyType: 'CPF', payoutMethod: 'PIX' },
      });

      await service.updateMyPayout('user-1', { payoutMethod: 'WISE', payoutEmail: 'ana@example.com' } as never);

      expect(prisma.affiliate.update.mock.calls[0][0].where).toEqual({ id: 'aff-1' });
      expect(updatedData()).toEqual({
        payoutMethod: 'WISE',
        payoutEmail: 'ana@example.com',
        pixKey: null,
        pixKeyType: null,
      });
    });

    it('volta para PIX limpando o e-mail', async () => {
      const { service, updatedData } = setup({
        existingAffiliate: { id: 'aff-1', payoutMethod: 'PAYPAL', payoutEmail: 'ana@example.com' },
      });

      await service.updateMyPayout('user-1', { pixKeyType: 'EMAIL', pixKey: 'ana@example.com' } as never);

      expect(updatedData()).toEqual({
        payoutMethod: 'PIX',
        payoutEmail: null,
        pixKey: 'ana@example.com',
        pixKeyType: 'EMAIL',
      });
    });

    it('quem não é afiliado recebe 404; corpo inválido, 400', async () => {
      const notAffiliate = setup();
      await expect(
        notAffiliate.service.updateMyPayout('user-1', { payoutMethod: 'PAYPAL', payoutEmail: 'a@b.co' } as never),
      ).rejects.toBeInstanceOf(NotFoundException);

      const affiliate = setup({ existingAffiliate: { id: 'aff-1' } });
      await expect(
        affiliate.service.updateMyPayout('user-1', { payoutMethod: 'PAYPAL' } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(affiliate.prisma.affiliate.update).not.toHaveBeenCalled();
    });
  });

  describe('afiliado desativado pelo admin não troca o recebimento', () => {
    const inactive = { id: 'aff-1', isActive: false, payoutMethod: 'PIX', pixKey: '12345678900', pixKeyType: 'CPF' };

    it('updateMyPayout: 403 AFFILIATE_INACTIVE e nada gravado', async () => {
      const { service, prisma } = setup({ existingAffiliate: inactive });

      const attempt = service.updateMyPayout('user-1', { payoutMethod: 'PAYPAL', payoutEmail: 'outra@example.com' } as never);

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toMatchObject({ response: { code: 'AFFILIATE_INACTIVE' } });
      expect(prisma.affiliate.update).not.toHaveBeenCalled();
    });

    it('updateMyPixKey (rota antiga): 403 AFFILIATE_INACTIVE e nada gravado', async () => {
      const { service, prisma } = setup({ existingAffiliate: inactive });

      const attempt = service.updateMyPixKey('user-1', { pixKeyType: 'CPF', pixKey: '99999999999' } as never);

      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toMatchObject({ response: { code: 'AFFILIATE_INACTIVE' } });
      expect(prisma.affiliate.update).not.toHaveBeenCalled();
    });

    it('o 403 vem antes da validação do corpo; afiliado ativo segue trocando', async () => {
      const blocked = setup({ existingAffiliate: inactive });
      await expect(
        blocked.service.updateMyPayout('user-1', { payoutMethod: 'PAYPAL' } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const active = setup({ existingAffiliate: { ...inactive, isActive: true } });
      await active.service.updateMyPayout('user-1', { payoutMethod: 'WISE', payoutEmail: 'ana@example.com' } as never);
      expect(active.prisma.affiliate.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateMyPixKey (rota antiga)', () => {
    it('continua funcionando e marca a forma como PIX', async () => {
      const { service, updatedData } = setup({
        existingAffiliate: { id: 'aff-1', payoutMethod: 'PAYPAL', payoutEmail: 'ana@example.com' },
      });

      await service.updateMyPixKey('user-1', { pixKeyType: 'CPF', pixKey: ' 12345678900 ' } as never);

      expect(updatedData()).toEqual({
        payoutMethod: 'PIX',
        payoutEmail: null,
        pixKey: '12345678900',
        pixKeyType: 'CPF',
      });
    });
  });

  describe('respostas', () => {
    const baseAffiliate = {
      id: 'aff-1',
      userId: 'user-1',
      code: 'ANA',
      name: 'Ana',
      commissionPercent: 20,
      isActive: true,
      discountPercent: null,
      discountAppliesTo: 'FIRST_PURCHASE',
      createdAt: new Date('2026-11-01T00:00:00Z'),
    };

    function readSetup(affiliate: Record<string, unknown>) {
      const prisma = {
        affiliate: {
          findFirst: jest.fn(async () => affiliate),
          findUnique: jest.fn(async () => ({
            ...affiliate,
            user: { id: 'user-1', email: 'ana@example.com', name: 'Ana' },
            parent: null,
            _count: { children: 0 },
          })),
          findMany: jest.fn(async () => [{ ...affiliate, _count: { earnings: 0, children: 0 }, user: null, parent: null }]),
          count: jest.fn(async () => 0),
        },
        affiliateEarning: {
          aggregate: jest.fn(async () => ({ _sum: { amountCents: null, commissionCents: null }, _count: 0 })),
          groupBy: jest.fn(async () => []),
          findMany: jest.fn(async () => []),
        },
        payment: { groupBy: jest.fn(async () => []) },
        user: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []) },
      };
      return new AffiliatesService(prisma as never, {} as never, {} as never);
    }

    it('getMyAffiliate devolve payoutMethod e payoutEmail', async () => {
      const service = readSetup({
        ...baseAffiliate,
        pixKey: null,
        pixKeyType: null,
        payoutMethod: 'PAYPAL',
        payoutEmail: 'ana@example.com',
      });

      const result = await service.getMyAffiliate('user-1');

      expect(result?.affiliate).toMatchObject({ payoutMethod: 'PAYPAL', payoutEmail: 'ana@example.com', pixKey: null });
      expect(result?.summary).toMatchObject({ payingUsers: 0, byCurrency: [] });
    });

    it('afiliado antigo, só com chave Pix, aparece como PIX; sem nada, null', async () => {
      const legacy = readSetup({ ...baseAffiliate, pixKey: '12345678900', pixKeyType: 'CPF', payoutMethod: null, payoutEmail: null });
      expect((await legacy.getMyAffiliate('user-1'))?.affiliate).toMatchObject({ payoutMethod: 'PIX', payoutEmail: null });

      const empty = readSetup({ ...baseAffiliate, pixKey: null, pixKeyType: null, payoutMethod: null, payoutEmail: null });
      expect((await empty.getMyAffiliate('user-1'))?.affiliate).toMatchObject({ payoutMethod: null, payoutEmail: null });
    });

    it('admin (findAll e findById) enxerga a forma de recebimento para pagar', async () => {
      const service = readSetup({
        ...baseAffiliate,
        pixKey: null,
        pixKeyType: null,
        payoutMethod: 'WISE',
        payoutEmail: 'ana@example.com',
      });

      const [listed] = await service.findAll();
      expect(listed).toMatchObject({ payoutMethod: 'WISE', payoutEmail: 'ana@example.com' });
      expect(await service.findById('aff-1')).toMatchObject({ payoutMethod: 'WISE', payoutEmail: 'ana@example.com' });
    });
  });
});
