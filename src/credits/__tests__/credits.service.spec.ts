import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { CreditsService } from '../credits.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PlansService } from '../../plans/plans.service';

// ── Fixtures ─────────────────────────────────────────────────────────

const mockCreditBalance = {
  userId: 'user-1',
  planCreditsRemaining: 8000,
  bonusCreditsRemaining: 2000,
  planCreditsUsed: 2000,
  periodStart: new Date('2026-03-01'),
  periodEnd: new Date('2026-04-01'),
};

// ── Mocks ────────────────────────────────────────────────────────────

const createMockTx = () => ({
  creditBalance: {
    findUnique: jest.fn().mockResolvedValue({ ...mockCreditBalance }),
    update: jest.fn().mockResolvedValue({ ...mockCreditBalance }),
  },
  creditTransaction: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'ct-1' }),
  },
});

const createMockPrisma = () => {
  const tx = createMockTx();

  return {
    creditBalance: {
      findUnique: jest.fn().mockResolvedValue({ ...mockCreditBalance }),
    },
    creditTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((fn) => fn(tx)),
    __tx: tx,
  };
};

const createMockPlansService = () => ({
  findAllPackages: jest.fn().mockResolvedValue([]),
  calculateGenerationCost: jest.fn().mockResolvedValue(100),
});

let mockPrisma: ReturnType<typeof createMockPrisma>;
let mockPlansService: ReturnType<typeof createMockPlansService>;

// ── Test Suite ───────────────────────────────────────────────────────

describe('CreditsService', () => {
  let service: CreditsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrisma();
    mockPlansService = createMockPlansService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PlansService, useValue: mockPlansService },
      ],
    }).compile();

    service = module.get<CreditsService>(CreditsService);
  });

  // ══════════════════════════════════════════════════════════════════
  // getBalance
  // ══════════════════════════════════════════════════════════════════

  describe('getBalance', () => {
    it('deve retornar saldo correto para usuário existente', async () => {
      const result = await service.getBalance('user-1');

      expect(result).toEqual({
        planCreditsRemaining: 8000,
        bonusCreditsRemaining: 2000,
        totalCreditsAvailable: 10000,
        planCreditsUsed: 2000,
        periodStart: mockCreditBalance.periodStart,
        periodEnd: mockCreditBalance.periodEnd,
      });
      expect(mockPrisma.creditBalance.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });

    it('deve retornar zeros quando usuário não tem saldo', async () => {
      mockPrisma.creditBalance.findUnique.mockResolvedValue(null);

      const result = await service.getBalance('user-sem-saldo');

      expect(result).toEqual({
        planCreditsRemaining: 0,
        bonusCreditsRemaining: 0,
        totalCreditsAvailable: 0,
        planCreditsUsed: 0,
        periodStart: null,
        periodEnd: null,
      });
    });

    it('totalCreditsAvailable deve ser planCreditsRemaining + bonusCreditsRemaining', async () => {
      mockPrisma.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 3500,
        bonusCreditsRemaining: 1500,
      });

      const result = await service.getBalance('user-1');

      expect(result.totalCreditsAvailable).toBe(5000);
      expect(result.totalCreditsAvailable).toBe(
        result.planCreditsRemaining + result.bonusCreditsRemaining,
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // getTransactions
  // ══════════════════════════════════════════════════════════════════

  describe('getTransactions', () => {
    it('deve retornar transações paginadas', async () => {
      const mockTx = {
        id: 'tx-1',
        type: 'GENERATION_DEBIT',
        amount: -100,
        source: 'plan',
        description: 'Débito',
        generationId: 'gen-1',
        paymentId: null,
        createdAt: new Date('2026-03-15'),
      };
      mockPrisma.creditTransaction.findMany.mockResolvedValue([mockTx]);
      mockPrisma.creditTransaction.count.mockResolvedValue(1);

      const pagination = { page: 1, limit: 20, skip: 0 } as any;
      const result = await service.getTransactions('user-1', pagination);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('tx-1');
      expect(result.meta.total).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // getPackages
  // ══════════════════════════════════════════════════════════════════

  describe('getPackages', () => {
    it('deve delegar para plansService.findAllPackages', async () => {
      const packages = [{ id: 'pkg-1', name: 'Pacote 500', credits: 5000 }];
      mockPlansService.findAllPackages.mockResolvedValue(packages);

      const result = await service.getPackages();

      expect(result).toEqual(packages);
      expect(mockPlansService.findAllPackages).toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // estimateCost
  // ══════════════════════════════════════════════════════════════════

  describe('estimateCost', () => {
    it('deve retornar custo correto e hasSufficientBalance=true quando há saldo', async () => {
      mockPlansService.calculateGenerationCost.mockResolvedValue(500);

      const result = await service.estimateCost(
        'user-1',
        'TEXT_TO_IMAGE' as any,
        '_1K' as any,
      );

      expect(result).toEqual({
        creditsRequired: 500,
        hasSufficientBalance: true,
      });
      expect(mockPlansService.calculateGenerationCost).toHaveBeenCalledWith(
        'TEXT_TO_IMAGE',
        '_1K',
        undefined,
        false,
        1,
        undefined,
      );
    });

    it('deve retornar hasSufficientBalance=false quando saldo insuficiente', async () => {
      mockPlansService.calculateGenerationCost.mockResolvedValue(20000);

      const result = await service.estimateCost(
        'user-1',
        'TEXT_TO_VIDEO' as any,
        '_1080P' as any,
        10,
        true,
      );

      expect(result).toEqual({
        creditsRequired: 20000,
        hasSufficientBalance: false,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // debit
  // ══════════════════════════════════════════════════════════════════

  describe('debit', () => {
    it('deve debitar totalmente dos créditos do plano quando suficientes', async () => {
      const tx = mockPrisma.__tx;
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 5000,
        bonusCreditsRemaining: 2000,
        planCreditsUsed: 1000,
      });

      await service.debit('user-1', 1000, 'GENERATION_DEBIT' as any, 'gen-1');

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 4000,
          bonusCreditsRemaining: 2000,
          planCreditsUsed: 2000,
        },
      });

      // Apenas uma transação de crédito (plan)
      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-1',
          type: 'GENERATION_DEBIT',
          amount: -1000,
          source: 'plan',
          generationId: 'gen-1',
        }),
      });
    });

    it('deve debitar do plano primeiro e transbordar para bônus', async () => {
      const tx = mockPrisma.__tx;
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 300,
        bonusCreditsRemaining: 2000,
        planCreditsUsed: 700,
      });

      await service.debit('user-1', 500, 'GENERATION_DEBIT' as any, 'gen-2');

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 0,
          bonusCreditsRemaining: 1800,
          planCreditsUsed: 1000,
        },
      });

      // Duas transações: plan (300) + bonus (200)
      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(2);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: -300,
          source: 'plan',
        }),
      });
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: -200,
          source: 'bonus',
        }),
      });
    });

    it('deve debitar totalmente do bônus quando créditos do plano são 0', async () => {
      const tx = mockPrisma.__tx;
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 0,
        bonusCreditsRemaining: 5000,
        planCreditsUsed: 10000,
      });

      await service.debit('user-1', 1000, 'GENERATION_DEBIT' as any, 'gen-3');

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 0,
          bonusCreditsRemaining: 4000,
          planCreditsUsed: 10000,
        },
      });

      // Apenas transação de bônus
      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: -1000,
          source: 'bonus',
        }),
      });
    });

    it('deve lançar INSUFFICIENT_CREDITS quando total < amount', async () => {
      const tx = mockPrisma.__tx;
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 100,
        bonusCreditsRemaining: 50,
      });

      await expect(
        service.debit('user-1', 1000, 'GENERATION_DEBIT' as any),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.debit('user-1', 1000, 'GENERATION_DEBIT' as any),
      ).rejects.toThrow(/Créditos insuficientes/);
    });

    it('deve lançar NotFoundException quando saldo não existe', async () => {
      const tx = mockPrisma.__tx;
      tx.creditBalance.findUnique.mockResolvedValue(null);

      await expect(
        service.debit('user-sem-saldo', 100, 'GENERATION_DEBIT' as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('deve criar registros separados de credit_transaction para débitos plan e bonus', async () => {
      const tx = mockPrisma.__tx;
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 600,
        bonusCreditsRemaining: 1000,
        planCreditsUsed: 400,
      });

      await service.debit(
        'user-1',
        800,
        'GENERATION_DEBIT' as any,
        'gen-4',
        'Geração de imagem',
      );

      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(2);

      const calls = tx.creditTransaction.create.mock.calls;
      const planCall = calls.find((c: any) => c[0].data.source === 'plan');
      const bonusCall = calls.find((c: any) => c[0].data.source === 'bonus');

      expect(planCall[0].data).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          type: 'GENERATION_DEBIT',
          amount: -600,
          source: 'plan',
          generationId: 'gen-4',
          description: 'Geração de imagem',
        }),
      );
      expect(bonusCall[0].data).toEqual(
        expect.objectContaining({
          userId: 'user-1',
          type: 'GENERATION_DEBIT',
          amount: -200,
          source: 'bonus',
          generationId: 'gen-4',
          description: 'Geração de imagem',
        }),
      );
    });

    it('deve incrementar planCreditsUsed corretamente', async () => {
      const tx = mockPrisma.__tx;
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 3000,
        bonusCreditsRemaining: 1000,
        planCreditsUsed: 7000,
      });

      await service.debit('user-1', 500, 'GENERATION_DEBIT' as any);

      expect(tx.creditBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planCreditsUsed: 7500,
          }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // refund
  // ══════════════════════════════════════════════════════════════════

  describe('refund', () => {
    it('deve estornar para as fontes originais (plan->plan, bonus->bonus)', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'dt-1', amount: -600, source: 'plan', type: 'GENERATION_DEBIT' },
        { id: 'dt-2', amount: -400, source: 'bonus', type: 'GENERATION_DEBIT' },
      ]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 7400,
        bonusCreditsRemaining: 1600,
        planCreditsUsed: 2600,
      });

      await service.refund('user-1', 1000, 'gen-1');

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 8000,
          bonusCreditsRemaining: 2000,
          planCreditsUsed: 2000,
        },
      });

      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(2);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'GENERATION_REFUND',
          amount: 600,
          source: 'plan',
          generationId: 'gen-1',
        }),
      });
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'GENERATION_REFUND',
          amount: 400,
          source: 'bonus',
          generationId: 'gen-1',
        }),
      });
    });

    it('deve estornar para bônus quando não há registros de débito', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 8000,
        bonusCreditsRemaining: 1000,
        planCreditsUsed: 2000,
      });

      await service.refund('user-1', 500, 'gen-orphan');

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 8000,
          bonusCreditsRemaining: 1500,
          planCreditsUsed: 2000,
        },
      });

      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'GENERATION_REFUND',
          amount: 500,
          source: 'bonus',
        }),
      });
    });

    it('deve estornar tudo para plano quando só há débitos de plano', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'dt-1', amount: -1000, source: 'plan', type: 'GENERATION_DEBIT' },
      ]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 7000,
        bonusCreditsRemaining: 2000,
        planCreditsUsed: 3000,
      });

      await service.refund('user-1', 1000, 'gen-plan-only');

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 8000,
          bonusCreditsRemaining: 2000,
          planCreditsUsed: 2000,
        },
      });

      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: 1000,
          source: 'plan',
        }),
      });
    });

    it('deve distribuir estorno corretamente com fontes mistas', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'dt-1', amount: -700, source: 'plan', type: 'GENERATION_DEBIT' },
        { id: 'dt-2', amount: -300, source: 'bonus', type: 'GENERATION_DEBIT' },
      ]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 7300,
        bonusCreditsRemaining: 1700,
        planCreditsUsed: 2700,
      });

      await service.refund('user-1', 1000, 'gen-mixed');

      // planRefund = 700, bonusRefund = 300 (baseado nos débitos originais)
      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 8000,
          bonusCreditsRemaining: 2000,
          planCreditsUsed: 2000,
        },
      });
    });

    it('deve lançar NotFoundException quando saldo não existe', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([]);
      tx.creditBalance.findUnique.mockResolvedValue(null);

      await expect(
        service.refund('user-sem-saldo', 500, 'gen-x'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // partialRefund
  // ══════════════════════════════════════════════════════════════════

  describe('partialRefund', () => {
    it('deve distribuir estorno parcial proporcionalmente', async () => {
      const tx = mockPrisma.__tx;
      // Débito original: 800 plan + 200 bonus = 1000 total
      tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'dt-1', amount: -800, source: 'plan', type: 'GENERATION_DEBIT' },
        { id: 'dt-2', amount: -200, source: 'bonus', type: 'GENERATION_DEBIT' },
      ]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 7200,
        bonusCreditsRemaining: 1800,
        planCreditsUsed: 2800,
      });

      // Estorno parcial de 500 (metade)
      await service.partialRefund('user-1', 500, 'gen-partial');

      // planRefund = Math.round(800/1000 * 500) = 400
      // bonusRefund = 500 - 400 = 100
      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 7600,
          bonusCreditsRemaining: 1900,
          planCreditsUsed: 2400,
        },
      });

      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(2);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'GENERATION_REFUND',
          amount: 400,
          source: 'plan',
        }),
      });
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'GENERATION_REFUND',
          amount: 100,
          source: 'bonus',
        }),
      });
    });

    it('estorno parcial nunca deve exceder o débito original por fonte', async () => {
      const tx = mockPrisma.__tx;
      // Débito original: 100 plan + 900 bonus = 1000 total
      tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'dt-1', amount: -100, source: 'plan', type: 'GENERATION_DEBIT' },
        { id: 'dt-2', amount: -900, source: 'bonus', type: 'GENERATION_DEBIT' },
      ]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 7900,
        bonusCreditsRemaining: 1100,
        planCreditsUsed: 2100,
      });

      // Estorno de 800
      // planRefund = Math.round(100/1000 * 800) = 80
      // bonusRefund = 800 - 80 = 720
      // 80 <= 100 (ok), 720 <= 900 (ok) — nenhum excede
      await service.partialRefund('user-1', 800, 'gen-cap');

      const updateCall = tx.creditBalance.update.mock.calls[0][0];
      const planRefund = updateCall.data.planCreditsRemaining - 7900;
      const bonusRefund = updateCall.data.bonusCreditsRemaining - 1100;

      expect(planRefund).toBeLessThanOrEqual(100);
      expect(bonusRefund).toBeLessThanOrEqual(900);
      expect(planRefund + bonusRefund).toBe(800);
    });

    it('deve ser no-op quando refundAmount é 0', async () => {
      await service.partialRefund('user-1', 0, 'gen-zero');

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('deve estornar para bônus quando não há registros de débito', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
        planCreditsRemaining: 8000,
        bonusCreditsRemaining: 2000,
        planCreditsUsed: 2000,
      });

      await service.partialRefund('user-1', 300, 'gen-no-debits');

      expect(tx.creditBalance.update).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        data: {
          planCreditsRemaining: 8000,
          bonusCreditsRemaining: 2300,
          planCreditsUsed: 2000,
        },
      });

      expect(tx.creditTransaction.create).toHaveBeenCalledTimes(1);
      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'GENERATION_REFUND',
          amount: 300,
          source: 'bonus',
        }),
      });
    });

    it('deve usar descrição customizada quando fornecida', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([]);
      tx.creditBalance.findUnique.mockResolvedValue({
        ...mockCreditBalance,
      });

      await service.partialRefund(
        'user-1',
        250,
        'gen-desc',
        'Estorno por erro de processamento',
      );

      expect(tx.creditTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          description: 'Estorno por erro de processamento',
        }),
      });
    });

    it('deve lançar NotFoundException quando saldo não existe', async () => {
      const tx = mockPrisma.__tx;
      tx.creditTransaction.findMany.mockResolvedValue([]);
      tx.creditBalance.findUnique.mockResolvedValue(null);

      await expect(
        service.partialRefund('user-sem-saldo', 100, 'gen-x'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
