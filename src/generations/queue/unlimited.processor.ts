import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { GenerationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GenerationEventsService } from '../generation-events.service';
import { UnlimitedService } from '../../unlimited/unlimited.service';
import { ContentSafetyError } from '../errors/content-safety.error';
import { GenerationProcessor } from './generation.processor';
import { GENERATION_UNLIMITED_QUEUE } from './generation-queue.constants';

interface UnlimitedJobMeta {
  generationId: string;
  userId: string;
}

@Processor(GENERATION_UNLIMITED_QUEUE, {
  concurrency: 10,
  lockDuration: 15 * 60 * 1000,
})
export class UnlimitedProcessor extends WorkerHost {
  private readonly logger = new Logger(UnlimitedProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly generationProcessor: GenerationProcessor,
    private readonly unlimitedService: UnlimitedService,
    private readonly generationEvents: GenerationEventsService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const meta = this.extractMeta(job);
    this.logger.log(
      `[UNLIMITED] Processing job ${job.id} [${job.name}] for generation ${meta.generationId} (user ${meta.userId})`,
    );

    // Delega processamento real ao GenerationProcessor (mesmo dispatcher,
    // mesmos providers, mesma lógica de fallback/safety).
    await this.generationProcessor.dispatch(job.name, job.data);
  }

  @OnWorkerEvent('completed')
  async onCompleted(job: Job): Promise<void> {
    const meta = this.extractMeta(job);
    await this.unlimitedService.releaseLock(meta.userId).catch((err) => {
      this.logger.warn(
        `[UNLIMITED] Failed to release lock for user ${meta.userId}: ${(err as Error).message}`,
      );
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error): Promise<void> {
    const meta = this.extractMeta(job);
    this.logger.error(
      `[UNLIMITED] Job ${job.id} [${job.name}] failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${error.message}`,
    );

    // Só finaliza após esgotar tentativas — durante retries o lock fica preso
    // de propósito (mesma "geração ilimitada" do ponto de vista do usuário).
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      this.logger.warn(`[UNLIMITED] Job ${job.id} will be retried`);
      return;
    }

    await this.markFailed(meta.generationId, meta.userId, error);
    await this.unlimitedService.releaseLock(meta.userId).catch((err) => {
      this.logger.warn(
        `[UNLIMITED] Failed to release lock for user ${meta.userId}: ${(err as Error).message}`,
      );
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private extractMeta(job: Job): UnlimitedJobMeta {
    const data = job.data as Partial<UnlimitedJobMeta> | undefined;
    if (!data?.generationId || !data?.userId) {
      throw new Error(
        `Unlimited job ${job.id} missing generationId or userId in data`,
      );
    }
    return { generationId: data.generationId, userId: data.userId };
  }

  /**
   * Marca a generation como FAILED e emite o evento SSE. Sem refund de
   * créditos porque o modo ilimitado não debita nada.
   */
  private async markFailed(
    generationId: string,
    userId: string,
    error: Error,
  ): Promise<void> {
    const current = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (
      current?.status === GenerationStatus.COMPLETED ||
      current?.status === GenerationStatus.FAILED
    ) {
      return;
    }

    const isSafetyError = error instanceof ContentSafetyError;
    const errorCode = isSafetyError
      ? 'CONTENT_SAFETY_BLOCKED'
      : 'GENERATION_FAILED';
    const userMessage = isSafetyError
      ? 'A imagem ou texto enviado viola nossas diretrizes de conteúdo. Tente reformular seu prompt ou use outra imagem.'
      : error.message;

    await this.prisma.generation.update({
      where: { id: generationId },
      data: {
        status: GenerationStatus.FAILED,
        errorMessage: userMessage,
        errorCode,
      },
    });

    this.generationEvents.emit({
      userId,
      generationId,
      status: 'failed',
      data: {
        errorMessage: userMessage,
        errorCode,
        creditsRefunded: 0,
      },
    });
  }
}
