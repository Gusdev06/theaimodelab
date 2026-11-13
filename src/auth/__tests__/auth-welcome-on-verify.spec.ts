import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from '../auth.service';

jest.mock('bcrypt');

/**
 * C-01 (jornada 13/11): cadastro por e-mail entra no app na hora com os 50 do cadastro; os créditos de
 * boas-vindas caem na confirmação do e-mail (idempotente). B-01: compra feita antes da conta é aplicada no
 * cadastro, antes de devolver os tokens.
 */
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

function setup() {
  const newUser = {
    id: 'user-1',
    email: 'ana@mail.com',
    name: 'Ana',
    passwordHash: 'hash',
    avatarUrl: null,
    role: 'USER',
    emailVerified: false,
    isActive: true,
    hasCompletedOnboarding: false,
    termsAcceptedAt: null,
    termsVersion: null,
    imageDeclarationAt: null,
    referredByCode: null,
    signupBrand: null,
    locale: 'en-US',
    country: 'AR',
    phone: null,
    fbp: null,
    fbc: null,
    createdAt: new Date(),
  };
  const tx = {
    affiliate: { findUnique: jest.fn() },
    user: { create: jest.fn(async () => newUser), update: jest.fn() },
    plan: { findFirst: jest.fn(async () => ({ id: 'free' })) },
    subscription: { create: jest.fn() },
    creditBalance: { create: jest.fn() },
    creditTransaction: { create: jest.fn() },
    emailVerificationToken: { update: jest.fn() },
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) =>
        where.id === 'user-1' ? { ...newUser, emailVerified: true } : null,
      ),
    },
    emailVerificationToken: {
      create: jest.fn(),
      findFirst: jest.fn(async () => ({ id: 'tok-1', userId: 'user-1' })),
    },
    creditBalance: {
      findUnique: jest.fn(async () => ({ planCreditsRemaining: 0, bonusCreditsRemaining: 200 })),
    },
    refreshToken: { create: jest.fn() },
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const email = {
    sendVerificationEmail: jest.fn(async () => true),
    sendWelcomeEmail: jest.fn(async () => undefined),
  };
  const welcome = {
    grantIfEligible: jest.fn(async () => 150),
    pendingAmountFor: jest.fn(async () => 150),
  };
  const claimer = { claimForUser: jest.fn(async () => ({ applied: 1, failed: 0 })) };
  const service = new AuthService(
    prisma as never,
    { signAsync: jest.fn(async () => 'access') } as never,
    { get: jest.fn(), getOrThrow: jest.fn(() => 'segredo') } as never,
    email as never,
    { consumeForUser: jest.fn(async () => undefined) } as never,
    { trackLead: jest.fn(async () => undefined) } as never,
    welcome as never,
    { attachOnSignup: jest.fn(async () => undefined), tryReward: jest.fn(async () => undefined) } as never,
    claimer as never,
  );
  return { service, email, welcome, claimer };
}

describe('AuthService · bônus de boas-vindas na confirmação do e-mail', () => {
  beforeEach(() => {
    mockedBcrypt.hash.mockResolvedValue('hash' as never);
  });

  it('cadastro por e-mail devolve os tokens, não concede o welcome e promete +150 no e-mail do código', async () => {
    const { service, email, welcome, claimer } = setup();

    const result = await service.register({ email: 'Ana@Mail.com', password: 'Senha1234', name: 'Ana' });

    expect(result.accessToken).toBe('access');
    expect(result.isNewUser).toBe(true);
    expect(welcome.grantIfEligible).not.toHaveBeenCalled();
    expect(claimer.claimForUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }));
    expect(email.sendVerificationEmail).toHaveBeenCalledWith(
      'ana@mail.com',
      'Ana',
      expect.stringMatching(/^\d{6}$/),
      expect.anything(),
      { locale: 'es', bonusCredits: 150 },
    );
  });

  it('confirmar o e-mail concede o welcome e manda as boas-vindas com o saldo', async () => {
    const { service, email, welcome } = setup();

    const result = await service.verifyEmail('123456');
    await new Promise((resolve) => setImmediate(resolve));

    expect(welcome.grantIfEligible).toHaveBeenCalledWith('user-1');
    expect(result).toEqual({ message: 'Email verificado com sucesso', welcomeCreditsGranted: 150 });
    expect(email.sendWelcomeEmail).toHaveBeenCalledWith('ana@mail.com', 'Ana', expect.anything(), {
      locale: 'es',
      credits: 200,
    });
  });

  it('o código é buscado pelo hash', async () => {
    const { service } = setup();
    await service.verifyEmail('654321');
    const prisma = (service as unknown as { prisma: { emailVerificationToken: { findFirst: jest.Mock } } }).prisma;
    expect(prisma.emailVerificationToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tokenHash: createHash('sha256').update('654321').digest('hex') }),
      }),
    );
  });
});
