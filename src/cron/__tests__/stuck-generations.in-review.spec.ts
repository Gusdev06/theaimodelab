import { Logger } from '@nestjs/common';
import { GenerationStatus } from '@prisma/client';
import {
  StuckGenerationsService,
  stuckGenerationsWhere,
} from '../stuck-generations.service';

/**
 * Cron de presas com a checagem de segurança: IN_REVIEW nunca entra (a quarentena tem cron próprio) e o tempo conta do
 * fim do preflight (safetyCheckedAt) quando houver, senão da criação.
 */
describe('StuckGenerationsService · IN_REVIEW e safetyCheckedAt', () => {
  const threshold = new Date('2026-10-17T12:00:00Z');

  it('só PROCESSING; safetyCheckedAt quando houver, createdAt quando não', () => {
    expect(stuckGenerationsWhere(threshold)).toEqual({
      status: GenerationStatus.PROCESSING,
      OR: [
        { safetyCheckedAt: null, createdAt: { lt: threshold } },
        { safetyCheckedAt: { lt: threshold } },
      ],
    });
  });

  it('encerra só quem AINDA está PROCESSING: concluída ou segurada no meio do caminho não é estornada', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const generation = {
      id: 'gen-1',
      userId: 'user-1',
      status: GenerationStatus.PROCESSING,
      creditsConsumed: 150,
      usedFreeGeneration: false,
      usedFreeGenerationType: null,
    };
    const tx = {
      generation: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        update: jest.fn(),
      },
      creditTransaction: { findMany: jest.fn(), create: jest.fn() },
      creditBalance: { findUnique: jest.fn(), update: jest.fn() },
    };
    const prisma = {
      generation: { findMany: jest.fn(async () => [generation]) },
      $transaction: jest.fn(async (run: (client: typeof tx) => unknown) =>
        run(tx),
      ),
    };
    const cronLogger = {
      wrap: jest.fn(async (_meta: unknown, run: () => Promise<unknown>) =>
        run(),
      ),
    };
    const service = new StuckGenerationsService(
      prisma as never,
      cronLogger as never,
    );

    await expect(service.handleStuckGenerations()).resolves.toEqual({
      stuckFound: 1,
      recovered: 0,
      failed: 0,
    });
    expect(tx.generation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gen-1', status: GenerationStatus.PROCESSING },
      }),
    );
    expect(tx.creditBalance.update).not.toHaveBeenCalled();
    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('com a quarentena gravando: apaga a sobra do resultado da presa (sem evidência em guarda)', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const generation = {
      id: 'gen-2',
      userId: 'user-1',
      status: GenerationStatus.PROCESSING,
      creditsConsumed: 0,
      usedFreeGeneration: false,
      usedFreeGenerationType: null,
    };
    const tx = {
      generation: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const prisma = {
      generation: { findMany: jest.fn(async () => [generation]) },
      contentSafetyEvent: { count: jest.fn(async () => 0) },
      $transaction: jest.fn(async (run: (client: typeof tx) => unknown) =>
        run(tx),
      ),
    };
    const uploads = {
      quarantineEnabled: true,
      deleteQuarantinePrefix: jest.fn(async () => 1),
    };
    const cronLogger = {
      wrap: jest.fn(async (_meta: unknown, run: () => Promise<unknown>) =>
        run(),
      ),
    };
    const service = new StuckGenerationsService(
      prisma as never,
      cronLogger as never,
      uploads as never,
    );

    await service.handleStuckGenerations();

    expect(uploads.deleteQuarantinePrefix).toHaveBeenCalledWith(
      'generations/gen-2/',
    );
    jest.restoreAllMocks();
  });

  it('a rodada usa esse filtro (IN_REVIEW fica fora)', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const prisma = { generation: { findMany: jest.fn(async () => []) } };
    const cronLogger = {
      wrap: jest.fn(async (_meta: unknown, run: () => Promise<unknown>) =>
        run(),
      ),
    };
    const service = new StuckGenerationsService(
      prisma as never,
      cronLogger as never,
    );

    await service.handleStuckGenerations();

    const where = (
      prisma.generation.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where.status).toBe(GenerationStatus.PROCESSING);
    expect(JSON.stringify(where)).not.toContain('IN_REVIEW');
    expect(where.OR).toEqual([
      { safetyCheckedAt: null, createdAt: { lt: expect.any(Date) } },
      { safetyCheckedAt: { lt: expect.any(Date) } },
    ]);
    jest.restoreAllMocks();
  });
});
