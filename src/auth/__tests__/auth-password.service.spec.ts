import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../../email/email.service';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt');

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

// ── Mock data ──────────────────────────────────────────────

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
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockGoogleUser = {
  ...mockUser,
  id: 'google-user-1',
  email: 'google@example.com',
  name: 'Google User',
  passwordHash: null,
  oauthProvider: 'google',
  oauthProviderId: 'google-id-123',
  emailVerified: true,
};

const mockPlan = {
  id: 'plan-1',
  slug: 'free',
  name: 'Free',
  creditsPerMonth: 0,
};

const mockResetToken = {
  id: 'reset-token-1',
  userId: 'user-1',
  tokenHash: 'hashed-token',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  used: false,
  createdAt: new Date(),
};

// ── Mock services ──────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  plan: {
    findFirst: jest.fn(),
  },
  subscription: {
    create: jest.fn(),
  },
  creditBalance: {
    create: jest.fn(),
  },
  creditTransaction: {
    create: jest.fn(),
  },
  affiliate: {
    findUnique: jest.fn(),
  },
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
  getOrThrow: jest.fn((key: string) => {
    const config: Record<string, string> = {
      JWT_ACCESS_SECRET: 'test-secret',
    };
    const value = config[key];
    if (!value) throw new Error(`Missing env var: ${key}`);
    return value;
  }),
};

const mockEmailService = {
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
};

// ── Test suite ─────────────────────────────────────────────

describe('AuthService — Password Reset & Google OAuth', () => {
  let service: AuthService;

  beforeEach(async () => {
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

    // Reset all mocks
    jest.clearAllMocks();

    // Default mock setup for generateTokens
    mockPrisma.refreshToken.create.mockResolvedValue({
      id: 'rt-1',
      tokenHash: 'hash',
    });
    mockJwtService.signAsync.mockResolvedValue('mock-access-token');
    mockConfigService.get.mockImplementation((key: string) => {
      const config: Record<string, string> = {
        JWT_ACCESS_SECRET: 'test-secret',
        NODE_ENV: 'development',
        GOOGLE_CLIENT_ID: 'test-client-id',
      };
      return config[key];
    });
    mockConfigService.getOrThrow.mockImplementation((key: string) => {
      const config: Record<string, string> = {
        JWT_ACCESS_SECRET: 'test-secret',
      };
      const value = config[key];
      if (!value) throw new Error(`Missing env var: ${key}`);
      return value;
    });
  });

  // ────────────────────────────────────────────────────────
  // forgotPassword
  // ────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('should return success message for valid email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.passwordResetToken.create.mockResolvedValue({
        id: 'prt-1',
      });

      const result = await service.forgotPassword('test@example.com');

      expect(result.message).toBe(
        'Se o email existir, instruções de reset serão enviadas',
      );
      // SECURITY FIX: resetToken is never returned in API response
      expect((result as any).resetToken).toBeUndefined();

      // Should look up user by lowercase email
      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'test@example.com', isActive: true },
      });

      // Should invalidate previous tokens
      expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: mockUser.id, used: false },
        data: { used: true },
      });

      // Should create new reset token
      expect(mockPrisma.passwordResetToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: mockUser.id,
          tokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      });
    });

    it('should return same success message for non-existent email (no email enumeration)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword('nonexistent@example.com');

      expect(result.message).toBe(
        'Se o email existir, instruções de reset serão enviadas',
      );

      // Should NOT create any reset token
      expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it('should return same success message for OAuth-only user (no passwordHash)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockGoogleUser);

      const result = await service.forgotPassword('google@example.com');

      expect(result.message).toBe(
        'Se o email existir, instruções de reset serão enviadas',
      );

      // Should NOT create any reset token
      expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it('should invalidate previous reset tokens before creating new one', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.passwordResetToken.create.mockResolvedValue({
        id: 'prt-1',
      });

      await service.forgotPassword('test@example.com');

      // updateMany should be called BEFORE create
      const updateManyOrder =
        mockPrisma.passwordResetToken.updateMany.mock.invocationCallOrder[0];
      const createOrder =
        mockPrisma.passwordResetToken.create.mock.invocationCallOrder[0];

      expect(updateManyOrder).toBeLessThan(createOrder);

      expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
        where: { userId: mockUser.id, used: false },
        data: { used: true },
      });
    });

    it('should never return resetToken in response (security fix)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.passwordResetToken.create.mockResolvedValue({
        id: 'prt-1',
      });

      const result = await service.forgotPassword('test@example.com');

      // SECURITY FIX: resetToken must never be in the API response
      expect(result).toEqual({
        message: 'Se o email existir, instruções de reset serão enviadas',
      });
      expect((result as any).resetToken).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────
  // resetPassword
  // ────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    const validToken = 'valid-reset-token-hex';
    const newPassword = 'NewPassword123!';

    it('should reset password successfully with valid token', async () => {
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(mockResetToken);
      (bcrypt.hash as jest.Mock).mockResolvedValue('new-hashed-password');
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser,
        passwordHash: 'new-hashed-password',
      });
      mockPrisma.passwordResetToken.update.mockResolvedValue({
        ...mockResetToken,
        used: true,
      });
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.resetPassword(validToken, newPassword);

      expect(result).toEqual({ message: 'Senha alterada com sucesso' });
    });

    it('should throw BadRequestException if token is invalid', async () => {
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword('invalid-token', newPassword),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.resetPassword('invalid-token', newPassword),
      ).rejects.toThrow('Token inválido ou expirado');
    });

    it('should throw BadRequestException if token is expired', async () => {
      // findFirst returns null when expiresAt filter doesn't match (expired)
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword('expired-token', newPassword),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if token is already used', async () => {
      // findFirst returns null when used: false filter doesn't match (already used)
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPassword('used-token', newPassword),
      ).rejects.toThrow(BadRequestException);
    });

    it('should hash new password with bcrypt', async () => {
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(mockResetToken);
      (bcrypt.hash as jest.Mock).mockResolvedValue('bcrypt-hashed');
      mockPrisma.user.update.mockResolvedValue(mockUser);
      mockPrisma.passwordResetToken.update.mockResolvedValue(mockResetToken);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await service.resetPassword(validToken, newPassword);

      expect(bcrypt.hash).toHaveBeenCalledWith(newPassword, 10);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: mockResetToken.userId },
        data: { passwordHash: 'bcrypt-hashed' },
      });
    });

    it('should revoke all refresh tokens after password reset (security)', async () => {
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(mockResetToken);
      (bcrypt.hash as jest.Mock).mockResolvedValue('new-hashed-password');
      mockPrisma.user.update.mockResolvedValue(mockUser);
      mockPrisma.passwordResetToken.update.mockResolvedValue(mockResetToken);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 3 });

      await service.resetPassword(validToken, newPassword);

      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: mockResetToken.userId },
        data: { revoked: true },
      });
    });

    it('should use transaction for atomicity', async () => {
      mockPrisma.passwordResetToken.findFirst.mockResolvedValue(mockResetToken);
      (bcrypt.hash as jest.Mock).mockResolvedValue('new-hashed-password');
      mockPrisma.user.update.mockResolvedValue(mockUser);
      mockPrisma.passwordResetToken.update.mockResolvedValue(mockResetToken);
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await service.resetPassword(validToken, newPassword);

      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });
  });

  // ────────────────────────────────────────────────────────
  // googleAuth
  // ────────────────────────────────────────────────────────

  describe('googleAuth', () => {
    const googleUserInput = {
      googleId: 'google-id-123',
      email: 'google@example.com',
      name: 'Google User',
      avatarUrl: 'https://example.com/avatar.jpg',
      provider: 'google',
    };

    it('should create new user with Google OAuth (new user flow)', async () => {
      // User doesn't exist
      mockPrisma.user.findFirst.mockResolvedValue(null);

      // Transaction creates new user
      const newUser = {
        ...mockGoogleUser,
        avatarUrl: 'https://example.com/avatar.jpg',
      };
      mockPrisma.user.create.mockResolvedValue(newUser);
      mockPrisma.plan.findFirst.mockResolvedValue(mockPlan);
      mockPrisma.subscription.create.mockResolvedValue({ id: 'sub-1' });
      mockPrisma.creditBalance.create.mockResolvedValue({ id: 'cb-1' });
      mockPrisma.creditTransaction.create.mockResolvedValue({ id: 'ct-1' });
      mockPrisma.$transaction.mockImplementation((fn) => fn(mockPrisma));

      const result = await service.googleAuth(googleUserInput);

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({
          id: newUser.id,
          email: newUser.email,
          name: newUser.name,
        }),
      });

      // Should have created user via transaction
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'google@example.com',
          name: 'Google User',
          oauthProvider: 'google',
          oauthProviderId: 'google-id-123',
          emailVerified: true,
          role: 'USER',
        }),
      });
    });

    it('should login existing user with Google OAuth', async () => {
      // User already exists with Google OAuth
      mockPrisma.user.findFirst.mockResolvedValue(mockGoogleUser);

      const result = await service.googleAuth(googleUserInput);

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({
          id: mockGoogleUser.id,
          email: mockGoogleUser.email,
        }),
      });

      // Should NOT create a new user
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      // Should NOT update the user (already has oauthProvider)
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it('should link Google OAuth to existing email user (updates oauthProvider)', async () => {
      // User exists with email but no OAuth
      const emailOnlyUser = {
        ...mockUser,
        oauthProvider: null,
        oauthProviderId: null,
      };
      mockPrisma.user.findFirst.mockResolvedValue(emailOnlyUser);
      mockPrisma.user.update.mockResolvedValue({
        ...emailOnlyUser,
        oauthProvider: 'google',
        oauthProviderId: 'google-id-123',
        emailVerified: true,
      });

      const result = await service.googleAuth(googleUserInput);

      expect(result).toBeDefined();
      expect(result.accessToken).toBe('mock-access-token');

      // Should update user with OAuth info
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: emailOnlyUser.id },
        data: {
          oauthProvider: 'google',
          oauthProviderId: 'google-id-123',
          emailVerified: true,
          avatarUrl: 'https://example.com/avatar.jpg',
        },
      });
    });

    it('should create subscription and creditBalance for new Google user', async () => {
      mockPrisma.user.findFirst.mockResolvedValue(null);
      const newUser = { ...mockGoogleUser };
      mockPrisma.user.create.mockResolvedValue(newUser);
      mockPrisma.plan.findFirst.mockResolvedValue(mockPlan);
      mockPrisma.subscription.create.mockResolvedValue({ id: 'sub-1' });
      mockPrisma.creditBalance.create.mockResolvedValue({ id: 'cb-1' });
      mockPrisma.$transaction.mockImplementation((fn) => fn(mockPrisma));

      await service.googleAuth(googleUserInput);

      // Should look up Free plan
      expect(mockPrisma.plan.findFirst).toHaveBeenCalledWith({
        where: { slug: 'free' },
      });

      // Should create subscription
      expect(mockPrisma.subscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: newUser.id,
          planId: mockPlan.id,
          status: 'ACTIVE',
        }),
      });

      // Should create credit balance (v5: Free starts with 0 credits)
      expect(mockPrisma.creditBalance.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: newUser.id,
          planCreditsRemaining: 0,
          bonusCreditsRemaining: 0,
          planCreditsUsed: 0,
        }),
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // googleAuthWithToken
  // ────────────────────────────────────────────────────────

  describe('googleAuthWithToken', () => {
    const mockPayload = {
      sub: 'google-id-456',
      email: 'token-user@example.com',
      name: 'Token User',
      picture: 'https://example.com/pic.jpg',
    };

    it('should verify Google ID token and authenticate', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => mockPayload,
      });

      // Existing user with Google OAuth
      const existingUser = {
        ...mockGoogleUser,
        id: 'user-token-1',
        email: 'token-user@example.com',
        name: 'Token User',
        oauthProvider: 'google',
        oauthProviderId: 'google-id-456',
      };
      mockPrisma.user.findFirst.mockResolvedValue(existingUser);

      const result = await service.googleAuthWithToken('valid-google-token');

      expect(result).toEqual({
        accessToken: 'mock-access-token',
        refreshToken: expect.any(String),
        user: expect.objectContaining({
          id: existingUser.id,
          email: existingUser.email,
        }),
      });

      expect(mockVerifyIdToken).toHaveBeenCalledWith({
        idToken: 'valid-google-token',
        audience: 'test-client-id',
      });
    });

    it('should throw UnauthorizedException for invalid token', async () => {
      mockVerifyIdToken.mockRejectedValue(new Error('Invalid token'));

      await expect(
        service.googleAuthWithToken('invalid-token'),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.googleAuthWithToken('invalid-token'),
      ).rejects.toThrow('Token Google inválido');
    });

    it('should throw UnauthorizedException if payload has no email', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google-id-789',
          email: null,
          name: 'No Email',
        }),
      });

      await expect(
        service.googleAuthWithToken('token-no-email'),
      ).rejects.toThrow(UnauthorizedException);

      await expect(
        service.googleAuthWithToken('token-no-email'),
      ).rejects.toThrow('Token Google inválido');
    });
  });
});
