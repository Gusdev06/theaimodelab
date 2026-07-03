import { Test, TestingModule } from '@nestjs/testing';
import { SubscriptionRenewalService } from '../subscription-renewal.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Fixtures ─────────────────────────────────────────────────────────

const mockPlanStarter = {
  id: 'plan-starter',
  slug: 'starter',
  name: 'Starter',
  priceCents: 2990,
  creditsPerMonth: 1000,
};

const mockPlanPro = {
  id: 'plan-pro',
  slug: 'pro',
  name: 'Pro',
  priceCents: 8990,
  creditsPerMonth: 3500,
};

const makeSubscription = (overrides: Record<string, any> = {}) => ({
  id: 'sub-1',
  userId: 'user-1',
  planId: 'plan-starter',
  status: 'ACTIVE',
  currentPeriodStart: new Date('2026-03-01'),
  currentPeriodEnd: new Date('2026-03-15'),
  cancelAtPeriodEnd: false,
  paymentRetryCount: 0,
  plan: mockPlanStarter,
  ...overrides,
});

// ── Mocks ────────────────────────────────────────────────────────────

const createMockPrisma = () => {
  const tx = {
    subscription: {
      update: jest.fn().mockResolvedValue({}),
    },
    creditBalance: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    creditTransaction: {
      create: jest.fn().mockResolvedValue({ id: 'ct-1' }),
    },
  };

  return {
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((fn) => fn(tx)),
    _tx: tx,
  };
};

let mockPrisma: ReturnType<typeof createMockPrisma>;

describe('SubscriptionRenewalService', () => {
  let service: SubscriptionRenewalService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionRenewalService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<SubscriptionRenewalService>(SubscriptionRenewalService);
  });

  // ══════════════════════════════════════════════════════════════════
  // RENOVAÇÃO DE ASSINATURAS EXPIRADAS
  // ══════════════════════════════════════════════════════════════════

  describe('handleSubscriptionRenewal', () => {
    it('deve renovar assinaturas expiradas — atualiza período, reseta créditos e cria transação', async () => {
      const sub = makeSubscription();
      // Primeiro findMany: assinaturas para renovar; segundo: para cancelar
      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);

      await service.handleSubscriptionRenewal();

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

      // Verifica atualização do período
      expect(mockPrisma._tx.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub-1' },
          data: expect.objectContaining({
            currentPeriodStart: sub.currentPeriodEnd,
          }),
        }),
      );

      // Verifica reset de créditos
      expect(mockPrisma._tx.creditBalance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'user-1' },
          update: expect.objectContaining({
            planCreditsRemaining: 1000,
            planCreditsUsed: 0,
          }),
        }),
      );

      // Verifica criação da transação de crédito
      expect(mockPrisma._tx.creditTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            type: 'SUBSCRIPTION_RENEWAL',
            amount: 1000,
            source: 'plan',
          }),
        }),
      );
    });

    it('deve cancelar assinaturas marcadas para cancelamento no fim do período', async () => {
      const cancelingSub = makeSubscription({
        id: 'sub-cancel',
        cancelAtPeriodEnd: true,
      });

      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([])           // nenhuma para renovar
        .mockResolvedValueOnce([cancelingSub]); // uma para cancelar

      await service.handleSubscriptionRenewal();

      expect(mockPrisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-cancel' },
        data: { status: 'CANCELED' },
      });
    });

    it('não deve fazer nada quando não há assinaturas expiradas', async () => {
      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.handleSubscriptionRenewal();

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    });

    it('deve continuar processando se uma assinatura falhar', async () => {
      const sub1 = makeSubscription({ id: 'sub-1' });
      const sub2 = makeSubscription({ id: 'sub-2', userId: 'user-2' });

      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([sub1, sub2])
        .mockResolvedValueOnce([]);

      // Primeira chamada de $transaction falha, segunda sucede
      mockPrisma.$transaction
        .mockRejectedValueOnce(new Error('DB error'))
        .mockImplementationOnce((fn) => fn(mockPrisma._tx));

      await service.handleSubscriptionRenewal();

      // Deve ter tentado processar ambas
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('deve iniciar o novo período exatamente onde o antigo terminou (sem gaps)', async () => {
      const periodEnd = new Date('2026-04-01T00:00:00.000Z');
      const sub = makeSubscription({ currentPeriodEnd: periodEnd });

      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);

      await service.handleSubscriptionRenewal();

      const updateCall = mockPrisma._tx.subscription.update.mock.calls[0][0];
      expect(updateCall.data.currentPeriodStart).toEqual(periodEnd);

      const expectedNewEnd = new Date(periodEnd);
      expectedNewEnd.setMonth(expectedNewEnd.getMonth() + 1);
      expect(updateCall.data.currentPeriodEnd).toEqual(expectedNewEnd);
    });

    it('NÃO deve renovar subs com paymentProvider definido (Stripe é tratado pelo webhook)', async () => {
      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.handleSubscriptionRenewal();

      // Confirma o filtro paymentProvider: null em ambas as queries
      expect(mockPrisma.subscription.findMany.mock.calls[0][0].where).toEqual(
        expect.objectContaining({ paymentProvider: null }),
      );
      expect(mockPrisma.subscription.findMany.mock.calls[1][0].where).toEqual(
        expect.objectContaining({ paymentProvider: null }),
      );
    });

    it('deve resetar créditos para o valor de creditsPerMonth do plano', async () => {
      const sub = makeSubscription({
        plan: mockPlanPro,
        planId: 'plan-pro',
      });

      mockPrisma.subscription.findMany
        .mockResolvedValueOnce([sub])
        .mockResolvedValueOnce([]);

      await service.handleSubscriptionRenewal();

      const upsertCall = mockPrisma._tx.creditBalance.upsert.mock.calls[0][0];
      expect(upsertCall.update.planCreditsRemaining).toBe(3500);
      expect(upsertCall.create.planCreditsRemaining).toBe(3500);
    });
  });
});
