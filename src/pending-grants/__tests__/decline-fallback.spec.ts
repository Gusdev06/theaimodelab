import {
  DECLINE_FALLBACK_TYPE,
  DeclineFallbackService,
  declineFallbackKey,
  declineFallbackText,
  isDeclineFallbackEnabled,
  isDeclinedPerfectpaySale,
  prepaidSlugForDeclinedPlan,
  prepaidCheckoutUrlFromSubscriptionUrl,
} from '../decline-fallback.service';

const NOW = new Date('2026-11-24T15:00:00.000Z');
const PRO = { slug: 'pro', name: 'Plan Pro', basePlanSlug: null, checkoutUrl: 'https://checkout.centerpag.com/pay/PPU38CQDTOD' };
const PRO_30D = { slug: 'pro-30d' };
const PRO_30D_URL = 'https://checkout.centerpag.com/pay/PPU38CQHN67';
const DECLINED = {
  code: 'PPCPMTB5HNKTEST',
  sale_status_enum: 5,
  sale_status_enum_key: 'rejected',
  sale_status_detail: 'Request not authorized. ECOM 57',
  plan: { code: 'PPLQQPTQU', name: 'Plan Pro' },
};

function makeService(overrides: {
  planByCode?: any;
  plans?: any[];
  prepaid?: any;
  user?: any;
  paying?: any;
  claimError?: any;
  notifyError?: any;
} = {}) {
  const prisma = {
    plan: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (typeof where.slug === 'string' && where.slug.endsWith('-30d')) return 'prepaid' in overrides ? overrides.prepaid : PRO_30D;
        if (typeof where.slug === 'string') return { checkoutUrl: `https://checkout.centerpag.com/pay/${where.slug === 'pro' ? 'PPU38CQDTOD' : 'X'}` };
        return 'planByCode' in overrides ? overrides.planByCode : PRO;
      }),
      findMany: jest.fn(async () => overrides.plans ?? []),
    },
    user: {
      findUnique: jest.fn(async () => ('user' in overrides ? overrides.user : { id: 'u1', locale: 'en', country: 'US' })),
    },
    subscription: { findFirst: jest.fn(async () => overrides.paying ?? null) },
    emailSequenceLog: {
      create: jest.fn(async () => {
        if (overrides.claimError) throw overrides.claimError;
        return { id: 'claim1' };
      }),
      delete: jest.fn(async () => ({})),
    },
  };
  const notifications = {
    create: jest.fn(async () => {
      if (overrides.notifyError) throw overrides.notifyError;
      return { id: 'n1' };
    }),
  };
  const service = new DeclineFallbackService(prisma as any, notifications as any);
  return { service, prisma, notifications };
}

describe('avulso na hora da recusa (dono 23/11)', () => {
  const envBefore = process.env.DECLINE_FALLBACK_NOTICE;
  afterEach(() => {
    if (envBefore === undefined) delete process.env.DECLINE_FALLBACK_NOTICE;
    else process.env.DECLINE_FALLBACK_NOTICE = envBefore;
  });

  it('recusa = rejected (5) ou cancelled (6, cartão recusado na PP); pendente e mediação não', () => {
    expect(isDeclinedPerfectpaySale({ sale_status_enum: 5, sale_status_enum_key: 'rejected' })).toBe(true);
    expect(isDeclinedPerfectpaySale({ sale_status_enum: 6, sale_status_enum_key: 'cancelled' })).toBe(true);
    expect(isDeclinedPerfectpaySale({ sale_status_enum: 6 })).toBe(true);
    expect(isDeclinedPerfectpaySale({ sale_status_enum: 1, sale_status_enum_key: 'pending' })).toBe(false);
    expect(isDeclinedPerfectpaySale({ sale_status_enum: 13, sale_status_enum_key: 'expired' })).toBe(false);
    expect(isDeclinedPerfectpaySale({ sale_status_enum: 4, sale_status_enum_key: 'in_mediation' })).toBe(false);
    expect(isDeclinedPerfectpaySale({ sale_status_enum: 2, sale_status_enum_key: 'approved' })).toBe(false);
  });

  it('plano → avulso de 30 d do mesmo plano; anual cai no mensal irmão; avulso e free não têm avulso', () => {
    expect(prepaidSlugForDeclinedPlan({ slug: 'pro' })).toBe('pro-30d');
    expect(prepaidSlugForDeclinedPlan({ slug: 'studio' })).toBe('studio-30d');
    expect(prepaidSlugForDeclinedPlan({ slug: 'pro-anual', basePlanSlug: 'pro' })).toBe('pro-30d');
    expect(prepaidSlugForDeclinedPlan({ slug: 'pro-30d' })).toBeNull();
    expect(prepaidSlugForDeclinedPlan({ slug: 'pro-90d' })).toBeNull();
    expect(prepaidSlugForDeclinedPlan({ slug: 'free' })).toBeNull();
  });

  it('texto do sino nas 3 línguas, sem o "30 dias" do nome', () => {
    expect(declineFallbackText('en', 'Pro · 30 days')).toBe(
      'Your bank blocked the automatic billing for Pro. Get 1 month with no renewal: same price, same credits.',
    );
    expect(declineFallbackText('pt', 'Plan Studio')).toContain('cobrança automática do Plan Studio');
    expect(declineFallbackText('es', 'Creator')).toContain('mismo precio, mismos créditos');
  });

  it('link do avulso US$ sai do link da assinatura mensal; anual, Cakto e desconhecido = null', () => {
    expect(prepaidCheckoutUrlFromSubscriptionUrl('https://checkout.centerpag.com/pay/PPU38CQDTOD?x=1')).toBe(PRO_30D_URL);
    expect(prepaidCheckoutUrlFromSubscriptionUrl('https://checkout.centerpag.com/pay/PPU38CQDTOA')).toBe('https://checkout.centerpag.com/pay/PPU38CQHQPR');
    expect(prepaidCheckoutUrlFromSubscriptionUrl('https://checkout.centerpag.com/pay/PPU38CQG711')).toBeNull();
    expect(prepaidCheckoutUrlFromSubscriptionUrl('https://pay.cakto.com.br/332rdfs')).toBeNull();
    expect(prepaidCheckoutUrlFromSubscriptionUrl(null)).toBeNull();
  });

  it('chave por cliente, avulso e dia', () => {
    expect(declineFallbackKey('u1', 'pro-30d', NOW)).toBe('decline_fallback:u1:pro-30d:2026-11-24');
  });

  it('interruptor: off/false/0 desliga; ausente liga', () => {
    expect(isDeclineFallbackEnabled({})).toBe(true);
    expect(isDeclineFallbackEnabled({ DECLINE_FALLBACK_NOTICE: 'off' })).toBe(false);
    expect(isDeclineFallbackEnabled({ DECLINE_FALLBACK_NOTICE: 'FALSE' })).toBe(false);
    expect(isDeclineFallbackEnabled({ DECLINE_FALLBACK_NOTICE: '0' })).toBe(false);
  });

  it('1ª compra do Pro recusada → aviso com o link do pro-30d', async () => {
    const { service, notifications } = makeService();
    await expect(service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['PPLQQPTQU'], NOW)).resolves.toBe('created');
    expect(notifications.create).toHaveBeenCalledWith(
      'u1',
      DECLINE_FALLBACK_TYPE,
      expect.objectContaining({
        prepaidSlug: 'pro-30d',
        planSlug: 'pro',
        planName: 'Plan Pro',
        checkoutUrl: PRO_30D_URL,
        saleCode: 'PPCPMTB5HNKTEST',
        key: 'decline_fallback:u1:pro-30d:2026-11-24',
      }),
    );
  });

  it('quem já paga um plano (renovação ou troca) não recebe', async () => {
    const { service, notifications } = makeService({ paying: { id: 's1' } });
    await expect(service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['PPLQQPTQU'], NOW)).resolves.toBe('already_paying');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('2ª recusa no mesmo dia (P2002) não duplica', async () => {
    const { service, notifications } = makeService({ claimError: { code: 'P2002' } });
    await expect(service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['PPLQQPTQU'], NOW)).resolves.toBe('duplicate');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('falha ao criar o aviso libera a reserva e não lança', async () => {
    const { service, prisma } = makeService({ notifyError: new Error('db down') });
    await expect(service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['PPLQQPTQU'], NOW)).resolves.toBe('error');
    expect(prisma.emailSequenceLog.delete).toHaveBeenCalledWith({ where: { id: 'claim1' } });
  });

  it('venda aprovada, pendente, sem e-mail, sem conta, sem avulso ou desligado: nada', async () => {
    expect(await makeService().service.notifyIfFirstPlanDecline({ ...DECLINED, sale_status_enum: 2, sale_status_enum_key: 'approved' }, 'a@b.com', [], NOW)).toBe('not_declined');
    expect(await makeService().service.notifyIfFirstPlanDecline(DECLINED, null, [], NOW)).toBe('no_email');
    expect(await makeService({ user: null }).service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['X'], NOW)).toBe('no_account');
    expect(await makeService({ prepaid: null }).service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['X'], NOW)).toBe('no_prepaid');
    process.env.DECLINE_FALLBACK_NOTICE = 'off';
    expect(await makeService().service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['X'], NOW)).toBe('disabled');
  });

  it('recusa do próprio avulso não oferece o avulso de novo (código e nome)', async () => {
    const byCode = makeService({ planByCode: { slug: 'studio-30d', name: 'Studio · 30 days', basePlanSlug: null } });
    expect(await byCode.service.notifyIfFirstPlanDecline(DECLINED, 'a@b.com', ['PPLQQR2NM'], NOW)).toBe('no_plan');
    const byName = makeService({
      planByCode: null,
      plans: [{ slug: 'studio', name: 'Plan Studio', basePlanSlug: null }],
    });
    const payload = { ...DECLINED, plan: { code: 'ZZZ', name: 'Studio · 30 days (one-time payment)' } };
    expect(await byName.service.notifyIfFirstPlanDecline(payload, 'a@b.com', ['ZZZ'], NOW)).toBe('no_plan');
  });

  it('sem código casado, casa pelo nome (slug mais longo primeiro)', async () => {
    const { service, notifications } = makeService({
      planByCode: null,
      plans: [
        { slug: 'pro', name: 'Plan Pro', basePlanSlug: null, checkoutUrl: 'https://checkout.centerpag.com/pay/PPU38CQDTOD' },
        { slug: 'pro-anual', name: 'Plan Pro Anual', basePlanSlug: 'pro', checkoutUrl: 'https://checkout.centerpag.com/pay/PPU38CQG711' },
      ],
    });
    const payload = { ...DECLINED, plan: { code: 'ZZZ', name: 'Plan Pro Anual' } };
    expect(await service.notifyIfFirstPlanDecline(payload, 'a@b.com', ['ZZZ'], NOW)).toBe('created');
    expect(notifications.create).toHaveBeenCalledWith('u1', DECLINE_FALLBACK_TYPE, expect.objectContaining({ planSlug: 'pro-anual', prepaidSlug: 'pro-30d', checkoutUrl: PRO_30D_URL }));
  });
});
