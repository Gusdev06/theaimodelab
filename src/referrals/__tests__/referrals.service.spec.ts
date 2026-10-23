import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CreditTransactionType, Prisma, ReferralStatus } from '@prisma/client';
import { SETTING_KEYS } from '../../settings/settings.service';
import { emailFingerprint } from '../referral-signals';
import { APPROVED_BY_ADMIN, ReferralsService } from '../referrals.service';

type CountScenario = { sameMailbox?: number; sameIp?: number; rewardedTotal?: number; rewardedToday?: number };

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function pendingReferral(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ref_1',
    referrerId: 'referrer_1',
    status: ReferralStatus.PENDING,
    reason: null,
    signupIpHash: 'iphash',
    emailFingerprint: 'fp',
    createdAt: new Date('2026-10-20T10:00:00Z'),
    ...overrides,
  };
}

function setup(options: { settings?: Record<string, number | null>; env?: Record<string, string> } = {}) {
  const settingsValues = options.settings ?? {};
  const env = options.env ?? {};
  const tx = {
    referral: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    creditBalance: { upsert: jest.fn().mockResolvedValue({}) },
    creditTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    referral: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { creditsAwarded: null } }),
    },
    referralCode: { findUnique: jest.fn(), create: jest.fn() },
    affiliate: { findUnique: jest.fn().mockResolvedValue(null) },
    user: {
      findFirst: jest.fn().mockResolvedValue({ id: 'referred_1' }),
      findUnique: jest.fn().mockResolvedValue({ isActive: true }),
    },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const settings = {
    getInt: jest.fn(async (key: string, fallback: number) =>
      key in settingsValues ? settingsValues[key] : fallback,
    ),
  };
  const config = { get: jest.fn((name: string) => env[name]) };
  const service = new ReferralsService(prisma as never, config as never, settings as never);

  const setCounts = (scenario: CountScenario) => {
    prisma.referral.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if ('emailFingerprint' in where) return scenario.sameMailbox ?? 0;
      if ('signupIpHash' in where) return scenario.sameIp ?? 0;
      if ('rewardedAt' in where) return scenario.rewardedToday ?? 0;
      return scenario.rewardedTotal ?? 0;
    });
  };

  return { service, prisma, tx, settings, config, setCounts };
}

describe('ReferralsService', () => {
  describe('getRewardAmount', () => {
    it('sem configuração nenhuma, paga 200', async () => {
      const { service } = setup();
      await expect(service.getRewardAmount()).resolves.toBe(200);
    });

    it('app_settings manda sobre o env, e 0 desliga', async () => {
      await expect(
        setup({ settings: { [SETTING_KEYS.referralRewardCredits]: 350 }, env: { REFERRAL_REWARD_CREDITS: '10' } })
          .service.getRewardAmount(),
      ).resolves.toBe(350);
      await expect(
        setup({ settings: { [SETTING_KEYS.referralRewardCredits]: 0 } }).service.getRewardAmount(),
      ).resolves.toBe(0);
    });

    it('linha inválida no banco ou env inválido desligam (nunca caem no padrão por engano)', async () => {
      await expect(
        setup({ settings: { [SETTING_KEYS.referralRewardCredits]: null } }).service.getRewardAmount(),
      ).resolves.toBe(0);
      await expect(setup({ env: { REFERRAL_REWARD_CREDITS: 'abc' } }).service.getRewardAmount()).resolves.toBe(0);
      await expect(setup({ env: { REFERRAL_REWARD_CREDITS: '-5' } }).service.getRewardAmount()).resolves.toBe(0);
      await expect(setup({ env: { REFERRAL_REWARD_CREDITS: '120' } }).service.getRewardAmount()).resolves.toBe(120);
    });
  });

  describe('tryReward', () => {
    it('paga 200 a quem indicou, numa transação, com o ledger REFERRAL_BONUS ligado à indicação', async () => {
      const { service, prisma, tx, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({});

      await expect(service.tryReward('referred_1')).resolves.toBe('rewarded');

      expect(tx.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING },
        data: expect.objectContaining({ status: ReferralStatus.REWARDED, creditsAwarded: 200 }),
      });
      expect(tx.creditBalance.upsert).toHaveBeenCalledWith({
        where: { userId: 'referrer_1' },
        create: { userId: 'referrer_1', bonusCreditsRemaining: 200 },
        update: { bonusCreditsRemaining: { increment: 200 } },
      });
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: {
          userId: 'referrer_1',
          type: CreditTransactionType.REFERRAL_BONUS,
          amount: 200,
          source: 'bonus',
          description: 'referral:ref_1',
        },
      });
    });

    it('se outra chamada já virou o status, não credita de novo (sem crédito em dobro)', async () => {
      const { service, prisma, tx, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({});
      tx.referral.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.tryReward('referred_1')).resolves.toBe('not_pending');
      expect(tx.creditBalance.upsert).not.toHaveBeenCalled();
      expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('desligado (valor 0) não consulta nem paga nada', async () => {
      const { service, prisma } = setup({ settings: { [SETTING_KEYS.referralRewardCredits]: 0 } });
      await expect(service.tryReward('referred_1')).resolves.toBe('disabled');
      expect(prisma.referral.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('sem indicação, ou indicação que não está pendente, não paga', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique.mockResolvedValueOnce(null);
      await expect(service.tryReward('referred_1')).resolves.toBe('not_pending');
      prisma.referral.findUnique.mockResolvedValueOnce(pendingReferral({ status: ReferralStatus.REWARDED }));
      await expect(service.tryReward('referred_1')).resolves.toBe('not_pending');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('indicado sem e-mail verificado ou sem geração concluída (findFirst vazio) espera', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.tryReward('referred_1')).resolves.toBe('not_eligible');
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'referred_1',
          isActive: true,
          emailVerified: true,
          generations: { some: { status: 'COMPLETED' } },
        }),
        select: { id: true },
      });
      expect(prisma.referral.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('indicador desativado não recebe e a indicação continua pendente', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      prisma.user.findUnique.mockResolvedValue({ isActive: false });

      await expect(service.tryReward('referred_1')).resolves.toBe('not_eligible');
      expect(prisma.referral.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('mesma caixa de e-mail que uma indicação anterior do mesmo indicador: bloqueia', async () => {
      const { service, prisma, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({ sameMailbox: 1 });

      await expect(service.tryReward('referred_1')).resolves.toBe('blocked');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING },
        data: { status: ReferralStatus.BLOCKED, reason: 'duplicate_email' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('só as indicações MAIS NOVAS que a 1ª da mesma caixa/IP contam como repetidas', async () => {
      const { service, prisma, setCounts } = setup();
      const createdAt = new Date('2026-10-20T10:00:00Z');
      prisma.referral.findUnique.mockResolvedValue(pendingReferral({ createdAt }));
      setCounts({});

      await service.tryReward('referred_1');
      const mailboxQuery = prisma.referral.count.mock.calls.find(([arg]) => 'emailFingerprint' in arg.where)[0];
      expect(mailboxQuery.where).toEqual(
        expect.objectContaining({ referrerId: 'referrer_1', id: { not: 'ref_1' }, createdAt: { lt: createdAt } }),
      );
    });

    it('IP de cadastro repetido do mesmo indicador vai para revisão', async () => {
      const { service, prisma, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({ sameIp: 2 });

      await expect(service.tryReward('referred_1')).resolves.toBe('review');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING },
        data: { status: ReferralStatus.REVIEW, reason: 'shared_ip' },
      });
    });

    it('sem IP nem impressão de e-mail, essas regras simplesmente não agem', async () => {
      const { service, prisma, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral({ signupIpHash: null, emailFingerprint: null }));
      setCounts({ sameMailbox: 5, sameIp: 5 });

      await expect(service.tryReward('referred_1')).resolves.toBe('rewarded');
    });

    it('teto total atingido (padrão 50) vai para revisão', async () => {
      const { service, prisma, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({ rewardedTotal: 50 });

      await expect(service.tryReward('referred_1')).resolves.toBe('review');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING },
        data: { status: ReferralStatus.REVIEW, reason: 'cap_total' },
      });
    });

    it('teto diário (padrão 10) só adia: continua PENDING, sem pagar', async () => {
      const { service, prisma, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({ rewardedTotal: 12, rewardedToday: 10 });

      await expect(service.tryReward('referred_1')).resolves.toBe('deferred');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING },
        data: { reason: 'cap_daily' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('os tetos seguem o app_settings', async () => {
      const { service, prisma, setCounts } = setup({
        settings: {
          [SETTING_KEYS.referralMaxRewardsPerReferrer]: 3,
          [SETTING_KEYS.referralMaxRewardsPerDay]: 100,
        },
      });
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({ rewardedTotal: 3 });

      await expect(service.tryReward('referred_1')).resolves.toBe('review');
    });

    it('liberada pelo admin pula as regras de fraude, mas ainda exige o indicado elegível', async () => {
      const { service, prisma, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral({ reason: APPROVED_BY_ADMIN }));
      setCounts({ sameMailbox: 3, sameIp: 3, rewardedTotal: 999, rewardedToday: 999 });

      await expect(service.tryReward('referred_1')).resolves.toBe('rewarded');
      expect(prisma.referral.count).not.toHaveBeenCalled();

      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.tryReward('referred_1')).resolves.toBe('not_eligible');
    });

    it('erro de banco vira "error" e nunca sobe', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique.mockRejectedValue(new Error('db fora'));
      await expect(service.tryReward('referred_1')).resolves.toBe('error');
    });

    it('erro dentro da transação também não sobe nem marca como paga fora dela', async () => {
      const { service, prisma, tx, setCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({});
      tx.creditBalance.upsert.mockRejectedValue(new Error('deadlock'));

      await expect(service.tryReward('referred_1')).resolves.toBe('error');
      expect(prisma.referral.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('attachOnSignup', () => {
    const ownerCode = { userId: 'referrer_1', user: { email: 'dono@gmail.com' } };

    it('liga a conta nova como PENDING, com impressão do e-mail e hash do IP (nunca o IP puro)', async () => {
      const { service, prisma } = setup({ env: { REFERRAL_IP_SALT: 'sal' } });
      prisma.referralCode.findUnique.mockResolvedValue(ownerCode);

      await service.attachOnSignup({
        referredUserId: 'referred_1',
        referredEmail: 'amiga@outlook.com',
        rawCode: ' ab12cd34 ',
        ipAddress: '203.0.113.7',
      });

      expect(prisma.referralCode.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: 'AB12CD34' } }),
      );
      const data = prisma.referral.create.mock.calls[0][0].data;
      expect(data).toEqual(
        expect.objectContaining({
          referrerId: 'referrer_1',
          referredUserId: 'referred_1',
          code: 'AB12CD34',
          status: ReferralStatus.PENDING,
          reason: null,
          emailFingerprint: emailFingerprint('amiga@outlook.com'),
        }),
      );
      expect(data.signupIpHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain('203.0.113.7');
    });

    it('alias do próprio e-mail do indicador nasce BLOCKED (self_alias)', async () => {
      const { service, prisma } = setup();
      prisma.referralCode.findUnique.mockResolvedValue(ownerCode);

      await service.attachOnSignup({
        referredUserId: 'referred_1',
        referredEmail: 'do.no+2@googlemail.com',
        rawCode: 'AB12CD34',
      });

      expect(prisma.referral.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ status: ReferralStatus.BLOCKED, reason: 'self_alias' }),
      );
    });

    it('sem código, código inválido, código desconhecido ou o próprio usuário: nada é criado', async () => {
      const { service, prisma } = setup();
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com' });
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com', rawCode: 'x y' });
      prisma.referralCode.findUnique.mockResolvedValueOnce(null);
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com', rawCode: 'AB12CD34' });
      prisma.referralCode.findUnique.mockResolvedValueOnce({ userId: 'u', user: { email: 'a@b.com' } });
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com', rawCode: 'AB12CD34' });

      expect(prisma.referral.create).not.toHaveBeenCalled();
    });

    it('conta já indicada (unique) e erro qualquer não derrubam o cadastro', async () => {
      const { service, prisma } = setup();
      prisma.referralCode.findUnique.mockResolvedValue(ownerCode);
      prisma.referral.create.mockRejectedValueOnce(uniqueViolation());
      await expect(
        service.attachOnSignup({ referredUserId: 'r', referredEmail: 'a@b.com', rawCode: 'AB12CD34' }),
      ).resolves.toBeUndefined();

      prisma.referral.create.mockRejectedValueOnce(new Error('db fora'));
      await expect(
        service.attachOnSignup({ referredUserId: 'r', referredEmail: 'a@b.com', rawCode: 'AB12CD34' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getOrCreateCode', () => {
    it('devolve o código que já existe', async () => {
      const { service, prisma } = setup();
      prisma.referralCode.findUnique.mockResolvedValue({ code: 'EXISTE22' });
      await expect(service.getOrCreateCode('u1')).resolves.toBe('EXISTE22');
      expect(prisma.referralCode.create).not.toHaveBeenCalled();
    });

    it('cria na 1ª vez e pula código que já é de afiliado', async () => {
      const { service, prisma } = setup();
      prisma.referralCode.findUnique.mockResolvedValue(null);
      prisma.affiliate.findUnique.mockResolvedValueOnce({ id: 'aff' }).mockResolvedValue(null);
      prisma.referralCode.create.mockImplementation(async ({ data }: { data: { code: string } }) => ({
        code: data.code,
      }));

      const code = await service.getOrCreateCode('u1');
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
      expect(prisma.affiliate.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.referralCode.create).toHaveBeenCalledTimes(1);
    });

    it('corrida: outra chamada criou o código do mesmo usuário, usa o dela', async () => {
      const { service, prisma } = setup();
      prisma.referralCode.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ code: 'GANHOU22' });
      prisma.referralCode.create.mockRejectedValue(uniqueViolation());

      await expect(service.getOrCreateCode('u1')).resolves.toBe('GANHOU22');
    });
  });

  describe('sweepPending', () => {
    it('só busca pendentes com indicado elegível e soma os resultados', async () => {
      const { service, prisma, setCounts } = setup();
      prisma.referral.findMany.mockResolvedValue([{ referredUserId: 'a' }, { referredUserId: 'b' }]);
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setCounts({});

      const counts = await service.sweepPending();
      expect(counts.rewarded).toBe(2);
      expect(prisma.referral.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: ReferralStatus.PENDING,
            referredUser: expect.objectContaining({ emailVerified: true, isActive: true }),
          },
        }),
      );
    });

    it('desligado, nem consulta', async () => {
      const { service, prisma } = setup({ settings: { [SETTING_KEYS.referralRewardCredits]: 0 } });
      await service.sweepPending();
      expect(prisma.referral.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getSummary', () => {
    it('mostra só o primeiro nome do indicado, a etapa e os totais (revisão conta como pendente)', async () => {
      const { service, prisma } = setup();
      prisma.referralCode.findUnique.mockResolvedValue({ code: 'MEU22COD' });
      prisma.referral.groupBy.mockResolvedValue([
        { status: ReferralStatus.REWARDED, _count: { _all: 2 } },
        { status: ReferralStatus.PENDING, _count: { _all: 1 } },
        { status: ReferralStatus.REVIEW, _count: { _all: 1 } },
        { status: ReferralStatus.BLOCKED, _count: { _all: 1 } },
      ]);
      prisma.referral.aggregate.mockResolvedValue({ _sum: { creditsAwarded: 400 } });
      prisma.referral.findMany
        .mockResolvedValueOnce([]) // pendentes elegíveis do pagamento na hora
        .mockResolvedValueOnce([
          {
            id: 'r1',
            status: ReferralStatus.REVIEW,
            creditsAwarded: 0,
            createdAt: new Date(),
            referredUser: { name: 'Maria Clara Souza' },
          },
        ]);

      const summary = await service.getSummary('u1');
      expect(summary).toEqual(
        expect.objectContaining({
          enabled: true,
          code: 'MEU22COD',
          rewardCredits: 200,
          totals: { invited: 5, rewarded: 2, pending: 2, creditsEarned: 400 },
        }),
      );
      expect(summary.recent[0]).toEqual(expect.objectContaining({ name: 'Maria', stage: 'in_review' }));
      expect(JSON.stringify(summary)).not.toContain('Souza');
    });
  });

  describe('admin', () => {
    it('aprovar volta para PENDING liberada pelo admin e já tenta pagar', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique
        .mockResolvedValueOnce({ id: 'ref_1', referredUserId: 'referred_1' })
        .mockResolvedValueOnce(pendingReferral({ reason: APPROVED_BY_ADMIN }));

      await expect(service.approve('ref_1', 'admin_1')).resolves.toEqual({ id: 'ref_1', outcome: 'rewarded' });
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: { in: [ReferralStatus.REVIEW, ReferralStatus.BLOCKED] } },
        data: expect.objectContaining({
          status: ReferralStatus.PENDING,
          reason: APPROVED_BY_ADMIN,
          reviewedById: 'admin_1',
        }),
      });
    });

    it('aprovar indicação que não está em revisão/bloqueada dá 400; inexistente dá 404', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique.mockResolvedValueOnce({ id: 'ref_1', referredUserId: 'r' });
      prisma.referral.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.approve('ref_1', 'admin_1')).rejects.toBeInstanceOf(BadRequestException);

      prisma.referral.findUnique.mockResolvedValueOnce(null);
      await expect(service.approve('nada', 'admin_1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('recusar bloqueia pendente/revisão e não mexe em indicação já paga', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique.mockResolvedValue({ id: 'ref_1', referredUserId: 'r' });

      await expect(service.reject('ref_1', 'admin_1')).resolves.toEqual({
        id: 'ref_1',
        status: ReferralStatus.BLOCKED,
      });
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: { in: [ReferralStatus.PENDING, ReferralStatus.REVIEW] } },
        data: expect.objectContaining({ status: ReferralStatus.BLOCKED, reason: 'rejected_by_admin' }),
      });

      prisma.referral.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.reject('ref_1', 'admin_1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
