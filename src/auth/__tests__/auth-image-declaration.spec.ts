import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from '../auth.service';

jest.mock('bcrypt');

const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

interface UserRow {
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
  imageDeclarationAt?: Date | null;
  imageDeclarationVersion?: string | null;
  hasCompletedOnboarding: boolean;
  createdAt: Date;
}

const DECLARED_AT = new Date('2026-11-06T18:30:00.000Z');

const userRow = (extra: Partial<UserRow> = {}): UserRow => ({
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

const REFRESH_TOKEN = 'refresh-token-da-maria';

function setup(user: UserRow) {
  const byWhere = async ({ where }: { where: Record<string, unknown> }) => {
    if (Array.isArray(where.OR)) return user;
    const keys = Object.keys(where);
    return keys.every((key) => (user as unknown as Record<string, unknown>)[key] === where[key]) ? user : null;
  };
  const prisma = {
    user: { findUnique: jest.fn(byWhere), findFirst: jest.fn(byWhere), create: jest.fn(), update: jest.fn() },
    refreshToken: {
      create: jest.fn(async () => ({ id: 'rt-new' })),
      findFirst: jest.fn(async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === createHash('sha256').update(REFRESH_TOKEN).digest('hex')
          ? { id: 'rt-1', userId: user.id, revoked: false, expiresAt: new Date(Date.now() + 60_000) }
          : null,
      ),
      update: jest.fn(async () => ({ id: 'rt-1' })),
    },
    $transaction: jest.fn(),
  };
  const service = new AuthService(
    prisma as never,
    { signAsync: jest.fn(async () => 'access-token') } as never,
    { get: jest.fn(() => undefined), getOrThrow: jest.fn(() => 'segredo') } as never,
    { sendWelcomeEmail: jest.fn(async () => undefined), sendVerificationEmail: jest.fn(async () => undefined) } as never,
    { consumeForUser: jest.fn(async () => undefined) } as never,
    { trackLead: jest.fn(async () => undefined) } as never,
    { grantIfEligible: jest.fn(async () => undefined) } as never,
    { attachOnSignup: jest.fn(async () => undefined), tryReward: jest.fn(async () => undefined) } as never,
  );
  return { service, prisma };
}

/**
 * O usuário devolvido por login, refresh e Google traz imageDeclarationAt: o site sabe, sem outra chamada, se a
 * conta já fez a declaração de responsabilidade pelas imagens (e não pergunta de novo).
 */
describe('AuthService: imageDeclarationAt no usuário devolvido', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    (mockedBcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each([
    ['conta que já declarou', { imageDeclarationAt: DECLARED_AT, imageDeclarationVersion: '2026-11-06' }, DECLARED_AT],
    ['conta que ainda não declarou', { imageDeclarationAt: null, imageDeclarationVersion: null }, null],
    ['linha sem a coluna (código novo antes da migração nos testes antigos)', {}, null],
  ])('%s', (_case, extra, expected) => {
    it('login por e-mail e senha', async () => {
      const { service } = setup(userRow(extra));
      const result = await service.login('maria@exemplo.com', 'senha');
      expect(result.user.imageDeclarationAt).toEqual(expected);
      expect(result.user).toMatchObject({ id: 'user-1', email: 'maria@exemplo.com' });
    });

    it('refresh do token', async () => {
      const { service } = setup(userRow(extra));
      const result = await service.refreshTokens(REFRESH_TOKEN);
      expect(result.user.imageDeclarationAt).toEqual(expected);
    });

    it('login com o Google', async () => {
      const { service } = setup(userRow(extra));
      const result = await service.googleAuth({ googleId: 'google-1', email: 'maria@exemplo.com', name: 'Maria', provider: 'google' });
      expect(result.user.imageDeclarationAt).toEqual(expected);
      expect(result.isNewUser).toBe(false);
    });
  });

  it('a resposta em JSON leva a data em ISO (ou null), e os outros campos do usuário continuam lá', async () => {
    const { service } = setup(userRow({ imageDeclarationAt: DECLARED_AT, imageDeclarationVersion: '2026-11-06' }));
    const result = await service.login('maria@exemplo.com', 'senha');
    const json = JSON.parse(JSON.stringify(result)) as { user: Record<string, unknown> };
    expect(json.user.imageDeclarationAt).toBe('2026-11-06T18:30:00.000Z');
    expect(Object.keys(json.user)).toEqual(
      expect.arrayContaining(['id', 'email', 'name', 'role', 'emailVerified', 'termsAcceptedAt', 'termsVersion', 'createdAt']),
    );
  });
});
