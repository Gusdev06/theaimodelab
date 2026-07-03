import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../../email/email.service';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';

jest.mock('bcrypt');

const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

// ── Fixtures ─────────────────────────────────────────────────────────

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  passwordHash: 'hashed-password',
  avatarUrl: null,
  role: 'USER',
  oauthProvider: null,
  oauthProviderId: null,
  emailVerified: false,
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const mockPlan = {
  id: 'plan-free',
  slug: 'free',
  name: 'Free',
  creditsPerMonth: 0,
};

// ── Mocks ────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  plan: { findFirst: jest.fn() },
  subscription: { create: jest.fn() },
  creditBalance: { create: jest.fn() },
  creditTransaction: { create: jest.fn() },
  affiliate: { findUnique: jest.fn() },
  emailVerificationToken: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  refreshToken: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  passwordResetToken: {
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn((fn) => fn(mockPrisma)),
};

const mockJwtService = {
  signAsync: jest.fn().mockResolvedValue('mock-access-token'),
};

const mockConfigService = {
  get: jest.fn((key: string) => {
    const config: Record<string, string> = {
      JWT_ACCESS_SECRET: 'test-secret',
      NODE_ENV: 'development',
      GOOGLE_CLIENT_ID: 'test-client-id',
    };
    return config[key];
  }),
};

const mockEmailService = {
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
};

// ── Test Suite ───────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EmailService, useValue: mockEmailService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // Helper: set up mocks so that generateTokens succeeds
  function setupGenerateTokensMocks(user = mockUser) {
    mockPrisma.refreshToken.create.mockResolvedValue({
      id: 'rt-1',
      userId: user.id,
      tokenHash: 'some-hash',
      expiresAt: new Date(),
      revoked: false,
    });
  }

  // ────────────────────── register ──────────────────────

  describe('register', () => {
    const registerDto = {
      email: 'Test@Example.com',
      password: 'SecurePassword123!',
      name: 'Test User',
    };

    it('should register successfully with valid data', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      (mockedBcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
      mockPrisma.user.create.mockResolvedValue(mockUser);
      mockPrisma.plan.findFirst.mockResolvedValue(mockPlan);
      mockPrisma.subscription.create.mockResolvedValue({});
      mockPrisma.creditBalance.create.mockResolvedValue({});
      mockPrisma.emailVerificationToken.create.mockResolvedValue({});
      setupGenerateTokensMocks();

      const result = await service.register(registerDto);

      // Verifies email is lowercased when checking for existing user
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com', isActive: true },
      });

      // Verifies password is hashed
      expect(mockedBcrypt.hash).toHaveBeenCalledWith(
        'SecurePassword123!',
        10,
      );

      // Verifies $transaction was used
      expect(mockPrisma.$transaction).toHaveBeenCalled();

      // Verifies user is created with lowercased email
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'test@example.com',
          name: 'Test User',
          passwordHash: 'hashed-password',
          role: 'USER',
        }),
      });

      // Verifies free plan lookup
      expect(mockPrisma.plan.findFirst).toHaveBeenCalledWith({
        where: { slug: 'free' },
      });

      // Verifies subscription creation
      expect(mockPrisma.subscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUser.id,
          planId: mockPlan.id,
          status: 'ACTIVE',
        }),
      });

      // Verifies credit balance creation (v5: Free starts with 0 credits)
      expect(mockPrisma.creditBalance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUser.id,
          planCreditsRemaining: 0,
          bonusCreditsRemaining: 0,
          planCreditsUsed: 0,
        }),
      });

      // Verifies tokens are returned
      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({
          id: mockUser.id,
          email: mockUser.email,
          name: mockUser.name,
        }),
      });
    });

    it('should throw ConflictException if email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      await expect(service.register(registerDto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.register(registerDto)).rejects.toThrow(
        'Email já cadastrado',
      );

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if Free plan not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      (mockedBcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
      mockPrisma.user.create.mockResolvedValue(mockUser);
      mockPrisma.plan.findFirst.mockResolvedValue(null);

      await expect(service.register(registerDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should lowercase the email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      (mockedBcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
      mockPrisma.user.create.mockResolvedValue(mockUser);
      mockPrisma.plan.findFirst.mockResolvedValue(mockPlan);
      mockPrisma.subscription.create.mockResolvedValue({});
      mockPrisma.creditBalance.create.mockResolvedValue({});
      mockPrisma.emailVerificationToken.create.mockResolvedValue({});
      setupGenerateTokensMocks();

      await service.register({
        email: 'TEST@EXAMPLE.COM',
        password: 'SecurePassword123!',
        name: 'Test',
      });

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com', isActive: true },
      });
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ email: 'test@example.com' }),
      });
    });
  });

  // ────────────────────── login ──────────────────────

  describe('login', () => {
    it('should login successfully with correct credentials', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (mockedBcrypt.compare as jest.Mock).mockResolvedValue(true);
      setupGenerateTokensMocks();

      const result = await service.login('test@example.com', 'correct-password');

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com', isActive: true },
      });
      expect(mockedBcrypt.compare).toHaveBeenCalledWith(
        'correct-password',
        mockUser.passwordHash,
      );
      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({
          id: mockUser.id,
          email: mockUser.email,
        }),
      });
    });

    it('should throw UnauthorizedException with wrong password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (mockedBcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login('test@example.com', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.login('test@example.com', 'wrong-password'),
      ).rejects.toThrow('Email ou senha inválidos');
    });

    it('should throw UnauthorizedException with non-existent email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login('nonexistent@example.com', 'any-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for OAuth-only user (no passwordHash)', async () => {
      const oauthUser = { ...mockUser, passwordHash: null };
      mockPrisma.user.findUnique.mockResolvedValue(oauthUser);

      await expect(
        service.login('test@example.com', 'any-password'),
      ).rejects.toThrow(UnauthorizedException);

      // bcrypt.compare should never be called if passwordHash is null
      expect(mockedBcrypt.compare).not.toHaveBeenCalled();
    });

    it('should lowercase the email when logging in', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      (mockedBcrypt.compare as jest.Mock).mockResolvedValue(true);
      setupGenerateTokensMocks();

      await service.login('TEST@EXAMPLE.COM', 'correct-password');

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com', isActive: true },
      });
    });
  });

  // ────────────────────── refreshTokens ──────────────────────

  describe('refreshTokens', () => {
    const refreshTokenValue = 'valid-refresh-token';
    const tokenHash = createHash('sha256')
      .update(refreshTokenValue)
      .digest('hex');

    const mockStoredToken = {
      id: 'stored-token-1',
      userId: mockUser.id,
      tokenHash,
      revoked: false,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    };

    it('should refresh tokens successfully with valid refresh token', async () => {
      mockPrisma.refreshToken.findFirst.mockResolvedValue(mockStoredToken);
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.refreshToken.update.mockResolvedValue({});
      setupGenerateTokensMocks();

      const result = await service.refreshTokens(refreshTokenValue);

      // Verifies token lookup
      expect(mockPrisma.refreshToken.findFirst).toHaveBeenCalledWith({
        where: {
          tokenHash,
          revoked: false,
          expiresAt: { gt: expect.any(Date) },
        },
      });

      // Verifies user lookup
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: mockUser.id, isActive: true },
      });

      // Verifies old token is revoked
      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: mockStoredToken.id },
        data: { revoked: true },
      });

      // Returns new tokens
      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({ id: mockUser.id }),
      });
    });

    it('should throw UnauthorizedException if token not found', async () => {
      mockPrisma.refreshToken.findFirst.mockResolvedValue(null);

      await expect(
        service.refreshTokens('nonexistent-token'),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshTokens('nonexistent-token'),
      ).rejects.toThrow('Token inválido ou expirado');
    });

    it('should throw UnauthorizedException if token is revoked', async () => {
      // When revoked: false is in the query and token IS revoked,
      // findFirst returns null
      mockPrisma.refreshToken.findFirst.mockResolvedValue(null);

      await expect(
        service.refreshTokens(refreshTokenValue),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if token is expired', async () => {
      // When expiresAt: { gt: new Date() } is in the query and token IS expired,
      // findFirst returns null
      mockPrisma.refreshToken.findFirst.mockResolvedValue(null);

      await expect(
        service.refreshTokens(refreshTokenValue),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException if user is inactive', async () => {
      mockPrisma.refreshToken.findFirst.mockResolvedValue(mockStoredToken);
      // findUnique with isActive: true returns null for inactive users
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.refreshTokens(refreshTokenValue),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        service.refreshTokens(refreshTokenValue),
      ).rejects.toThrow('Usuário não encontrado');
    });

    it('should revoke old token and generate new pair', async () => {
      mockPrisma.refreshToken.findFirst.mockResolvedValue(mockStoredToken);
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.refreshToken.update.mockResolvedValue({});
      setupGenerateTokensMocks();

      const result = await service.refreshTokens(refreshTokenValue);

      // Old token revoked
      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: mockStoredToken.id },
        data: { revoked: true },
      });

      // New refresh token created in DB (via generateTokens)
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUser.id,
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      });

      // New JWT access token created
      expect(mockJwtService.signAsync).toHaveBeenCalledWith(
        { sub: mockUser.id, email: mockUser.email, role: mockUser.role },
        { secret: 'test-secret', expiresIn: '15m' },
      );

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toEqual(expect.any(String));
    });
  });

  // ────────────────────── logout ──────────────────────

  describe('logout', () => {
    it('should revoke refresh token successfully', async () => {
      const refreshTokenValue = 'some-refresh-token';
      const tokenHash = createHash('sha256')
        .update(refreshTokenValue)
        .digest('hex');

      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.logout(refreshTokenValue);

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash },
        data: { revoked: true },
      });
      expect(result).toEqual({ message: 'Logout realizado com sucesso' });
    });

    it('should be idempotent (not throw if token does not exist)', async () => {
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.logout('nonexistent-token');

      expect(result).toEqual({ message: 'Logout realizado com sucesso' });
    });
  });
});
