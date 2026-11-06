import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth.service';

jest.mock('bcrypt');
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: jest.fn() })),
}));

/**
 * Ponte Pack → plataforma no cadastro: a conta que acabou de ganhar afiliado dentro da
 * transação (consumeForUser) não entra também no "indique e ganhe". Com a ponte desligada
 * o cadastro não faz nenhuma leitura a mais.
 */
describe('AuthService · cadastro com a ponte Pack → plataforma', () => {
  const ORIGINAL_FLAG = process.env.PACK_AFFILIATE_BRIDGE_ENABLED;

  beforeEach(() => {
    (bcrypt.hash as jest.Mock).mockResolvedValue('hash');
  });

  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
    else process.env.PACK_AFFILIATE_BRIDGE_ENABLED = ORIGINAL_FLAG;
  });

  /**
   * `bridgedCode` = o que a ponte gravou em referredByCode durante a transação
   * (null = a ponte não atribuiu ninguém). A releitura por id devolve esse valor.
   */
  function setup(opts: { bridgedCode: string | null; rereadFails?: boolean }) {
    const createdUser = {
      id: 'user-new',
      email: 'buyer@mail.com',
      name: 'Buyer',
      avatarUrl: null,
      role: 'USER',
      emailVerified: false,
      hasCompletedOnboarding: false,
      termsAcceptedAt: null,
      termsVersion: null,
      createdAt: new Date('2026-11-06T12:00:00Z'),
      referredByCode: null,
      signupBrand: null,
    };
    const tx = {
      affiliate: { findUnique: jest.fn(async () => null) },
      user: { create: jest.fn(async ({ data }: any) => ({ ...createdUser, ...data, id: 'user-new' })) },
      plan: { findFirst: jest.fn(async () => ({ id: 'plan-free', slug: 'free' })) },
      subscription: { create: jest.fn(async () => ({})) },
      creditBalance: { create: jest.fn(async () => ({})) },
      creditTransaction: { create: jest.fn(async () => ({})) },
    };
    const prisma = {
      user: {
        // 1ª leitura: e-mail livre? (por e-mail) · releitura da ponte: por id
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.email !== undefined) return null;
          if (opts.rereadFails) throw new Error('conexão caiu');
          return { referredByCode: opts.bridgedCode };
        }),
        findFirst: jest.fn(async () => null),
      },
      emailVerificationToken: { create: jest.fn(async () => ({})) },
      refreshToken: { create: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const referralsService = { attachOnSignup: jest.fn(async () => undefined) };
    const pendingGrantsService = { consumeForUser: jest.fn(async () => 1) };
    const service = new AuthService(
      prisma as never,
      { signAsync: jest.fn(async () => 'jwt') } as never,
      { getOrThrow: jest.fn(() => 'secret'), get: jest.fn(() => undefined) } as never,
      {
        sendVerificationEmail: jest.fn(async () => undefined),
        sendWelcomeEmail: jest.fn(async () => undefined),
      } as never,
      pendingGrantsService as never,
      { trackLead: jest.fn(async () => undefined) } as never,
      { grantIfEligible: jest.fn(async () => undefined) } as never,
      referralsService as never,
    );
    const rereads = () =>
      (prisma.user.findUnique.mock.calls as any[][]).filter(([args]) => args.where.id !== undefined).length;
    return { service, prisma, tx, referralsService, pendingGrantsService, rereads };
  }

  const registration = { email: 'Buyer@Mail.com', password: 'Senha!12345', name: 'Buyer', referralCode: 'K7Q3M9XP' };
  const googleUser = {
    googleId: 'google-1',
    email: 'Buyer@Mail.com',
    name: 'Buyer',
    provider: 'google',
    referralCode: 'K7Q3M9XP',
  };

  describe('cadastro por e-mail', () => {
    it('ponte ligada e conta atribuída a um afiliado: não entra no "indique e ganhe"', async () => {
      process.env.PACK_AFFILIATE_BRIDGE_ENABLED = 'true';
      const { service, tx, referralsService, pendingGrantsService, rereads } = setup({ bridgedCode: 'PARCEIRA' });

      const result = await service.register(registration as never);

      expect(result.isNewUser).toBe(true);
      // dentro da transação do cadastro (é ali que a ponte grava o afiliado)
      expect(pendingGrantsService.consumeForUser).toHaveBeenCalledWith('user-new', 'buyer@mail.com', tx);
      expect(rereads()).toBe(1);
      expect(referralsService.attachOnSignup).not.toHaveBeenCalled();
    });

    it('ponte ligada, mas a ponte não atribuiu ninguém: indicação segue como sempre', async () => {
      process.env.PACK_AFFILIATE_BRIDGE_ENABLED = 'true';
      const { service, referralsService } = setup({ bridgedCode: null });

      await service.register(registration as never);

      expect(referralsService.attachOnSignup).toHaveBeenCalledWith(
        expect.objectContaining({ referredUserId: 'user-new', rawCode: 'K7Q3M9XP' }),
      );
    });

    it('ponte desligada (padrão): nenhuma leitura a mais e a indicação roda', async () => {
      delete process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
      const { service, referralsService, rereads } = setup({ bridgedCode: 'PARCEIRA' });

      await service.register(registration as never);

      expect(rereads()).toBe(0);
      expect(referralsService.attachOnSignup).toHaveBeenCalledTimes(1);
    });

    it('releitura falhou: o cadastro conclui e, na dúvida, não dá a indicação', async () => {
      process.env.PACK_AFFILIATE_BRIDGE_ENABLED = 'true';
      const { service, referralsService } = setup({ bridgedCode: null, rereadFails: true });

      const result = await service.register(registration as never);

      expect(result.accessToken).toBe('jwt');
      expect(referralsService.attachOnSignup).not.toHaveBeenCalled();
    });
  });

  describe('cadastro pelo Google', () => {
    it('ponte ligada e conta atribuída: não entra no "indique e ganhe"', async () => {
      process.env.PACK_AFFILIATE_BRIDGE_ENABLED = 'true';
      const { service, referralsService, rereads } = setup({ bridgedCode: 'PARCEIRA' });

      const result = await service.googleAuth(googleUser);

      expect(result.isNewUser).toBe(true);
      expect(rereads()).toBe(1);
      expect(referralsService.attachOnSignup).not.toHaveBeenCalled();
    });

    it('ponte desligada: indicação roda, sem leitura a mais', async () => {
      delete process.env.PACK_AFFILIATE_BRIDGE_ENABLED;
      const { service, referralsService, rereads } = setup({ bridgedCode: 'PARCEIRA' });

      await service.googleAuth(googleUser);

      expect(rereads()).toBe(0);
      expect(referralsService.attachOnSignup).toHaveBeenCalledTimes(1);
    });
  });
});
