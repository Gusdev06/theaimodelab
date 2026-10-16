import type { Job } from 'bullmq';
import { GenerationStatus } from '@prisma/client';
import { UnlimitedProcessor } from '../unlimited.processor';
import { GenerationJobName } from '../generation-queue.constants';
import {
  ConsentRequiredSafetyError,
  ContentSafetyError,
  MINOR_BLOCK_USER_MESSAGE,
  MinorSafetyBlockError,
} from '../../errors/content-safety.error';
import {
  CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
  GenerationFailureCode,
} from '../../errors/failure-reason';

/**
 * O modo ilimitado usa o mesmo dispatcher do GenerationProcessor. Bloqueio terminal (menor, foto sem atestado)
 * encerra a geração sem nova tentativa, sem estorno (o ilimitado não debita) e com o texto para o usuário, nunca o
 * texto cru do provedor.
 */

const GEN_ID = 'gen-u1';
const USER_ID = 'user-u1';

const job = (extra: Record<string, unknown> = {}): Job =>
  ({
    id: 'job-u1',
    name: GenerationJobName.IMAGE,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      generationId: GEN_ID,
      userId: USER_ID,
      creditsConsumed: 0,
      prompt: 'mulher adulta na praia',
      model: 'gpt-image-2',
      hasInputImages: false,
    },
    ...extra,
  }) as unknown as Job;

describe('UnlimitedProcessor · bloqueio de segurança', () => {
  let processor: UnlimitedProcessor;
  let prisma: {
    generation: { findUnique: jest.Mock; update: jest.Mock };
  };
  let generationProcessor: {
    dispatch: jest.Mock;
    terminalSafetyBlockOf: jest.Mock;
    recordProviderMinorBlock: jest.Mock;
    failStuckGeneration: jest.Mock;
  };
  let unlimitedService: { releaseLock: jest.Mock };
  let events: { emit: jest.Mock };

  beforeEach(() => {
    prisma = {
      generation: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: GenerationStatus.PROCESSING }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    generationProcessor = {
      dispatch: jest.fn(),
      terminalSafetyBlockOf: jest.fn().mockReturnValue(null),
      recordProviderMinorBlock: jest.fn().mockResolvedValue(undefined),
      failStuckGeneration: jest.fn().mockResolvedValue(undefined),
    };
    unlimitedService = { releaseLock: jest.fn().mockResolvedValue(undefined) };
    events = { emit: jest.fn() };
    processor = new UnlimitedProcessor(
      prisma as any,
      generationProcessor as any,
      unlimitedService as any,
      events as any,
    );
  });

  it('recusa por menor: encerra sem nova tentativa, texto de menor, 1 MINOR_BLOCKED e nada de estorno', async () => {
    const minor = new MinorSafetyBlockError(
      new ContentSafetyError('Request blocked (support code: 58061214)'),
      'gpt-image-2',
    );
    generationProcessor.dispatch.mockRejectedValue(minor);
    generationProcessor.terminalSafetyBlockOf.mockReturnValue(minor);

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(prisma.generation.update).toHaveBeenCalledWith({
      where: { id: GEN_ID },
      data: {
        status: GenerationStatus.FAILED,
        errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
        errorMessage: MINOR_BLOCK_USER_MESSAGE,
      },
    });
    expect(generationProcessor.recordProviderMinorBlock).toHaveBeenCalledTimes(
      1,
    );
    expect(generationProcessor.recordProviderMinorBlock).toHaveBeenCalledWith(
      GEN_ID,
      USER_ID,
      minor,
    );
    expect(events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        data: expect.objectContaining({ creditsRefunded: 0 }),
      }),
    );
  });

  it('foto sem atestado: CONTENT_BLOCKED_NEEDS_CONSENT sem nova tentativa', async () => {
    const blocked = new ConsentRequiredSafetyError(
      new ContentSafetyError('content policy violation'),
      'gpt-image-2',
    );
    generationProcessor.dispatch.mockRejectedValue(blocked);
    generationProcessor.terminalSafetyBlockOf.mockReturnValue(blocked);

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(prisma.generation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          errorCode: GenerationFailureCode.CONTENT_BLOCKED_NEEDS_CONSENT,
          errorMessage: CONTENT_BLOCKED_NEEDS_CONSENT_MESSAGE,
        }),
      }),
    );
    expect(generationProcessor.recordProviderMinorBlock).not.toHaveBeenCalled();
  });

  it('encerramento do bloqueio que falha não relança (sem reenvio) e cai na reserva', async () => {
    const minor = new MinorSafetyBlockError(
      'flagged: sexual/minors',
      'gpt-image-2',
    );
    generationProcessor.dispatch.mockRejectedValue(minor);
    generationProcessor.terminalSafetyBlockOf.mockReturnValue(minor);
    prisma.generation.update.mockRejectedValue(new Error('banco fora'));

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(generationProcessor.failStuckGeneration).toHaveBeenCalledWith(
      GEN_ID,
      USER_ID,
      minor,
    );
  });

  it('falha comum relança (o retry do BullMQ segue valendo)', async () => {
    generationProcessor.dispatch.mockRejectedValue(
      new Error('Internal server error'),
    );

    await expect(processor.process(job())).rejects.toThrow(
      'Internal server error',
    );
    expect(prisma.generation.update).not.toHaveBeenCalled();
  });

  describe('onFailed', () => {
    it('texto cru de menor no fim das tentativas: mostra o texto de menor, registra MINOR_BLOCKED e solta o lock', async () => {
      const raw = new ContentSafetyError('Image flagged: sexual/minors');

      await processor.onFailed(
        job({ attemptsMade: 2, finishedOn: Date.now() }),
        raw,
      );

      expect(prisma.generation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            errorCode: GenerationFailureCode.CONTENT_POLICY_MINOR,
            errorMessage: MINOR_BLOCK_USER_MESSAGE,
          }),
        }),
      );
      expect(
        generationProcessor.recordProviderMinorBlock,
      ).toHaveBeenCalledTimes(1);
      expect(unlimitedService.releaseLock).toHaveBeenCalledWith(USER_ID);
    });

    it('falha definitiva antes da última tentativa (finishedOn) encerra e solta o lock', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1, finishedOn: Date.now() }),
        new Error('Internal server error'),
      );

      expect(prisma.generation.update).toHaveBeenCalled();
      expect(unlimitedService.releaseLock).toHaveBeenCalledWith(USER_ID);
    });

    it('job que ainda vai ser repetido não encerra nem solta o lock', async () => {
      await processor.onFailed(
        job({ attemptsMade: 1 }),
        new Error('Internal server error'),
      );

      expect(prisma.generation.update).not.toHaveBeenCalled();
      expect(unlimitedService.releaseLock).not.toHaveBeenCalled();
    });

    it('encerramento que lança: reserva marca FAILED e o lock sai do mesmo jeito', async () => {
      prisma.generation.update.mockRejectedValue(new Error('banco fora'));

      await expect(
        processor.onFailed(
          job({ attemptsMade: 2, finishedOn: Date.now() }),
          new Error('Internal server error'),
        ),
      ).resolves.toBeUndefined();

      expect(generationProcessor.failStuckGeneration).toHaveBeenCalled();
      expect(unlimitedService.releaseLock).toHaveBeenCalledWith(USER_ID);
    });
  });
});
