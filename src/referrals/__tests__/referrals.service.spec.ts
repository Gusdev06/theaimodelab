import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CreditTransactionType, Prisma, ReferralStatus } from '@prisma/client';
import { SETTING_KEYS } from '../../settings/settings.service';
import { emailDomainKey, emailFingerprint } from '../referral-signals';
import { APPROVED_BY_ADMIN, ReferralsService, stageOf } from '../referrals.service';

type Signals = { sameMailbox?: number; sameIp?: number; sameDomain?: number; staleReview?: number };
type TxCounts = { today?: number; global?: number };

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
    emailDomainKey: 'domainkey',
    createdAt: new Date('2026-10-20T10:00:00Z'),
    ...overrides,
  };
}

function setup(
  options: {
    settings?: Record<string, string>;
    env?: Record<string, string>;
    referredEligible?: boolean;
    referrerEligible?: boolean;
  } = {},
) {
  const settingsValues = options.settings ?? {};
  const env = options.env ?? {};
  const eligibility = {
    referred: options.referredEligible ?? true,
    referrer: options.referrerEligible ?? true,
  };
  const txCounts: TxCounts = {};
  const tx = {
    referralCode: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    referral: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        'referrerId' in where ? (txCounts.today ?? 0) : (txCounts.global ?? 0),
      ),
    },
    creditBalance: { upsert: jest.fn().mockResolvedValue({}) },
    creditTransaction: { create: jest.fn().mockResolvedValue({}) },
  };
  const signals: Signals = {};
  const prisma = {
    referral: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('emailFingerprint' in where) return signals.sameMailbox ?? 0;
        if ('signupIpHash' in where) return signals.sameIp ?? 0;
        if ('emailDomainKey' in where) return signals.sameDomain ?? 0;
        if (where.status === ReferralStatus.REVIEW) return signals.staleReview ?? 0;
        return 0;
      }),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: { creditsAwarded: null } }),
    },
    referralCode: { findUnique: jest.fn(), create: jest.fn() },
    affiliate: { findUnique: jest.fn().mockResolvedValue(null) },
    user: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'referrer_1') return eligibility.referrer ? { id: where.id } : null;
        return eligibility.referred ? { id: where.id } : null;
      }),
      findUnique: jest.fn().mockResolvedValue({ emailVerified: true }),
    },
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const settings = {
    getRaw: jest.fn(async (key: string) => settingsValues[key]),
    setInt: jest.fn().mockResolvedValue(undefined),
  };
  const config = { get: jest.fn((name: string) => env[name]) };
  const service = new ReferralsService(prisma as never, config as never, settings as never);

  return {
    service,
    prisma,
    tx,
    settings,
    eligibility,
    setSignals: (value: Signals) => Object.assign(signals, value),
    setTxCounts: (value: TxCounts) => Object.assign(txCounts, value),
  };
}

const expectNoCredit = (tx: ReturnType<typeof setup>['tx']) => {
  expect(tx.creditBalance.upsert).not.toHaveBeenCalled();
  expect(tx.creditTransaction.create).not.toHaveBeenCalled();
};

describe('ReferralsService', () => {
  describe('getRewardAmount', () => {
    it('sem configuração nenhuma, paga 200', async () => {
      await expect(setup().service.getRewardAmount()).resolves.toBe(200);
    });

    it('app_settings manda sobre o env, e 0 desliga', async () => {
      await expect(
        setup({ settings: { [SETTING_KEYS.referralRewardCredits]: '350' }, env: { REFERRAL_REWARD_CREDITS: '10' } })
          .service.getRewardAmount(),
      ).resolves.toBe(350);
      await expect(
        setup({ settings: { [SETTING_KEYS.referralRewardCredits]: '0' } }).service.getRewardAmount(),
      ).resolves.toBe(0);
    });

    it('valor negativo no banco DESLIGA (não cai no padrão de 200)', async () => {
      for (const raw of ['-1', '-200']) {
        await expect(
          setup({ settings: { [SETTING_KEYS.referralRewardCredits]: raw } }).service.getRewardAmount(),
        ).resolves.toBe(0);
      }
    });

    it('lixo, vazio ou acima de 5.000 no banco desligam', async () => {
      for (const raw of ['2OO', '', 'abc', '6000', '200000']) {
        await expect(
          setup({ settings: { [SETTING_KEYS.referralRewardCredits]: raw } }).service.getRewardAmount(),
        ).resolves.toBe(0);
      }
      await expect(
        setup({ settings: { [SETTING_KEYS.referralRewardCredits]: '5000' } }).service.getRewardAmount(),
      ).resolves.toBe(5000);
    });

    it('env: vazio = padrão, inválido desliga, válido vale', async () => {
      await expect(setup({ env: { REFERRAL_REWARD_CREDITS: '' } }).service.getRewardAmount()).resolves.toBe(200);
      await expect(setup({ env: { REFERRAL_REWARD_CREDITS: 'abc' } }).service.getRewardAmount()).resolves.toBe(0);
      await expect(setup({ env: { REFERRAL_REWARD_CREDITS: '-5' } }).service.getRewardAmount()).resolves.toBe(0);
      await expect(setup({ env: { REFERRAL_REWARD_CREDITS: '120' } }).service.getRewardAmount()).resolves.toBe(120);
    });
  });

  describe('tryReward', () => {
    it('paga 200 numa transação: trava o código do indicador, vira o status e lança REFERRAL_BONUS', async () => {
      const { service, prisma, tx } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());

      await expect(service.tryReward('referred_1')).resolves.toBe('rewarded');

      expect(tx.referralCode.updateMany).toHaveBeenCalledWith({
        where: { userId: 'referrer_1', rewardedCount: { lt: 50 } },
        data: { rewardedCount: { increment: 1 } },
      });
      expect(tx.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING, reason: null },
        data: expect.objectContaining({ status: ReferralStatus.REWARDED, creditsAwarded: 200, reason: null }),
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

    it('o teto do dia e o global são contados DENTRO da transação (depois da trava)', async () => {
      const { service, prisma, tx } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      await service.tryReward('referred_1');
      const lockOrder = tx.referralCode.updateMany.mock.invocationCallOrder[0];
      for (const order of tx.referral.count.mock.invocationCallOrder) expect(order).toBeGreaterThan(lockOrder);
      expect(tx.referral.count).toHaveBeenCalledTimes(2);
    });

    it('se outra chamada já virou o status, não credita de novo (sem crédito em dobro)', async () => {
      const { service, prisma, tx } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      tx.referral.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.tryReward('referred_1')).resolves.toBe('not_pending');
      expectNoCredit(tx);
    });

    it('desligado (valor 0) não consulta nem paga nada', async () => {
      const { service, prisma } = setup({ settings: { [SETTING_KEYS.referralRewardCredits]: '0' } });
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

    it('indicado sem e-mail verificado ou sem geração concluída espera', async () => {
      const { service, prisma } = setup({ referredEligible: false });
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());

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

    it('indicador desativado ou sem e-mail verificado não recebe e a indicação continua pendente', async () => {
      const { service, prisma } = setup({ referrerEligible: false });
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());

      await expect(service.tryReward('referred_1')).resolves.toBe('not_eligible');
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { id: 'referrer_1', isActive: true, emailVerified: true },
        select: { id: true },
      });
      expect(prisma.referral.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('mesma caixa de e-mail que uma indicação anterior: bloqueia, só se ninguém mexeu nela desde a leitura', async () => {
      const { service, prisma, setSignals } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setSignals({ sameMailbox: 1 });

      await expect(service.tryReward('referred_1')).resolves.toBe('blocked');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING, reason: null },
        data: { status: ReferralStatus.BLOCKED, reason: 'duplicate_email' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('só as indicações MAIS NOVAS que a 1ª da mesma caixa/IP/domínio contam como repetidas', async () => {
      const { service, prisma } = setup();
      const createdAt = new Date('2026-10-20T10:00:00Z');
      prisma.referral.findUnique.mockResolvedValue(pendingReferral({ createdAt }));

      await service.tryReward('referred_1');
      for (const key of ['emailFingerprint', 'signupIpHash', 'emailDomainKey']) {
        const query = prisma.referral.count.mock.calls.find(([arg]) => key in arg.where)?.[0];
        expect(query).toBeDefined();
        expect(query?.where).toEqual(
          expect.objectContaining({ referrerId: 'referrer_1', id: { not: 'ref_1' }, createdAt: { lt: createdAt } }),
        );
      }
    });

    it('IP de cadastro repetido do mesmo indicador vai para revisão', async () => {
      const { service, prisma, setSignals, tx } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setSignals({ sameIp: 2 });

      await expect(service.tryReward('referred_1')).resolves.toBe('review');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING, reason: null },
        data: { status: ReferralStatus.REVIEW, reason: 'shared_ip' },
      });
      expectNoCredit(tx);
    });

    it('domínio próprio: 2 contas anteriores passam, a 3ª vai para revisão (catch-all)', async () => {
      const first = setup();
      first.prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      first.setSignals({ sameDomain: 1 });
      await expect(first.service.tryReward('referred_1')).resolves.toBe('rewarded');

      const third = setup();
      third.prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      third.setSignals({ sameDomain: 2 });
      await expect(third.service.tryReward('referred_1')).resolves.toBe('review');
      expect(third.prisma.referral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: ReferralStatus.REVIEW, reason: 'shared_domain' } }),
      );
    });

    it('sem IP, impressão nem domínio, essas regras simplesmente não agem', async () => {
      const { service, prisma, setSignals } = setup();
      prisma.referral.findUnique.mockResolvedValue(
        pendingReferral({ signupIpHash: null, emailFingerprint: null, emailDomainKey: null }),
      );
      setSignals({ sameMailbox: 5, sameIp: 5, sameDomain: 5 });

      await expect(service.tryReward('referred_1')).resolves.toBe('rewarded');
    });

    it('teto total atingido: a trava não pega a linha e a indicação vai para revisão, sem crédito', async () => {
      const { service, prisma, tx } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      tx.referralCode.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.tryReward('referred_1')).resolves.toBe('review');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING, reason: null },
        data: { status: ReferralStatus.REVIEW, reason: 'cap_total' },
      });
      expectNoCredit(tx);
    });

    it('teto diário (padrão 10) só adia: continua PENDING com o motivo, sem pagar', async () => {
      const { service, prisma, tx, setTxCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setTxCounts({ today: 10 });

      await expect(service.tryReward('referred_1')).resolves.toBe('deferred');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { id: 'ref_1', status: ReferralStatus.PENDING, reason: null },
        data: { reason: 'cap_daily' },
      });
      expectNoCredit(tx);
    });

    it('teto global do dia (padrão 200) manda para revisão', async () => {
      const { service, prisma, tx, setTxCounts } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      setTxCounts({ global: 200 });

      await expect(service.tryReward('referred_1')).resolves.toBe('review');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: ReferralStatus.REVIEW, reason: 'cap_global' } }),
      );
      expectNoCredit(tx);
    });

    it('indicação adiada pelo dia volta a ser paga depois, e o motivo some', async () => {
      const { service, prisma, tx } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral({ reason: 'cap_daily' }));

      await expect(service.tryReward('referred_1')).resolves.toBe('rewarded');
      expect(tx.referral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ref_1', status: ReferralStatus.PENDING, reason: 'cap_daily' },
          data: expect.objectContaining({ reason: null }),
        }),
      );
    });

    it('os tetos seguem o app_settings; teto total 0 = tudo para revisão; diário 0 é inválido e usa 10', async () => {
      const custom = setup({ settings: { [SETTING_KEYS.referralMaxRewardsPerReferrer]: '3' } });
      custom.prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      await custom.service.tryReward('referred_1');
      expect(custom.tx.referralCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'referrer_1', rewardedCount: { lt: 3 } } }),
      );

      const manual = setup({ settings: { [SETTING_KEYS.referralMaxRewardsPerReferrer]: '0' } });
      manual.prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      await manual.service.tryReward('referred_1');
      expect(manual.tx.referralCode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'referrer_1', rewardedCount: { lt: 0 } } }),
      );

      const daily = setup({ settings: { [SETTING_KEYS.referralMaxRewardsPerDay]: '0' } });
      daily.prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      daily.setTxCounts({ today: 9 });
      await expect(daily.service.tryReward('referred_1')).resolves.toBe('rewarded');
      daily.setTxCounts({ today: 10 });
      await expect(daily.service.tryReward('referred_1')).resolves.toBe('deferred');
    });

    it('liberada pelo admin pula sinais e tetos, mas ainda exige indicado e indicador elegíveis', async () => {
      const { service, prisma, tx, setSignals, setTxCounts, eligibility } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral({ reason: APPROVED_BY_ADMIN }));
      setSignals({ sameMailbox: 3, sameIp: 3, sameDomain: 3 });
      setTxCounts({ today: 999, global: 999 });

      await expect(service.tryReward('referred_1')).resolves.toBe('rewarded');
      expect(prisma.referral.count).not.toHaveBeenCalled();
      expect(tx.referral.count).not.toHaveBeenCalled();
      expect(tx.referralCode.updateMany).toHaveBeenCalledWith({
        where: { userId: 'referrer_1' },
        data: { rewardedCount: { increment: 1 } },
      });
      expect(tx.referral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reason: APPROVED_BY_ADMIN }) }),
      );

      eligibility.referred = false;
      await expect(service.tryReward('referred_1')).resolves.toBe('not_eligible');
    });

    it('erro de banco vira "error", nunca sobe, e joga a linha para o fim da fila', async () => {
      const { service, prisma } = setup();
      prisma.referral.findUnique.mockRejectedValue(new Error('db fora'));

      await expect(service.tryReward('referred_1')).resolves.toBe('error');
      expect(prisma.referral.updateMany).toHaveBeenCalledWith({
        where: { referredUserId: 'referred_1', status: ReferralStatus.PENDING },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it('erro dentro da transação também não sobe e não marca nada como pago', async () => {
      const { service, prisma, tx } = setup();
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());
      tx.creditBalance.upsert.mockRejectedValue(new Error('deadlock'));

      await expect(service.tryReward('referred_1')).resolves.toBe('error');
      expect(prisma.referral.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: ReferralStatus.REWARDED }) }),
      );
    });
  });

  describe('attachOnSignup', () => {
    const ownerCode = { userId: 'referrer_1', user: { email: 'dono@gmail.com', isActive: true } };

    it('liga a conta nova como PENDING, com impressão do e-mail, domínio próprio e hash do IP (nunca o IP puro)', async () => {
      const { service, prisma } = setup({ env: { REFERRAL_IP_SALT: 'sal' } });
      prisma.referralCode.findUnique.mockResolvedValue(ownerCode);

      await service.attachOnSignup({
        referredUserId: 'referred_1',
        referredEmail: 'amiga@estudio-dela.com.br',
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
          emailFingerprint: emailFingerprint('amiga@estudio-dela.com.br'),
          emailDomainKey: emailDomainKey('amiga@estudio-dela.com.br'),
        }),
      );
      expect(data.signupIpHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain('203.0.113.7');
      expect(JSON.stringify(data)).not.toContain('estudio-dela');
    });

    it('sem REFERRAL_IP_SALT o sal sai do JWT_ACCESS_SECRET; sem nenhum (ou com o valor de reserva), o IP não é guardado', async () => {
      const derived = setup({ env: { JWT_ACCESS_SECRET: 'segredo-de-verdade' } });
      derived.prisma.referralCode.findUnique.mockResolvedValue(ownerCode);
      await derived.service.attachOnSignup({
        referredUserId: 'r',
        referredEmail: 'a@b.com',
        rawCode: 'AB12CD34',
        ipAddress: '203.0.113.7',
      });
      expect(derived.prisma.referral.create.mock.calls[0][0].data.signupIpHash).toMatch(/^[0-9a-f]{64}$/);

      const envs: Array<Record<string, string>> = [{}, { JWT_ACCESS_SECRET: 'default-secret-key' }];
      for (const env of envs) {
        const none = setup({ env });
        none.prisma.referralCode.findUnique.mockResolvedValue(ownerCode);
        await none.service.attachOnSignup({
          referredUserId: 'r',
          referredEmail: 'a@b.com',
          rawCode: 'AB12CD34',
          ipAddress: '203.0.113.7',
        });
        expect(none.prisma.referral.create.mock.calls[0][0].data.signupIpHash).toBeNull();
      }
    });

    it('alias do próprio e-mail nasce BLOCKED (self_alias); caixa temporária nasce BLOCKED (disposable_email)', async () => {
      const alias = setup();
      alias.prisma.referralCode.findUnique.mockResolvedValue(ownerCode);
      await alias.service.attachOnSignup({
        referredUserId: 'referred_1',
        referredEmail: 'do.no+2@googlemail.com',
        rawCode: 'AB12CD34',
      });
      expect(alias.prisma.referral.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ status: ReferralStatus.BLOCKED, reason: 'self_alias' }),
      );

      const temp = setup();
      temp.prisma.referralCode.findUnique.mockResolvedValue(ownerCode);
      await temp.service.attachOnSignup({
        referredUserId: 'referred_1',
        referredEmail: 'qualquer@yopmail.com',
        rawCode: 'AB12CD34',
      });
      expect(temp.prisma.referral.create.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ status: ReferralStatus.BLOCKED, reason: 'disposable_email' }),
      );
    });

    it('sem código, inválido, desconhecido, o próprio usuário ou dono desativado: nada é criado', async () => {
      const { service, prisma } = setup();
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com' });
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com', rawCode: 'x y' });
      prisma.referralCode.findUnique.mockResolvedValueOnce(null);
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com', rawCode: 'AB12CD34' });
      prisma.referralCode.findUnique.mockResolvedValueOnce({ userId: 'u', user: { email: 'a@b.com', isActive: true } });
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com', rawCode: 'AB12CD34' });
      prisma.referralCode.findUnique.mockResolvedValueOnce({
        userId: 'banido',
        user: { email: 'x@b.com', isActive: false },
      });
      await service.attachOnSignup({ referredUserId: 'u', referredEmail: 'a@b.com', rawCode: 'AB12CD34' });

      expect(prisma.referral.create).not.toHaveBeenCalled();
    });

    it('indicação desligada: o link não atribui ninguém (nada acumula para quando religar)', async () => {
      const { service, prisma } = setup({ settings: { [SETTING_KEYS.referralRewardCredits]: '0' } });
      await service.attachOnSignup({ referredUserId: 'r', referredEmail: 'a@b.com', rawCode: 'AB12CD34' });
      expect(prisma.referralCode.findUnique).not.toHaveBeenCalled();
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
    it('só busca pendentes com indicado E indicador elegíveis (fila nunca trava em indicador banido)', async () => {
      const { service, prisma } = setup();
      prisma.referral.findMany.mockResolvedValue([{ referredUserId: 'a' }, { referredUserId: 'b' }]);
      prisma.referral.findUnique.mockResolvedValue(pendingReferral());

      const counts = await service.sweepPending();
      expect(counts.rewarded).toBe(2);
      expect(prisma.referral.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: ReferralStatus.PENDING,
            referredUser: expect.objectContaining({ emailVerified: true, isActive: true }),
            referrer: { isActive: true, emailVerified: true },
          },
          orderBy: { updatedAt: 'asc' },
        }),
      );
    });

    it('lote inteiro com erro e nenhum pagamento lança (o cron fica ERROR, não SUCCESS)', async () => {
      const { service, prisma } = setup();
      prisma.referral.findMany.mockResolvedValue([{ referredUserId: 'a' }]);
      prisma.referral.findUnique.mockRejectedValue(new Error('db fora'));

      await expect(service.sweepPending()).rejects.toThrow(/nenhum pagamento/);
    });

    it('conta as indicações em revisão paradas há mais de 48 h', async () => {
      const { service, setSignals } = setup();
      setSignals({ staleReview: 3 });
      await expect(service.sweepPending()).resolves.toEqual(expect.objectContaining({ staleReview: 3 }));
    });

    it('desligado, nem consulta', async () => {
      const { service, prisma } = setup({ settings: { [SETTING_KEYS.referralRewardCredits]: '0' } });
      await service.sweepPending();
      expect(prisma.referral.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getSummary', () => {
    function withRecent(rows: unknown[]) {
      const ctx = setup();
      ctx.prisma.referralCode.findUnique.mockResolvedValue({ code: 'MEU22COD' });
      ctx.prisma.referral.groupBy.mockResolvedValue([
        { status: ReferralStatus.REWARDED, _count: { _all: 2 } },
        { status: ReferralStatus.PENDING, _count: { _all: 1 } },
        { status: ReferralStatus.REVIEW, _count: { _all: 1 } },
        { status: ReferralStatus.BLOCKED, _count: { _all: 1 } },
      ]);
      ctx.prisma.referral.aggregate.mockResolvedValue({ _sum: { creditsAwarded: 400 } });
      ctx.prisma.referral.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
      return ctx;
    }

    const row = (overrides: Record<string, unknown>) => ({
      id: 'r',
      status: ReferralStatus.PENDING,
      reason: null,
      creditsAwarded: 0,
      createdAt: new Date('2026-10-22T18:45:12Z'),
      referredUser: { name: 'Maria Clara Souza', emailVerified: true, generations: [] },
      ...overrides,
    });

    it('totais (revisão conta como pendente), etapa, só o primeiro nome e só o dia', async () => {
      const { service } = withRecent([row({ status: ReferralStatus.REVIEW })]);
      const summary = await service.getSummary('u1');
      expect(summary).toEqual(
        expect.objectContaining({
          enabled: true,
          code: 'MEU22COD',
          rewardCredits: 200,
          needsEmailVerification: false,
          totals: { invited: 5, rewarded: 2, pending: 2, creditsEarned: 400 },
        }),
      );
      expect(summary.recent[0]).toEqual(
        expect.objectContaining({ name: 'Maria', stage: 'in_review', createdAt: '2026-10-22' }),
      );
      expect(JSON.stringify(summary)).not.toContain('Souza');
      expect(JSON.stringify(summary)).not.toContain('18:45');
    });

    it('nome que veio do e-mail vira só a inicial', async () => {
      const { service } = withRecent([row({ referredUser: { name: 'joao.silva1990', emailVerified: true, generations: [] } })]);
      const summary = await service.getSummary('u1');
      expect(summary.recent[0].name).toBe('J•••');
      expect(JSON.stringify(summary)).not.toContain('silva1990');
    });

    it('etapas: criou mas não confirmou o e-mail; adiada pelo teto do dia', async () => {
      const { service } = withRecent([
        row({ id: 'a', referredUser: { name: 'Ana', emailVerified: false, generations: [{ id: 'g' }] } }),
        row({ id: 'b', reason: 'cap_daily', referredUser: { name: 'Bia', emailVerified: true, generations: [{ id: 'g' }] } }),
        row({ id: 'c', referredUser: { name: 'Caio', emailVerified: true, generations: [] } }),
      ]);
      const stages = (await service.getSummary('u1')).recent.map((item) => item.stage);
      expect(stages).toEqual(['waiting_email', 'scheduled', 'waiting_first_creation']);
    });

    it('quem indica sem e-mail confirmado: aviso no painel e nada é pago na hora', async () => {
      const ctx = withRecent([]);
      ctx.prisma.user.findUnique.mockResolvedValue({ emailVerified: false });
      const summary = await ctx.service.getSummary('u1');
      expect(summary.needsEmailVerification).toBe(true);
      expect(ctx.prisma.referral.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('stageOf', () => {
    it('nunca expõe o motivo de fraude', () => {
      const referred = { created: true, emailVerified: true };
      expect(stageOf(ReferralStatus.BLOCKED, 'duplicate_email', referred)).toBe('not_eligible');
      expect(stageOf(ReferralStatus.REVIEW, 'shared_ip', referred)).toBe('in_review');
      expect(stageOf(ReferralStatus.REWARDED, APPROVED_BY_ADMIN, referred)).toBe('rewarded');
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

    it('mudar a configuração grava só o que veio e devolve o que está em vigor', async () => {
      const { service, settings } = setup({ env: { REFERRAL_IP_SALT: 'sal' } });
      const result = await service.updateSettings({ rewardCredits: 0, maxRewardsPerDay: 5 });
      expect(settings.setInt).toHaveBeenCalledTimes(2);
      expect(settings.setInt).toHaveBeenCalledWith(SETTING_KEYS.referralRewardCredits, 0);
      expect(settings.setInt).toHaveBeenCalledWith(SETTING_KEYS.referralMaxRewardsPerDay, 5);
      expect(result).toEqual(
        expect.objectContaining({ maxRewardsPerReferrer: 50, maxRewardsGlobalPerDay: 200, ipRuleActive: true }),
      );
    });

    it('sem sal configurado, a configuração avisa que a regra de IP está desligada', async () => {
      await expect(setup().service.getSettings()).resolves.toEqual(expect.objectContaining({ ipRuleActive: false }));
    });
  });
});
