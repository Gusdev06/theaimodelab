import { Test, TestingModule } from '@nestjs/testing';
import { PlansController } from '../plans.controller';
import { PlansService } from '../plans.service';

const mockPlansService = {
  findAllPlans: jest.fn(),
};

describe('PlansController', () => {
  let controller: PlansController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PlansController],
      providers: [{ provide: PlansService, useValue: mockPlansService }],
    }).compile();

    controller = module.get<PlansController>(PlansController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    const mockPlans = [
      {
        id: 'plan-1',
        slug: 'free',
        name: 'Free',
        description: 'Free plan',
        priceCents: 0,
        creditsPerMonth: 300,
        maxConcurrentGenerations: 1,
        hasWatermark: true,
        galleryRetentionDays: 30,
        hasApiAccess: false,
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'plan-2',
        slug: 'pro',
        name: 'Pro',
        description: null,
        priceCents: 8990,
        creditsPerMonth: 35000,
        maxConcurrentGenerations: 5,
        hasWatermark: false,
        galleryRetentionDays: null,
        hasApiAccess: false,
        isActive: true,
        sortOrder: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    it('should return mapped plans array', async () => {
      mockPlansService.findAllPlans.mockResolvedValue(mockPlans);

      const result = await controller.findAll({ headers: {} } as any, 'BRL');

      expect(mockPlansService.findAllPlans).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'plan-1',
        slug: 'free',
        name: 'Free',
        description: 'Free plan',
        priceCents: 0,
        creditsPerMonth: 300,
        maxConcurrentGenerations: 1,
        hasWatermark: true,
        galleryRetentionDays: 30,
        hasApiAccess: false,
      });
    });

    it('should return empty array when no plans exist', async () => {
      mockPlansService.findAllPlans.mockResolvedValue([]);

      const result = await controller.findAll({ headers: {} } as any, 'BRL');

      expect(mockPlansService.findAllPlans).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it('should correctly map all fields and exclude non-DTO fields', async () => {
      mockPlansService.findAllPlans.mockResolvedValue(mockPlans);

      const result = await controller.findAll({ headers: {} } as any, 'BRL');

      const expectedKeys = [
        'id',
        'slug',
        'name',
        'description',
        'priceCents',
        'creditsPerMonth',
        'maxConcurrentGenerations',
        'hasWatermark',
        'galleryRetentionDays',
        'hasApiAccess',
      ];

      for (const plan of result) {
        expect(Object.keys(plan).sort()).toEqual(expectedKeys.sort());
      }

      // Verify second plan with null values maps correctly
      expect(result[1]).toEqual({
        id: 'plan-2',
        slug: 'pro',
        name: 'Pro',
        description: null,
        priceCents: 8990,
        creditsPerMonth: 35000,
        maxConcurrentGenerations: 5,
        hasWatermark: false,
        galleryRetentionDays: null,
        hasApiAccess: false,
      });
    });
  });
});
