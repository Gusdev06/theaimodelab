import { ConflictException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isSafeCheckoutUrl, linksByTarget, normalizeCheckoutCode, pickSaleTarget } from '../checkout-codes';
import { CheckoutCodesService } from '../checkout-codes.service';

describe('checkout-codes · regras', () => {
  it('normaliza o código: link inteiro, oferta da Cakto com id, código solto; recusa lixo', () => {
    expect(normalizeCheckoutCode('cakto', 'https://pay.cakto.com.br/3bwycvo_123456?ref=x')).toBe('3bwycvo');
    expect(normalizeCheckoutCode('cakto', ' 3bwycvo ')).toBe('3bwycvo');
    expect(normalizeCheckoutCode('perfectpay', 'https://checkout.centerpag.com/pay/PPU38CQDTOD')).toBe('PPU38CQDTOD');
    expect(normalizeCheckoutCode('perfectpay', 'PPLQQPTQU')).toBe('PPLQQPTQU');
    expect(normalizeCheckoutCode('perfectpay', '')).toBeNull();
    expect(normalizeCheckoutCode('perfectpay', 'Plan Pro')).toBeNull();
    expect(normalizeCheckoutCode('perfectpay', 'https://')).toBeNull();
  });

  it('vitrine só aceita link https', () => {
    expect(isSafeCheckoutUrl('https://pay.cakto.com.br/abc')).toBe(true);
    expect(isSafeCheckoutUrl('http://pay.cakto.com.br/abc')).toBe(false);
    expect(isSafeCheckoutUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeCheckoutUrl(null)).toBe(false);
  });

  it('link por item: o mais novo vence e link inválido fica de fora', () => {
    const rows = [
      { planId: 'p1', creditPackageId: null, checkoutUrl: 'https://novo/p1' },
      { planId: 'p1', creditPackageId: null, checkoutUrl: 'https://velho/p1' },
      { planId: 'p2', creditPackageId: null, checkoutUrl: 'http://inseguro/p2' },
      { planId: null, creditPackageId: 'k1', checkoutUrl: 'https://pacote/k1' },
    ];
    const plans = linksByTarget(rows, 'plan');
    expect(plans.get('p1')).toBe('https://novo/p1');
    expect(plans.has('p2')).toBe(false);
    expect(plans.has('k1')).toBe(false);
    expect(linksByTarget(rows, 'package').get('k1')).toBe('https://pacote/k1');
  });

  it('venda: a ordem dos candidatos decide; plano inativo só vale onde o gateway aceita', () => {
    const rows = [
      { code: 'B', plan: null, creditPackage: { id: 'k1', name: 'Mega', credits: 25000 } },
      { code: 'A', plan: { id: 'p1', slug: 'pro', name: 'Pro', isActive: false }, creditPackage: null },
    ];
    expect(pickSaleTarget(['A', 'B'], rows, false)).toEqual({ kind: 'plan', plan: { id: 'p1', slug: 'pro', name: 'Pro' } });
    expect(pickSaleTarget(['A', 'B'], rows, true)).toEqual({
      kind: 'package',
      creditPackage: { id: 'k1', name: 'Mega', credits: 25000 },
    });
    expect(pickSaleTarget(['Z'], rows, false)).toBeNull();
  });
});

describe('CheckoutCodesService', () => {
  const ENV_KEYS = ['FUNVMAKE_FRONTEND_URL', 'FUNVMAKE_HOSTS'] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.FUNVMAKE_FRONTEND_URL = 'https://www.funvmake.com';
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function make(overrides: Record<string, any> = {}) {
    const prisma = {
      checkoutCode: {
        findMany: jest.fn(async () => []),
        create: jest.fn(async ({ data }: any) => ({ id: 'cc-1', ...data })),
        ...overrides.checkoutCode,
      },
      plan: {
        findUnique: jest.fn(async () => ({ id: 'plan-pro' })),
        findFirst: jest.fn(async () => null),
        ...overrides.plan,
      },
      creditPackage: {
        findUnique: jest.fn(async () => ({ id: 'pkg-mega' })),
        findFirst: jest.fn(async () => null),
        ...overrides.creditPackage,
      },
    };
    return { service: new CheckoutCodesService(prisma as any), prisma };
  }

  it('vitrine da origem não consulta nada; a da Funvmake busca os links dela', async () => {
    const { service, prisma } = make({
      checkoutCode: {
        findMany: jest.fn(async () => [{ planId: 'plan-pro', creditPackageId: null, checkoutUrl: 'https://funv/pro' }]),
      },
    });
    expect((await service.storefrontLinks({ origin: 'https://www.theaimodelab.com' }, 'USD', 'plan')).size).toBe(0);
    expect(prisma.checkoutCode.findMany).not.toHaveBeenCalled();

    const links = await service.storefrontLinks({ origin: 'https://www.funvmake.com' }, 'usd', 'plan');
    expect(links.get('plan-pro')).toBe('https://funv/pro');
    const where = (prisma.checkoutCode.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ brand: 'funvmake', currency: 'USD', isActive: true, planId: { not: null } });
  });

  it('sem FUNVMAKE_FRONTEND_URL nada muda na vitrine', async () => {
    delete process.env.FUNVMAKE_FRONTEND_URL;
    const { service, prisma } = make();
    expect((await service.storefrontLinks({ origin: 'https://www.funvmake.com' }, 'USD', 'plan')).size).toBe(0);
    expect(prisma.checkoutCode.findMany).not.toHaveBeenCalled();
  });

  it('erro na tabela (ex.: migração ainda não rodou) não derruba vitrine nem webhook', async () => {
    const boom = jest.fn(async () => {
      throw new Error('relation "checkout_codes" does not exist');
    });
    const { service } = make({ checkoutCode: { findMany: boom } });
    expect((await service.storefrontLinks({ origin: 'https://www.funvmake.com' }, 'USD', 'plan')).size).toBe(0);
    expect(await service.findSaleTarget('perfectpay', ['PPX'], { activePlanOnly: true })).toBeNull();
  });

  it('cadastro: exige plano OU pacote, link https, e normaliza o link da Cakto', async () => {
    const { service, prisma } = make();
    await expect(
      service.create({ gateway: 'cakto', code: 'abc123', currency: 'BRL' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ gateway: 'cakto', code: 'abc123', currency: 'BRL', planId: 'a', creditPackageId: 'b' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ gateway: 'cakto', code: 'abc123', currency: 'BRL', creditPackageId: 'pkg-mega', checkoutUrl: 'http://x' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    const created: any = await service.create({
      gateway: 'cakto',
      code: 'https://pay.cakto.com.br/fvm4ega_99',
      brand: 'funvmake',
      currency: 'brl',
      creditPackageId: 'pkg-mega',
      checkoutUrl: 'https://pay.cakto.com.br/fvm4ega',
      account: ' cnpj-brain2 ',
    } as any);
    expect(created).toMatchObject({
      gateway: 'cakto',
      code: 'fvm4ega',
      brand: 'funvmake',
      currency: 'BRL',
      creditPackageId: 'pkg-mega',
      planId: null,
      account: 'cnpj-brain2',
      isActive: true,
    });
    expect(prisma.checkoutCode.create).toHaveBeenCalledTimes(1);
  });

  it('cadastro: código que já é o principal de um plano é recusado; código repetido vira 409', async () => {
    const primary = make({ plan: { findUnique: jest.fn(async () => ({ id: 'plan-pro' })), findFirst: jest.fn(async () => ({ slug: 'pro' })) } });
    await expect(
      primary.service.create({ gateway: 'perfectpay', code: 'PPLQQPTQU', currency: 'USD', planId: 'plan-pro' } as any),
    ).rejects.toBeInstanceOf(ConflictException);

    const duplicate = make({
      checkoutCode: {
        create: jest.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        }),
      },
    });
    await expect(
      duplicate.service.create({ gateway: 'perfectpay', code: 'PPNOVO1', currency: 'USD', planId: 'plan-pro' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
