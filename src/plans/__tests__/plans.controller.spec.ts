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
    // Modelo de assinatura descontinuado: a listagem pública de planos sempre
    // retorna vazio; a monetização passou a ser via pacotes de crédito avulsos.
    it('should always return an empty array (plans hidden)', async () => {
      const result = await controller.findAll();

      expect(result).toEqual([]);
      expect(mockPlansService.findAllPlans).not.toHaveBeenCalled();
    });
  });
});
