import { PlansController } from '../plans.controller';
import { PlansService } from '../plans.service';
import {
  endedByExpiry,
  isExpiredPrepaidLock,
  isInAppHomeReferer,
  isPrepaidLockOnExpiryEnabled,
  isPrepaidNoticesEnabled,
  isPrepaidPlanSlug,
  subscriptionCheckoutUrlFor,
} from '../prepaid-plan';

const PAY = 'https://checkout.centerpag.com/pay/';

describe('Pré-pago de 30 dias · helpers', () => {
  it('isPrepaidPlanSlug: só slug terminado em -30d', () => {
    expect(isPrepaidPlanSlug('pro-30d')).toBe(true);
    expect(isPrepaidPlanSlug('creator-30d')).toBe(true);
    expect(isPrepaidPlanSlug('pro')).toBe(false);
    expect(isPrepaidPlanSlug('pro-anual')).toBe(false);
    expect(isPrepaidPlanSlug(null)).toBe(false);
    expect(isPrepaidPlanSlug(undefined)).toBe(false);
  });

  it('mapeia os 4 links de pré-pago para a assinatura do mesmo plano', () => {
    expect(subscriptionCheckoutUrlFor(`${PAY}PPU38CQHN67`)).toBe(`${PAY}PPU38CQDTOD`);
    expect(subscriptionCheckoutUrlFor(`${PAY}PPU38CQHQPQ`)).toBe(`${PAY}PPU38CQDTOH`);
    expect(subscriptionCheckoutUrlFor(`${PAY}PPU38CQHQPR`)).toBe(`${PAY}PPU38CQDTOA`);
    expect(subscriptionCheckoutUrlFor(`${PAY}PPU38CQHQPS`)).toBe(`${PAY}PPU38CQDTOF`);
  });

  it('preserva query string e âncora', () => {
    expect(subscriptionCheckoutUrlFor(`${PAY}PPU38CQHN67?utm_source=x&a=1#topo`)).toBe(
      `${PAY}PPU38CQDTOD?utm_source=x&a=1#topo`,
    );
  });

  it('link que não é de pré-pago devolve null', () => {
    expect(subscriptionCheckoutUrlFor(`${PAY}PPU38CQDTOD`)).toBeNull();
    expect(subscriptionCheckoutUrlFor('https://pay.cakto.com.br/abc')).toBeNull();
    expect(subscriptionCheckoutUrlFor(null)).toBeNull();
    expect(subscriptionCheckoutUrlFor('')).toBeNull();
  });

  it('chaves: trava desligada por padrão (só on liga); avisos ligados por padrão (off desliga)', () => {
    expect(isPrepaidLockOnExpiryEnabled({})).toBe(false);
    expect(isPrepaidLockOnExpiryEnabled({ PREPAID_LOCK_ON_EXPIRY: '' })).toBe(false);
    expect(isPrepaidLockOnExpiryEnabled({ PREPAID_LOCK_ON_EXPIRY: 'off' })).toBe(false);
    expect(isPrepaidLockOnExpiryEnabled({ PREPAID_LOCK_ON_EXPIRY: 'ON ' })).toBe(true);
    expect(isPrepaidLockOnExpiryEnabled({ PREPAID_LOCK_ON_EXPIRY: 'true' })).toBe(true);
    expect(isPrepaidNoticesEnabled({})).toBe(true);
    expect(isPrepaidNoticesEnabled({ PREPAID_NOTICES: 'off' })).toBe(false);
    expect(isPrepaidNoticesEnabled({ PREPAID_NOTICES: 'on' })).toBe(true);
  });

  it('Referer da Início do app (/home, com ou sem língua); resto não', () => {
    expect(isInAppHomeReferer('https://www.theaimodelab.com/home')).toBe(true);
    expect(isInAppHomeReferer('https://www.theaimodelab.com/home/?x=1')).toBe(true);
    expect(isInAppHomeReferer('https://www.theaimodelab.com/es/home')).toBe(true);
    expect(isInAppHomeReferer(['https://www.theaimodelab.com/pt-br/home'])).toBe(true);
    expect(isInAppHomeReferer('https://www.theaimodelab.com/')).toBe(false);
    expect(isInAppHomeReferer('https://www.theaimodelab.com/pricing')).toBe(false);
    expect(isInAppHomeReferer('https://www.theaimodelab.com/en/pricing')).toBe(false);
    expect(isInAppHomeReferer('https://www.theaimodelab.com/homepage')).toBe(false);
    expect(isInAppHomeReferer('not a url')).toBe(false);
    expect(isInAppHomeReferer(undefined)).toBe(false);
  });

  describe('vencimento × estorno', () => {
    const now = new Date('2026-12-20T12:00:00Z');
    const end = new Date('2026-12-17T12:00:00Z');
    const sub = (status: string, updatedAt: Date, slug = 'pro-30d', currentPeriodEnd = end) => ({
      status,
      currentPeriodEnd,
      updatedAt,
      plan: { slug },
    });

    it('CANCELED pelo cron (depois do fim) = venceu; estorno (antes do fim) não', () => {
      expect(endedByExpiry(sub('CANCELED', new Date('2026-12-17T13:00:00Z')), now)).toBe(true);
      expect(endedByExpiry(sub('CANCELED', new Date('2026-12-01T10:00:00Z')), now)).toBe(false);
      expect(endedByExpiry(sub('ACTIVE', end), now)).toBe(true);
      expect(endedByExpiry(sub('ACTIVE', end, 'pro-30d', new Date('2026-12-25T00:00:00Z')), now)).toBe(false);
    });

    it('trava só pré-pago vencido, sem assinatura ativa, até 120 dias', () => {
      const expired = sub('CANCELED', new Date('2026-12-17T13:00:00Z'));
      expect(isExpiredPrepaidLock(expired, false, now)).toBe(true);
      expect(isExpiredPrepaidLock(expired, true, now)).toBe(false);
      expect(isExpiredPrepaidLock(null, false, now)).toBe(false);
      expect(isExpiredPrepaidLock(sub('CANCELED', new Date('2026-12-17T13:00:00Z'), 'pro'), false, now)).toBe(false);
      expect(isExpiredPrepaidLock(sub('CANCELED', new Date('2026-12-01T10:00:00Z')), false, now)).toBe(false);
      const old = sub('CANCELED', new Date('2026-07-01T13:00:00Z'), 'pro-30d', new Date('2026-07-01T12:00:00Z'));
      expect(isExpiredPrepaidLock(old, false, now)).toBe(false);
    });
  });
});

describe('GET /plans · assinante recorrente não vê link de pré-pago (cobrança em dobro)', () => {
  const plan = (id: string, slug: string, checkoutUrl: string) => ({
    id,
    slug,
    name: slug,
    description: null,
    priceCents: 3990,
    creditsPerMonth: 30000,
    maxConcurrentGenerations: 1,
    hasWatermark: false,
    galleryRetentionDays: null,
    hasApiAccess: false,
    sortOrder: 1,
    billingInterval: 'month',
    basePlanSlug: null,
    checkoutUrl,
  });

  function make(opts: { recurring: boolean; links?: Map<string, string> }) {
    const plansService = {
      findAllPlans: jest.fn(async () => [
        plan('p-pro', 'pro', `${PAY}PPU38CQHN67?src=site`),
        plan('p-adv', 'advanced', `${PAY}PPU38CQHQPQ`),
        plan('p-agency', 'agency', `${PAY}PPU38CQG710`),
      ]),
      findBrlPublicPlans: jest.fn(async () => []),
      resolvePlanPrice: jest.fn(async () => ({ priceCents: 3990, currency: 'USD', stripePriceId: 'x' })),
      hasRecurringPerfectpaySubscription: jest.fn(async () => opts.recurring),
    };
    const checkoutCodes = { storefrontLinks: jest.fn(async () => opts.links ?? new Map()) };
    return { controller: new PlansController(plansService as any, checkoutCodes as any), plansService };
  }

  it('anônimo: links de pré-pago como estão, sem consultar assinatura', async () => {
    const { controller, plansService } = make({ recurring: true });
    const result = await controller.findAll(undefined, { headers: {} });
    expect(plansService.hasRecurringPerfectpaySubscription).not.toHaveBeenCalled();
    expect(result.map((p) => p.checkoutUrl)).toEqual([
      `${PAY}PPU38CQHN67?src=site`,
      `${PAY}PPU38CQHQPQ`,
      `${PAY}PPU38CQG710`,
    ]);
  });

  it('anônimo vindo da Início (cartão do ritmo, só assinante PP): link de assinatura', async () => {
    const { controller, plansService } = make({ recurring: false });
    const result = await controller.findAll('USD', { headers: { referer: 'https://www.theaimodelab.com/home' } });
    expect(plansService.hasRecurringPerfectpaySubscription).not.toHaveBeenCalled();
    expect(result.map((p) => p.checkoutUrl)).toEqual([
      `${PAY}PPU38CQDTOD?src=site`,
      `${PAY}PPU38CQDTOH`,
      `${PAY}PPU38CQG710`,
    ]);
  });

  it('anônimo vindo da /pricing (visitante novo): segue no pré-pago', async () => {
    const { controller } = make({ recurring: true });
    const result = await controller.findAll('USD', { headers: { referer: 'https://www.theaimodelab.com/en/pricing' } });
    expect(result[0].checkoutUrl).toBe(`${PAY}PPU38CQHN67?src=site`);
  });

  it('logado sem recorrente: continua no pré-pago', async () => {
    const { controller, plansService } = make({ recurring: false });
    const result = await controller.findAll(undefined, { headers: {}, user: { sub: 'u-1' } });
    expect(plansService.hasRecurringPerfectpaySubscription).toHaveBeenCalledWith('u-1');
    expect(result[0].checkoutUrl).toBe(`${PAY}PPU38CQHN67?src=site`);
  });

  it('logado com assinatura recorrente ativa: volta o link de assinatura (query preservada)', async () => {
    const { controller } = make({ recurring: true });
    const result = await controller.findAll(undefined, { headers: {}, user: { sub: 'u-1' } });
    expect(result.map((p) => p.checkoutUrl)).toEqual([
      `${PAY}PPU38CQDTOD?src=site`,
      `${PAY}PPU38CQDTOH`,
      `${PAY}PPU38CQG710`,
    ]);
  });

  it('link da marca (checkout_codes) continua com precedência', async () => {
    const { controller } = make({ recurring: true, links: new Map([['p-pro', 'https://funv/pro']]) });
    const result = await controller.findAll(undefined, { headers: {}, user: { sub: 'u-1' } });
    expect(result[0].checkoutUrl).toBe('https://funv/pro');
    expect(result[1].checkoutUrl).toBe(`${PAY}PPU38CQDTOH`);
  });

  it('PlansService: recorrente = ACTIVE perfectpay com plano que não é -30d', async () => {
    const findFirst = jest.fn(async () => ({ id: 'sub-1' }));
    const service = new PlansService({ subscription: { findFirst } } as any, { get: jest.fn() } as any);
    await expect(service.hasRecurringPerfectpaySubscription('u-1')).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u-1',
        status: 'ACTIVE',
        paymentProvider: 'perfectpay',
        NOT: { plan: { slug: { endsWith: '-30d' } } },
      },
      select: { id: true },
    });
    findFirst.mockResolvedValueOnce(null as any);
    await expect(service.hasRecurringPerfectpaySubscription('u-1')).resolves.toBe(false);
  });
});
