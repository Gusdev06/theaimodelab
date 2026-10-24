import {
  ConflictException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from '../auth.service';
import { ACCOUNT_DISABLED_CODE } from '../strategies/jwt.strategy';

jest.mock('bcrypt');

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

type UserRow = {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  avatarUrl: string | null;
  role: string;
  oauthProvider: string | null;
  oauthProviderId: string | null;
  emailVerified: boolean;
  isActive: boolean;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
  hasCompletedOnboarding: boolean;
  createdAt: Date;
};

const baseUser = (extra: Partial<UserRow> = {}): UserRow => ({
  id: 'user-1',
  email: 'maria@exemplo.com',
  name: 'Maria',
  passwordHash: 'hash',
  avatarUrl: null,
  role: 'USER',
  oauthProvider: 'google',
  oauthProviderId: 'google-1',
  emailVerified: true,
  isActive: true,
  termsAcceptedAt: null,
  termsVersion: null,
  hasCompletedOnboarding: true,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  ...extra,
});

/** Busca de usuário que respeita os filtros usados pelo AuthService (inclusive isActive). */
function matches(row: UserRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR')
      return (value as Record<string, unknown>[]).some((part) =>
        matches(row, part),
      );
    if (key === 'AND')
      return (value as Record<string, unknown>[]).every((part) =>
        matches(row, part),
      );
    return (row as Record<string, unknown>)[key] === value;
  });
}

function setup(users: UserRow[]) {
  const prisma = {
    user: {
      findUnique: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          users.find((row) => matches(row, where)) ?? null,
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          users.find((row) => matches(row, where)) ?? null,
      ),
      create: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(async () => ({ id: 'rt-new' })),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const jwt = { signAsync: jest.fn(async () => 'access-token') };
  const config = {
    get: jest.fn((key: string) =>
      key === 'GOOGLE_CLIENT_ID' ? 'client-id' : undefined,
    ),
    getOrThrow: jest.fn(() => 'segredo'),
  };
  const email = {
    sendWelcomeEmail: jest.fn(async () => undefined),
    sendVerificationEmail: jest.fn(async () => undefined),
  };
  const pendingGrants = { consumeForUser: jest.fn(async () => undefined) };
  const meta = { trackLead: jest.fn(async () => undefined) };
  const welcome = { grantIfEligible: jest.fn(async () => undefined) };
  const service = new AuthService(
    prisma as never,
    jwt as never,
    config as never,
    email as never,
    pendingGrants as never,
    meta as never,
    welcome as never,
    { attachOnSignup: jest.fn(async () => undefined), tryReward: jest.fn(async () => undefined) } as never,
  );
  return { service, prisma, jwt };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('era para recusar');
}

function expectAccountDisabled(error: unknown): void {
  expect(error).toBeInstanceOf(UnauthorizedException);
  expect((error as UnauthorizedException).getResponse()).toEqual({
    code: ACCOUNT_DISABLED_CODE,
    message: expect.stringContaining('desativada'),
  });
}

const googleProfile = {
  googleId: 'google-1',
  email: 'Maria@Exemplo.com',
  name: 'Maria',
  provider: 'google',
};

describe('AuthService: conta desativada não recebe token', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe('googleAuth', () => {
    it.each([
      [
        'achada pelo e-mail (conta de senha, sem Google vinculado)',
        { oauthProvider: null, oauthProviderId: null },
      ],
      [
        'achada pelo id do Google (e-mail diferente)',
        { email: 'outro@exemplo.com' },
      ],
    ])(
      'conta desativada %s: 401 ACCOUNT_DISABLED antes de vincular, criar ou emitir token',
      async (_case, extra) => {
        const ctx = setup([baseUser({ isActive: false, ...extra })]);

        expectAccountDisabled(
          await rejection(ctx.service.googleAuth(googleProfile)),
        );
        expect(ctx.prisma.user.update).not.toHaveBeenCalled();
        expect(ctx.prisma.user.create).not.toHaveBeenCalled();
        expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
        expect(ctx.prisma.refreshToken.create).not.toHaveBeenCalled();
        expect(ctx.jwt.signAsync).not.toHaveBeenCalled();
      },
    );

    it('conta ativa: entra normalmente', async () => {
      const ctx = setup([baseUser()]);
      const result = await ctx.service.googleAuth(googleProfile);
      expect(result).toMatchObject({
        accessToken: 'access-token',
        user: { id: 'user-1' },
        isNewUser: false,
      });
      expect(ctx.prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('googleAuthWithToken', () => {
    it('ID token válido de conta desativada: a mensagem de conta desativada chega (não vira "token inválido" nem tenta de novo)', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-1',
          email: 'maria@exemplo.com',
          name: 'Maria',
        }),
      });
      const ctx = setup([baseUser({ isActive: false })]);

      expectAccountDisabled(
        await rejection(ctx.service.googleAuthWithToken('id-token')),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ctx.prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('access token (2ª tentativa) de conta desativada: 401 ACCOUNT_DISABLED', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('not an id token'));
      fetchMock.mockResolvedValue(
        new Response(
          JSON.stringify({ sub: 'google-1', email: 'maria@exemplo.com' }),
          { status: 200 },
        ),
      );
      const ctx = setup([baseUser({ isActive: false })]);

      expectAccountDisabled(
        await rejection(ctx.service.googleAuthWithToken('access-token-google')),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(ctx.prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('erro do banco no login (token já conferido): o erro real sobe, sem tentar o token como access token', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ sub: 'google-1', email: 'maria@exemplo.com' }),
      });
      const ctx = setup([]);
      ctx.prisma.user.findFirst.mockRejectedValueOnce(new Error('db down'));

      await expect(ctx.service.googleAuthWithToken('id-token')).rejects.toThrow(
        'db down',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('token inválido continua 401 "Token Google inválido"', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('invalid'));
      fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
      const ctx = setup([]);

      const error = await rejection(ctx.service.googleAuthWithToken('lixo'));
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as Error).message).toContain('Token Google inválido');
    });

    it('access token sem o id do Google (sub): 401 sem buscar conta (filtro vazio acharia qualquer conta Google)', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('not an id token'));
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ email: 'maria@exemplo.com' }), {
          status: 200,
        }),
      );
      const ctx = setup([baseUser()]);

      const error = await rejection(
        ctx.service.googleAuthWithToken('access-token-google'),
      );
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as Error).message).toContain('Token Google inválido');
      expect(ctx.prisma.user.findFirst).not.toHaveBeenCalled();
      expect(ctx.prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('senha, renovação e cadastro', () => {
    it('login com senha certa de conta desativada: 401 e nenhum token', async () => {
      mockedBcrypt.compare.mockResolvedValue(true as never);
      const ctx = setup([baseUser({ isActive: false })]);

      await expect(
        ctx.service.login('maria@exemplo.com', 'senha-certa'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(ctx.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'maria@exemplo.com', isActive: true },
      });
      expect(ctx.prisma.refreshToken.create).not.toHaveBeenCalled();
      expect(ctx.jwt.signAsync).not.toHaveBeenCalled();
    });

    it('refresh de conta desativada (token ainda gravado): 401 e nenhum token novo', async () => {
      const ctx = setup([baseUser({ isActive: false })]);
      ctx.prisma.refreshToken.findFirst.mockResolvedValue({
        id: 'rt-1',
        userId: 'user-1',
        tokenHash: createHash('sha256').update('refresh').digest('hex'),
      });

      await expect(ctx.service.refreshTokens('refresh')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(ctx.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1', isActive: true },
      });
      expect(ctx.prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(ctx.prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('cadastro com o e-mail de conta desativada: 409 (antes caía no índice único e dava 500), sem criar conta', async () => {
      const ctx = setup([baseUser({ isActive: false })]);

      await expect(
        ctx.service.register({
          email: 'MARIA@exemplo.com',
          password: 'SenhaForte123!',
          name: 'Maria',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
      expect(ctx.prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });
});
