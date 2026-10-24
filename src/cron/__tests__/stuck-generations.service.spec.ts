import { Test, TestingModule } from '@nestjs/testing';
import {
  STUCK_THRESHOLD_MINUTES,
  StuckGenerationsService,
} from '../stuck-generations.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLoggerService } from '../cron-logger.service';

// ── Fixtures ─────────────────────────────────────────────────────────

const makeGeneration = (overrides: Record<string, any> = {}) => ({
  id: 'gen-1',
  userId: 'user-1',
  status: 'PROCESSING',
  type: 'TEXT_TO_IMAGE',
  creditsConsumed: 150,
  usedFreeGeneration: false,
  usedFreeGenerationType: null,
  createdAt: new Date('2026-03-01T10:00:00Z'),
  processingStartedAt: new Date('2026-03-01T10:01:00Z'),
  ...overrides,
});

const mockCreditBalance = {
  userId: 'user-1',
  planCreditsRemaining: 5000,
  bonusCreditsRemaining: 2000,
  planCreditsUsed: 5000,
};

// ── Mocks ────────────────────────────────────────────────────────────

const createMockPrisma = () => {
  const tx = {
    generation: {
      update: jest.fn().mockResolvedValue({}),
    },
    userFreeGeneration: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    creditTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'ct-1' }),
    },
    creditBalance: {
      findUnique: jest.fn().mockResolvedValue(mockCreditBalance),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  return {
    generation: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn((fn) => fn(tx)),
    _tx: tx,
  };
};

const createMockCronLogger = () => ({
  wrap: jest.fn((_meta: unknown, fn: () => Promise<unknown>) => fn()),
});

let mockPrisma: ReturnType<typeof createMockPrisma>;

describe('StuckGenerationsService', () => {
  let service: StuckGenerationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StuckGenerationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CronLoggerService, useValue: createMockCronLogger() },
      ],
    }).compile();

    service = module.get<StuckGenerationsService>(StuckGenerationsService);
  });

  // ══════════════════════════════════════════════════════════════════
  // JANELA (TKT-107): processingStartedAt por família, não createdAt
  // ══════════════════════════════════════════════════════════════════

  describe('buildStuckConditions', () => {
    it('conta a janela a partir de processingStartedAt, por família, e trata quem nunca começou', () => {
      const now = new Date('2026-10-14T12:00:00Z');
      const conditions = StuckGenerationsService.buildStuckConditions(now);

      const minutesAgo = (date: Date) => (now.getTime() - date.getTime()) / 60_000;
      const image = conditions.find((c: any) => c.type?.in?.includes('TEXT_TO_IMAGE')) as any;
      const video = conditions.find((c: any) => c.type?.in?.includes('IMAGE_TO_VIDEO')) as any;
      const queued = conditions.find((c: any) => c.processingStartedAt === null) as any;

      expect(minutesAgo(image.processingStartedAt.lt)).toBe(STUCK_THRESHOLD_MINUTES.image);
      expect(minutesAgo(video.processingStartedAt.lt)).toBe(STUCK_THRESHOLD_MINUTES.video);
      expect(video.type.in).toEqual(expect.arrayContaining(['MOTION_CONTROL', 'REFERENCE_VIDEO']));
      expect(minutesAgo(queued.createdAt.lt)).toBe(STUCK_THRESHOLD_MINUTES.queued);
      expect(STUCK_THRESHOLD_MINUTES.video).toBeGreaterThan(STUCK_THRESHOLD_MINUTES.image);
    });

    it('consulta só PROCESSING com as condições por família', async () => {
      await service.handleStuckGenerations();

      expect(mockPrisma.generation.findMany).toHaveBeenCalledWith({
        where: {
          status: 'PROCESSING',
          OR: expect.arrayContaining([
            expect.objectContaining({ processingStartedAt: null }),
          ]),
        },
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // GERAÇÕES TRAVADAS
  // ══════════════════════════════════════════════════════════════════

  describe('handleStuckGenerations', () => {
    it('deve marcar geração travada como FAILED com código GENERATION_TIMEOUT', async () => {
      const gen = makeGeneration();
      mockPrisma.generation.findMany.mockResolvedValue([gen]);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.generation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'gen-1' },
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'GENERATION_TIMEOUT',
          }),
        }),
      );
    });

    it('deve estornar créditos do plano a partir de transações de débito do plano', async () => {
      const gen = makeGeneration({ creditsConsumed: 150 });
      mockPrisma.generation.findMany.mockResolvedValue([gen]);

      mockPrisma._tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'ct-debit-1', source: 'plan', amount: -100, type: 'GENERATION_DEBIT' },
        { id: 'ct-debit-2', source: 'plan', amount: -50, type: 'GENERATION_DEBIT' },
      ]);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.creditBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          data: expect.objectContaining({
            planCreditsRemaining: 5000 + 150,
            planCreditsUsed: 5000 - 150,
          }),
        }),
      );

      expect(mockPrisma._tx.creditTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            type: 'GENERATION_REFUND',
            amount: 150,
            source: 'plan',
            generationId: 'gen-1',
          }),
        }),
      );
    });

    it('deve estornar créditos bônus a partir de transações de débito bônus', async () => {
      const gen = makeGeneration({ creditsConsumed: 100 });
      mockPrisma.generation.findMany.mockResolvedValue([gen]);

      mockPrisma._tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'ct-debit-1', source: 'plan', amount: -60, type: 'GENERATION_DEBIT' },
        { id: 'ct-debit-2', source: 'bonus', amount: -40, type: 'GENERATION_DEBIT' },
      ]);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.creditBalance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            planCreditsRemaining: 5000 + 60,
            bonusCreditsRemaining: 2000 + 40,
            planCreditsUsed: 5000 - 60,
          }),
        }),
      );

      expect(mockPrisma._tx.creditTransaction.create).toHaveBeenCalledTimes(2);
    });

    it('NÃO estorna nada quando não há registro de débito (TKT-096: nada de bônus do nada)', async () => {
      const gen = makeGeneration({ creditsConsumed: 200 });
      mockPrisma.generation.findMany.mockResolvedValue([gen]);
      mockPrisma._tx.creditTransaction.findMany.mockResolvedValue([]);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.generation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
      expect(mockPrisma._tx.creditBalance.update).not.toHaveBeenCalled();
      expect(mockPrisma._tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('não estorna de novo o que já foi estornado (TKT-111)', async () => {
      const gen = makeGeneration({ creditsConsumed: 150 });
      mockPrisma.generation.findMany.mockResolvedValue([gen]);
      mockPrisma._tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'ct-debit-1', source: 'plan', amount: -150, type: 'GENERATION_DEBIT' },
        { id: 'ct-refund-1', source: 'plan', amount: 150, type: 'GENERATION_REFUND' },
      ]);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.creditBalance.update).not.toHaveBeenCalled();
      expect(mockPrisma._tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('devolve a cota de geração grátis em vez de créditos', async () => {
      const gen = makeGeneration({
        creditsConsumed: 0,
        usedFreeGeneration: true,
        usedFreeGenerationType: 'UPSCALE',
      });
      mockPrisma.generation.findMany.mockResolvedValue([gen]);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.userFreeGeneration.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_type: { userId: 'user-1', type: 'UPSCALE' } },
        }),
      );
      expect(mockPrisma._tx.creditBalance.update).not.toHaveBeenCalled();
    });

    it('deve pular estorno quando creditsConsumed é 0', async () => {
      const gen = makeGeneration({ creditsConsumed: 0 });
      mockPrisma.generation.findMany.mockResolvedValue([gen]);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.generation.update).toHaveBeenCalled();
      expect(mockPrisma._tx.creditBalance.update).not.toHaveBeenCalled();
      expect(mockPrisma._tx.creditTransaction.create).not.toHaveBeenCalled();
    });

    it('não deve fazer nada quando não há gerações travadas', async () => {
      mockPrisma.generation.findMany.mockResolvedValue([]);

      await service.handleStuckGenerations();

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('deve continuar processando se uma geração falhar', async () => {
      const gen1 = makeGeneration({ id: 'gen-1' });
      const gen2 = makeGeneration({ id: 'gen-2' });
      mockPrisma.generation.findMany.mockResolvedValue([gen1, gen2]);
      mockPrisma.$transaction
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementationOnce((fn: any) => fn(mockPrisma._tx));

      const result = await service.handleStuckGenerations();

      expect(result).toEqual({ stuckFound: 2, recovered: 1, failed: 1 });
    });

    it('deve lidar graciosamente quando creditBalance não existe', async () => {
      const gen = makeGeneration({ creditsConsumed: 150 });
      mockPrisma.generation.findMany.mockResolvedValue([gen]);
      mockPrisma._tx.creditTransaction.findMany.mockResolvedValue([
        { id: 'ct-debit-1', source: 'plan', amount: -150, type: 'GENERATION_DEBIT' },
      ]);
      mockPrisma._tx.creditBalance.findUnique.mockResolvedValue(null);

      await service.handleStuckGenerations();

      expect(mockPrisma._tx.creditBalance.update).not.toHaveBeenCalled();
      // A transação de estorno ainda é registrada (auditoria), como antes.
      expect(mockPrisma._tx.creditTransaction.create).toHaveBeenCalledTimes(1);
    });
  });
});
