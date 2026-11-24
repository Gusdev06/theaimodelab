import { SubscriptionStatus } from '@prisma/client';
import {
  RENEWAL_DECLINED_TYPE,
  RENEWAL_RECOVERY_SEQUENCE,
  RenewalDeclineRecoveryService,
  basePlanSlugOf,
  dueRecoveryStep,
  isRenewalRecoveryEnabled,
  parseRecoveryKey,
  prepaidUrlForProvider,
  recoveryBonusCreditsFor,
  recoveryCampaignKey,
} from '../renewal-decline-recovery.service';

/** candy-retencao L04: régua D0/D3/D7 da renovação recusada (Perfect Pay/Cakto). */
const NOW = new Date('2026-11-24T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const PERIOD_END = new Date('2026-11-24T00:00:00.000Z');
const SUB = {
  id: 'sub1',
  userId: 'u1',
  status: SubscriptionStatus.ACTIVE,
  currentPeriodEnd: PERIOD_END,
  paymentProvider: 'perfectpay',
  plan: { id: 'plan-pro', slug: 'pro', name: 'Plan Pro', basePlanSlug: null, checkoutUrl: 'https://checkout.centerpag.com/pay/PPU38CQDTOD' },
};
const USER = {
  id: 'u1',
  email: 'cliente@example.com',
  name: 'Carlos',
  locale: 'en',
  country: 'US',
  signupBrand: null,
  isActive: true,
  marketingOptOut: false,
};
const DECLINED = { code: 'PPCPMTB5HNKTEST', sale_status_enum: 5, sale_status_detail: 'Request not authorized' };

function makeService(env: Record<string, string> = { RECOVERY_PP_ENABLED: 'on' }, overrides: { paidBefore?: number; claimError?: any; sub?: any } = {}) {
  const prisma = {
    user: { findUnique: jest.fn(async () => USER) },
    subscription: {
      findFirst: jest.fn(async () => ('sub' in overrides ? overrides.sub : SUB)),
      findUnique: jest.fn(async () => SUB),
    },
    payment: {
      count: jest.fn(async () => overrides.paidBefore ?? 1),
      findFirst: jest.fn(async () => null),
    },
    creditBalance: { findUnique: jest.fn(async () => ({ planCreditsRemaining: 1200, bonusCreditsRemaining: 300 })) },
    plan: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => ({ checkoutUrl: SUB.plan.checkoutUrl, prices: [] })),
    },
    emailSequenceLog: {
      create: jest.fn(async () => {
        if (overrides.claimError) throw overrides.claimError;
        return { id: 'claim1' };
      }),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
    },
    $transaction: jest.fn(),
  };
  const notifications = { create: jest.fn(async () => ({ id: 'n1' })) };
  const emailService = { sendRawEmail: jest.fn(async () => ({ id: 'resend-1' })) };
  const config = { get: jest.fn((key: string) => env[key]) };
  const service = new RenewalDeclineRecoveryService(prisma as any, notifications as any, emailService as any, config as any);
  return { service, prisma, notifications, emailService };
}

describe('RenewalDeclineRecoveryService (L04)', () => {
  it('flag desligada (padrão): não lê o banco, não manda nada', async () => {
    const { service, prisma, notifications, emailService } = makeService({});
    await expect(service.onPerfectpayPostback(DECLINED, USER.email, null)).resolves.toBe('disabled');
    await expect(service.runSteps(NOW)).resolves.toEqual({ won: 0, sent: 0 });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.emailSequenceLog.findMany).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
    expect(isRenewalRecoveryEnabled({})).toBe(false);
  });

  it('flag ligada: D0 reserva no email_sequence_logs ANTES de enviar, manda o e-mail da Mia e o sino com foto e botão', async () => {
    const { service, prisma, notifications, emailService } = makeService();
    await expect(service.onPerfectpayPostback(DECLINED, USER.email, null)).resolves.toBe('created');

    const campaign = recoveryCampaignKey('u1', 'sub1', PERIOD_END);
    expect(prisma.emailSequenceLog.create).toHaveBeenCalledWith({
      data: { userId: 'u1', sequence: RENEWAL_RECOVERY_SEQUENCE, emailKey: `${campaign}:d0` },
      select: { id: true },
    });
    expect(prisma.emailSequenceLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      emailService.sendRawEmail.mock.invocationCallOrder[0],
    );
    const mail = (emailService.sendRawEmail.mock.calls[0] as any[])[0];
    expect(mail.subject).toBe('Your bank declined the Pro renewal');
    expect(mail.html).toContain('1,500 credits');
    // link do avulso de 30 d do mesmo plano
    expect(mail.html).toContain('PPU38CQHN67');
    expect(mail.html).toContain('mia30-leva1.jpg');

    const [, type, data] = notifications.create.mock.calls[0] as any[];
    expect(type).toBe(RENEWAL_DECLINED_TYPE);
    expect(data).toMatchObject({ step: 'd0', ctaLabel: 'Renew now', ctaUrl: 'https://checkout.centerpag.com/pay/PPU38CQHN67' });
    expect(data.imageUrl).toContain('/mia/');
  });

  it('1ª compra (nunca pagou esta assinatura) fica com o DeclineFallbackService', async () => {
    const { service, emailService } = makeService(undefined, { paidBefore: 0 });
    await expect(service.onPerfectpayPostback(DECLINED, USER.email, null)).resolves.toBe('first_purchase');
    expect(emailService.sendRawEmail).not.toHaveBeenCalled();
  });

  it('postback que não é recusa ou retentativa no mesmo ciclo: nada sai em dobro', async () => {
    const notDeclined = makeService();
    await expect(notDeclined.service.onPerfectpayPostback({ sale_status_enum: 1 }, USER.email, null)).resolves.toBe('not_declined');

    const dup = makeService(undefined, { claimError: Object.assign(new Error('unique'), { code: 'P2002' }) });
    await expect(dup.service.onPerfectpayPostback(DECLINED, USER.email, null)).resolves.toBe('duplicate');
    expect(dup.emailService.sendRawEmail).not.toHaveBeenCalled();
  });

  it('erro no envio apaga a reserva e não derruba o webhook', async () => {
    const { service, prisma, emailService } = makeService();
    emailService.sendRawEmail.mockRejectedValueOnce(new Error('resend down'));
    await expect(service.onPerfectpayPostback(DECLINED, USER.email, null)).resolves.toBe('error');
    expect(prisma.emailSequenceLog.delete).toHaveBeenCalledWith({ where: { id: 'claim1' } });
  });

  it('passos D3 e D7 pela idade da campanha; D7 só com bônus; ganhou = fim', () => {
    const none = new Set<string>();
    expect(dueRecoveryStep(1 * DAY, none, true)).toBeNull();
    expect(dueRecoveryStep(3 * DAY + 1000, none, true)).toBe('d3');
    expect(dueRecoveryStep(7 * DAY + 1000, new Set(['d0', 'd3']), true)).toBe('d7');
    expect(dueRecoveryStep(7 * DAY + 1000, new Set(['d0', 'd3']), false)).toBeNull();
    expect(dueRecoveryStep(3 * DAY + 1000, new Set(['won']), true)).toBeNull();
    // cron perdido não vira rajada retroativa
    expect(dueRecoveryStep(12 * DAY, new Set(['d0']), true)).toBeNull();
  });

  it('bônus de prejuízo zero: 2.000 no Creator/Pro/Advanced, 1.000 no Studio, 0 em plano sem conta, teto 2.000', () => {
    expect(recoveryBonusCreditsFor({ slug: 'pro' }, {})).toBe(2000);
    expect(recoveryBonusCreditsFor({ slug: 'studio-anual' }, {})).toBe(1000);
    expect(recoveryBonusCreditsFor({ slug: 'ultra-basic' }, {})).toBe(0);
    expect(recoveryBonusCreditsFor({ slug: 'pro' }, { RECOVERY_PP_BONUS_CREDITS: 'pro:9000' })).toBe(2000);
    expect(basePlanSlugOf({ slug: 'creator-30d' })).toBe('creator');
  });

  it('link do avulso 30 d: troca só o código da assinatura pelo do pré-pago do mesmo gateway', () => {
    expect(prepaidUrlForProvider('https://checkout.centerpag.com/pay/PPU38CQDTOD?x=1', 'perfectpay')).toBe(
      'https://checkout.centerpag.com/pay/PPU38CQHN67',
    );
    expect(prepaidUrlForProvider('https://checkout.centerpag.com/pay/NADA', 'perfectpay')).toBeNull();
    expect(prepaidUrlForProvider(null, 'perfectpay')).toBeNull();
  });

  it('chave da campanha volta inteira no parse', () => {
    const key = `${recoveryCampaignKey('u1', 'sub1', PERIOD_END)}:d3`;
    expect(parseRecoveryKey(key)).toEqual({
      campaign: recoveryCampaignKey('u1', 'sub1', PERIOD_END),
      userId: 'u1',
      subscriptionId: 'sub1',
      step: 'd3',
    });
    expect(parseRecoveryKey('outra:coisa')).toBeNull();
  });
});
