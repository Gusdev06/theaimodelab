import { Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import { GenerationStatus } from '@prisma/client';
import { UnlimitedProcessor } from '../unlimited.processor';
import { GenerationJobName } from '../generation-queue.constants';
import {
  InputImageSafetyBlockError,
  SafetyCheckPendingError,
} from '../../errors/content-safety.error';
import {
  GenerationFailureCode,
  IMAGE_SAFETY_BLOCKED_MESSAGE,
} from '../../errors/failure-reason';

/**
 * Ilimitado com a checagem de segurança: pendente espera na fila (lock preso, é a mesma geração), bloqueio encerra
 * com o código genérico e sem estorno (o ilimitado não cobra), geração segurada nunca é marcada como falha.
 */

const GEN = 'gen-u1';
const USER = 'user-u1';

const job = (): Job =>
  ({
    id: 'job-u1',
    name: GenerationJobName.IMAGE,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      generationId: GEN,
      userId: USER,
      creditsConsumed: 0,
      prompt: 'x',
      model: 'gpt-image-2',
    },
    updateData: jest.fn(async () => undefined),
    moveToDelayed: jest.fn(async () => undefined),
  }) as unknown as Job;

describe('UnlimitedProcessor · segurança de imagem', () => {
  let status: GenerationStatus;
  let prisma: { generation: { findUnique: jest.Mock; update: jest.Mock } };
  let generationProcessor: Record<string, jest.Mock>;
  let unlimited: { releaseLock: jest.Mock; extendLock: jest.Mock };
  let events: { emit: jest.Mock };
  let processor: UnlimitedProcessor;

  beforeEach(() => {
    status = GenerationStatus.PROCESSING;
    prisma = {
      generation: {
        findUnique: jest.fn(async () => ({ status })),
        update: jest.fn(async () => ({})),
      },
    };
    generationProcessor = {
      dispatch: jest.fn(),
      terminalSafetyBlockOf: jest.fn((error: unknown) =>
        error instanceof InputImageSafetyBlockError ? error : null,
      ),
      recordProviderMinorBlock: jest.fn(),
      failStuckGeneration: jest.fn(),
    };
    unlimited = {
      releaseLock: jest.fn().mockResolvedValue(undefined),
      extendLock: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };
    processor = new UnlimitedProcessor(
      prisma as never,
      generationProcessor as never,
      unlimited as never,
      events as never,
    );
  });

  it('checagem pendente: adia o job (DelayedError) sem soltar o lock', async () => {
    generationProcessor.dispatch.mockRejectedValue(
      new SafetyCheckPendingError('rekognition', 'throttled', 60_000, 5, 1),
    );
    const queued = job();

    await expect(processor.process(queued, 'tok')).rejects.toBeInstanceOf(
      DelayedError,
    );

    expect(queued.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ safetyFirstAttemptAt: 5, safetyDeferrals: 2 }),
    );
    expect(queued.moveToDelayed).toHaveBeenCalledWith(
      expect.any(Number),
      'tok',
    );
    expect(unlimited.releaseLock).not.toHaveBeenCalled();
    // o lock do ilimitado ganha o prazo da espera + o normal (não vence no meio do adiamento)
    expect(unlimited.extendLock).toHaveBeenCalledWith(USER, 60 + 15 * 60);
    expect(prisma.generation.update).not.toHaveBeenCalled();
  });

  it('renovar o lock falhando (Redis fora) não impede o adiamento', async () => {
    unlimited.extendLock.mockRejectedValue(new Error('redis fora'));
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    generationProcessor.dispatch.mockRejectedValue(
      new SafetyCheckPendingError('rekognition', 'throttled', 60_000, 5, 1),
    );
    const queued = job();

    await expect(processor.process(queued, 'tok')).rejects.toBeInstanceOf(
      DelayedError,
    );
    expect(queued.moveToDelayed).toHaveBeenCalled();
  });

  it('entrada barrada: encerra com o código genérico, sem estorno e sem MINOR_BLOCKED', async () => {
    generationProcessor.dispatch.mockRejectedValue(
      new InputImageSafetyBlockError('E2', 'STRONG'),
    );

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(prisma.generation.update).toHaveBeenCalledWith({
      where: { id: GEN },
      data: {
        status: GenerationStatus.FAILED,
        errorMessage: IMAGE_SAFETY_BLOCKED_MESSAGE,
        errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
      },
    });
    expect(generationProcessor.recordProviderMinorBlock).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ creditsRefunded: 0 }),
      }),
    );
  });

  it('geração segurada (IN_REVIEW) nunca é marcada como falha pelo ilimitado', async () => {
    status = GenerationStatus.IN_REVIEW;
    const failed = Object.assign(job(), { attemptsMade: 2, finishedOn: 1 });

    await processor.onFailed(failed, new Error('Internal Error'));

    expect(prisma.generation.update).not.toHaveBeenCalled();
    expect(unlimited.releaseLock).toHaveBeenCalledWith(USER);
  });
});
