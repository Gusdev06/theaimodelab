import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from '../users.controller';
import { UsersService } from '../users.service';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UserProfileResponseDto } from '../dto/user-profile-response.dto';

// ── Fixtures ─────────────────────────────────────────────────────────

const now = new Date('2026-01-01');

const mockProfile: UserProfileResponseDto = {
  id: 'user-1',
  email: 'test@example.com',
  name: 'Test User',
  avatarUrl: null,
  role: 'USER',
  emailVerified: false,
  hasCompletedOnboarding: false,
  createdAt: now,
  country: null,
  locale: 'pt-BR',
  currency: 'BRL',
  timezone: null,
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
  feedbackSubmitted: false,
  hasTaxIdOnFile: false,
  taxIdMasked: null,
};

const mockUsersService = {
  getProfile: jest.fn().mockResolvedValue(mockProfile),
  updateProfile: jest.fn().mockResolvedValue(mockProfile),
  deleteAccount: jest
    .fn()
    .mockResolvedValue({ message: 'Conta desativada com sucesso' }),
};

// ── Test Suite ───────────────────────────────────────────────────────

describe('UsersController', () => {
  let controller: UsersController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: mockUsersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getProfile', () => {
    it('should delegate to usersService.getProfile(userId)', async () => {
      const result = await controller.getProfile('user-1');

      expect(mockUsersService.getProfile).toHaveBeenCalledWith('user-1');
      expect(mockUsersService.getProfile).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockProfile);
    });
  });

  describe('updateProfile', () => {
    it('should delegate to usersService.updateProfile(userId, dto)', async () => {
      const dto: UpdateUserDto = { name: 'Updated Name' };

      const result = await controller.updateProfile('user-1', dto);

      expect(mockUsersService.updateProfile).toHaveBeenCalledWith(
        'user-1',
        dto,
      );
      expect(mockUsersService.updateProfile).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockProfile);
    });
  });

  describe('deleteAccount', () => {
    it('should delegate to usersService.deleteAccount(userId)', async () => {
      const result = await controller.deleteAccount('user-1');

      expect(mockUsersService.deleteAccount).toHaveBeenCalledWith('user-1');
      expect(mockUsersService.deleteAccount).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ message: 'Conta desativada com sucesso' });
    });
  });
});
