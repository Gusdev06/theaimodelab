import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth.service';

jest.mock('bcrypt');
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: jest.fn() })),
}));

/**
 * Ponte Pack → plataforma no cadastro (e-mail e Google): a transação só consome as grants e
 * devolve a venda candidata; a atribuição ao afiliado acontece depois do commit e nunca
 * derruba o cadastro. Conta atribuída não entra também no "indique e ganhe". Login (conta
 * que já existia) nunca atribui.
 */
describe('AuthService · cadastro com a ponte Pack → plataforma', () => {
  beforeEach(() => {
    (bcrypt.hash as jest.Mock).mockResolvedValue('hash');
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  const candidate = {
    grantId: 'g1',
    affiliateRef: 'ppcode:PPAJFTR',
    buyerEmail: 'buyer@mail.com',
    grantCreatedAt: new Date('2026-11-01T10:00:00Z'),
  };
  const CREATED_AT = new Date('2026-11-06T12:00:00Z');

  /**
   * `packBridge` = venda candidata que a transação devolve (null = compra sem afiliado ou ponte
   * desligada). `attributedCode` = o que a atribuição pós-commit devolve.
   */
  function setup(opts: {
    packBridge: typeof candidate | null;
    attributedCode?: string | null;
    attributionThrows?: boolean;
    existingUser?: Record<string, unknown> | null;
  }) {
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
      createdAt: CREATED_AT,
      referredByCode: null,
      signupBrand: null,
    };
    const events: string[] = [];
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
        findUnique: jest.fn(async () => opts.existingUser ?? null),
        findFirst: jest.fn(async () => opts.existingUser ?? null),
        update: jest.fn(async () => opts.existingUser ?? null),
      },
      emailVerificationToken: { create: jest.fn(async () => ({})) },
      refreshToken: { create: jest.fn(async () => ({})) },
      $transaction: jest.fn(async (fn: any) => {
        const result = await fn(tx);
        events.push('commit');
        return result;
      }),
    };
    const referralsService = { attachOnSignup: jest.fn(async () => undefined) };
    const pendingGrantsService = {
      consumeForSignup: jest.fn(async () => {
        events.push('consumeForSignup');
        return { consumed: 1, packBridge: opts.packBridge };
      }),
      consumeForUser: jest.fn(async () => {
        events.push('consumeForUser');
        return 1;
      }),
      attributeSignupToPackAffiliate: jest.fn(async () => {
        events.push('attribute');
        if (opts.attributionThrows) throw new Error('conexão caiu');
        return opts.attributedCode ?? null;
      }),
    };
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
    return { service, prisma, tx, referralsService, pendingGrantsService, events };
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
    it('a transação só consome; a atribuição acontece depois do commit, com a venda que ela devolveu', async () => {
      const { service, tx, pendingGrantsService, events, prisma } = setup({
        packBridge: candidate,
        attributedCode: 'PARCEIRA',
      });

      const result = await service.register(registration as never);

      expect(result.isNewUser).toBe(true);
      expect(pendingGrantsService.consumeForSignup).toHaveBeenCalledWith('user-new', 'buyer@mail.com', tx);
      expect(pendingGrantsService.attributeSignupToPackAffiliate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-new', createdAt: CREATED_AT }),
        candidate,
      );
      expect(events.slice(0, 3)).toEqual(['consumeForSignup', 'commit', 'attribute']);
      // usa o resultado direto: nenhuma releitura da conta por id
      const rereads = (prisma.user.findUnique.mock.calls as any[][]).filter(([args]) => args?.where?.id !== undefined);
      expect(rereads).toEqual([]);
    });

    it('conta atribuída a um afiliado não entra no "indique e ganhe"', async () => {
      const { service, referralsService } = setup({ packBridge: candidate, attributedCode: 'PARCEIRA' });

      await service.register(registration as never);

      expect(referralsService.attachOnSignup).not.toHaveBeenCalled();
    });

    it('havia venda candidata, mas ninguém foi atribuído: a indicação segue como sempre', async () => {
      const { service, referralsService } = setup({ packBridge: candidate, attributedCode: null });

      await service.register(registration as never);

      expect(referralsService.attachOnSignup).toHaveBeenCalledWith(
        expect.objectContaining({ referredUserId: 'user-new', rawCode: 'K7Q3M9XP' }),
      );
    });

    it('sem venda candidata (ponte desligada ou compra sem afiliado): nada a mais é chamado', async () => {
      const { service, referralsService, pendingGrantsService } = setup({ packBridge: null });

      await service.register(registration as never);

      expect(pendingGrantsService.attributeSignupToPackAffiliate).not.toHaveBeenCalled();
      expect(referralsService.attachOnSignup).toHaveBeenCalledTimes(1);
    });

    it('erro na atribuição não derruba o cadastro: a conta nasce e a indicação segue', async () => {
      const { service, referralsService } = setup({ packBridge: candidate, attributionThrows: true });

      const result = await service.register(registration as never);

      expect(result.accessToken).toBe('jwt');
      expect(result.isNewUser).toBe(true);
      expect(referralsService.attachOnSignup).toHaveBeenCalledTimes(1);
    });
  });

  describe('cadastro pelo Google', () => {
    it('conta nova: consome na transação, atribui depois do commit e não entra no "indique e ganhe"', async () => {
      const { service, referralsService, pendingGrantsService, events, tx } = setup({
        packBridge: candidate,
        attributedCode: 'PARCEIRA',
      });

      const result = await service.googleAuth(googleUser);

      expect(result.isNewUser).toBe(true);
      expect(pendingGrantsService.consumeForSignup).toHaveBeenCalledWith('user-new', 'buyer@mail.com', tx);
      expect(pendingGrantsService.attributeSignupToPackAffiliate).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-new' }),
        candidate,
      );
      expect(events.slice(0, 3)).toEqual(['consumeForSignup', 'commit', 'attribute']);
      expect(referralsService.attachOnSignup).not.toHaveBeenCalled();
    });

    it('sem venda candidata: indicação roda, sem chamada a mais', async () => {
      const { service, referralsService, pendingGrantsService } = setup({ packBridge: null });

      await service.googleAuth(googleUser);

      expect(pendingGrantsService.attributeSignupToPackAffiliate).not.toHaveBeenCalled();
      expect(referralsService.attachOnSignup).toHaveBeenCalledTimes(1);
    });

    it('erro na atribuição não derruba o cadastro pelo Google', async () => {
      const { service, referralsService } = setup({ packBridge: candidate, attributionThrows: true });

      const result = await service.googleAuth(googleUser);

      expect(result.accessToken).toBe('jwt');
      expect(referralsService.attachOnSignup).toHaveBeenCalledTimes(1);
    });
  });

  describe('login (conta que já existia) nunca atribui', () => {
    const existing = {
      id: 'user-old',
      email: 'buyer@mail.com',
      name: 'Buyer',
      avatarUrl: null,
      role: 'USER',
      isActive: true,
      emailVerified: true,
      passwordHash: 'hash',
      oauthProvider: 'google',
      oauthProviderId: 'google-1',
      hasCompletedOnboarding: true,
      termsAcceptedAt: null,
      termsVersion: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      referredByCode: null,
      signupBrand: null,
    };

    it('login pelo Google: as grants são consumidas pelo caminho do login, sem atribuição', async () => {
      const { service, pendingGrantsService, referralsService } = setup({ packBridge: candidate, existingUser: existing });

      const result = await service.googleAuth(googleUser);
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.isNewUser).toBe(false);
      expect(pendingGrantsService.consumeForUser).toHaveBeenCalledWith('user-old', 'buyer@mail.com');
      expect(pendingGrantsService.consumeForSignup).not.toHaveBeenCalled();
      expect(pendingGrantsService.attributeSignupToPackAffiliate).not.toHaveBeenCalled();
      expect(referralsService.attachOnSignup).not.toHaveBeenCalled();
    });

    it('login por senha: idem', async () => {
      const { service, pendingGrantsService } = setup({ packBridge: candidate, existingUser: existing });

      await service.login('buyer@mail.com', 'Senha!12345');
      await new Promise((resolve) => setImmediate(resolve));

      expect(pendingGrantsService.consumeForUser).toHaveBeenCalledWith('user-old', 'buyer@mail.com');
      expect(pendingGrantsService.consumeForSignup).not.toHaveBeenCalled();
      expect(pendingGrantsService.attributeSignupToPackAffiliate).not.toHaveBeenCalled();
    });
  });
});
