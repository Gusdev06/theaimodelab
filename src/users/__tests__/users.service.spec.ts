import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from '../users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CURRENT_TERMS_VERSION } from '../terms.constants';

// ── Fixtures ─────────────────────────────────────────────────────────

const now = new Date('2026-01-01');

const mockPlan = {
  slug: 'free',
  name: 'Free',
  priceCents: 0,
  maxConcurrentGenerations: 1,
  hasWatermark: true,
  hasApiAccess: false,
};

const mockSubscription = {
  status: 'ACTIVE',
  currentPeriodStart: now,
  currentPeriodEnd: now,
  cancelAtPeriodEnd: false,
  plan: mockPlan,
};

const mockCreditBalance = {
  planCreditsRemaining: 300,
  bonusCreditsRemaining: 0,
  planCreditsUsed: 0,
  periodStart: now,
  periodEnd: now,
};

const mockUser = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  avatarUrl: null,
  role: 'USER',
  emailVerified: false,
  isActive: true,
  createdAt: now,
  updatedAt: now,
  oauthProvider: null,
  oauthProviderId: null,
  passwordHash: 'hashed',
  subscriptions: [mockSubscription],
  creditBalance: mockCreditBalance,
};

// ── Mocks ────────────────────────────────────────────────────────────

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  refreshToken: {
    updateMany: jest.fn(),
  },
  $transaction: jest.fn((fn) => fn(mockPrisma)),
};

// ── Test Suite ───────────────────────────────────────────────────────

describe('UsersService', () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  // ────────────────────── getProfile ──────────────────────

  describe('getProfile', () => {
    it('should return full profile with plan, credits, and subscription', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);

      const result = await service.getProfile('user-1');

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1', isActive: true },
        include: {
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { plan: true },
          },
          creditBalance: true,
        },
      });

      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        avatarUrl: null,
        role: 'USER',
        emailVerified: false,
        createdAt: now,
        plan: {
          slug: 'free',
          name: 'Free',
          priceCents: 0,
          maxConcurrentGenerations: 1,
          hasWatermark: true,
          hasApiAccess: false,
        },
        credits: {
          planCreditsRemaining: 300,
          bonusCreditsRemaining: 0,
          planCreditsUsed: 0,
          periodStart: now,
          periodEnd: now,
        },
        subscription: {
          status: 'ACTIVE',
          currentPeriodStart: now,
          currentPeriodEnd: now,
          cancelAtPeriodEnd: false,
        },
      });
    });

    it('should return profile with null plan/credits/subscription when user has none', async () => {
      const userWithoutExtras = {
        ...mockUser,
        subscriptions: [],
        creditBalance: null,
      };
      mockPrisma.user.findUnique.mockResolvedValue(userWithoutExtras);

      const result = await service.getProfile('user-1');

      expect(result.plan).toBeNull();
      expect(result.credits).toBeNull();
      expect(result.subscription).toBeNull();
    });

    it('should throw NotFoundException if user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.getProfile('nonexistent')).rejects.toThrow(
        'Usuário não encontrado',
      );
    });

    it('should throw NotFoundException if user isActive=false', async () => {
      // findUnique with isActive: true in where clause returns null for inactive users
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile('inactive-user')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ────────────────────── updateProfile ──────────────────────

  describe('updateProfile', () => {
    it('should update name only', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser,
        name: 'New Name',
      });

      // getProfile is called after update, so mock findUnique for both calls
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(mockUser) // first call: existence check
        .mockResolvedValueOnce({ ...mockUser, name: 'New Name' }); // second call: getProfile

      const result = await service.updateProfile('user-1', {
        name: 'New Name',
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'New Name' },
      });
      expect(result.name).toBe('New Name');
    });

    it('should update avatarUrl only', async () => {
      const avatarUrl = 'https://example.com/avatar.jpg';
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce({ ...mockUser, avatarUrl });
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser,
        avatarUrl,
      });

      const result = await service.updateProfile('user-1', { avatarUrl });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { avatarUrl },
      });
      expect(result.avatarUrl).toBe(avatarUrl);
    });

    it('should update both name and avatarUrl', async () => {
      const dto = {
        name: 'Updated Name',
        avatarUrl: 'https://example.com/new-avatar.jpg',
      };
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce({ ...mockUser, ...dto });
      mockPrisma.user.update.mockResolvedValue({ ...mockUser, ...dto });

      const result = await service.updateProfile('user-1', dto);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'Updated Name', avatarUrl: dto.avatarUrl },
      });
      expect(result.name).toBe('Updated Name');
      expect(result.avatarUrl).toBe(dto.avatarUrl);
    });

    it('should throw NotFoundException if user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProfile('nonexistent', { name: 'New' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return full profile after update (calls getProfile)', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(mockUser) // existence check
        .mockResolvedValueOnce(mockUser); // getProfile call
      mockPrisma.user.update.mockResolvedValue(mockUser);

      const result = await service.updateProfile('user-1', {
        name: 'Test User',
      });

      // The result should be a full profile (same shape as getProfile)
      expect(result).toHaveProperty('plan');
      expect(result).toHaveProperty('credits');
      expect(result).toHaveProperty('subscription');

      // findUnique should be called twice: once for existence check, once for getProfile
      expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  // ────────────────────── deleteAccount ──────────────────────

  describe('deleteAccount', () => {
    it('should soft delete (set isActive=false) and revoke all refresh tokens', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser,
        isActive: false,
      });
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.deleteAccount('user-1');

      expect(result).toEqual({ message: 'Conta desativada com sucesso' });

      // Verifies soft delete
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { isActive: false },
      });

      // Verifies token revocation
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: { revoked: true },
      });
    });

    it('should throw NotFoundException if user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.deleteAccount('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.deleteAccount('nonexistent')).rejects.toThrow(
        'Usuário não encontrado',
      );
    });

    it('should use $transaction for atomicity', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue({
        ...mockUser,
        isActive: false,
      });
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await service.deleteAccount('user-1');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });
  });

  // ────────────────────── acceptTerms ──────────────────────

  describe('acceptTerms', () => {
    it('should stamp termsAcceptedAt + current version when never accepted', async () => {
      const accepted = { ...mockUser, termsAcceptedAt: now, termsVersion: CURRENT_TERMS_VERSION };
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ ...mockUser, termsAcceptedAt: null, termsVersion: null })
        .mockResolvedValueOnce(accepted); // getProfile
      mockPrisma.user.update.mockResolvedValue(accepted);

      const result = await service.acceptTerms('user-1');

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { termsAcceptedAt: expect.any(Date), termsVersion: CURRENT_TERMS_VERSION },
      });
      expect(result.termsVersion).toBe(CURRENT_TERMS_VERSION);
      expect(result.termsAcceptedAt).toEqual(now);
    });

    it('should re-stamp when the accepted version is stale', async () => {
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ ...mockUser, termsAcceptedAt: now, termsVersion: '2000-01-01' })
        .mockResolvedValueOnce({ ...mockUser, termsAcceptedAt: now, termsVersion: CURRENT_TERMS_VERSION });
      mockPrisma.user.update.mockResolvedValue(mockUser);

      await service.acceptTerms('user-1');

      expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent on the current version (keeps original date)', async () => {
      const accepted = { ...mockUser, termsAcceptedAt: now, termsVersion: CURRENT_TERMS_VERSION };
      mockPrisma.user.findUnique
        .mockResolvedValueOnce(accepted)
        .mockResolvedValueOnce(accepted);

      const result = await service.acceptTerms('user-1');

      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(result.termsAcceptedAt).toEqual(now);
    });

    it('should throw NotFoundException if user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.acceptTerms('nope')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });
});
