import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { GenerationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GenerationEventsService } from '../generation-events.service';
import { UnlimitedService } from '../../unlimited/unlimited.service';
import { ContentSafetyError } from '../errors/content-safety.error';
import {
  failureCodeOf,
  failureUserMessage,
  GenerationFailureCode,
} from '../errors/failure-reason';
import { GenerationProcessor, willBeRetried } from './generation.processor';
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
    try {
      await this.generationProcessor.dispatch(job.name, job.data);
    } catch (error) {
      const terminal = this.generationProcessor.terminalSafetyBlockOf(
        error,
        job.data,
      );
      if (!terminal) throw error;
      // Bloqueio terminal (menor de idade, foto sem atestado): encerra aqui e o job CONCLUI (o onCompleted solta o
      // lock). Relançar faria o BullMQ mandar o mesmo prompt e as mesmas fotos ao provedor 30 s depois.
      this.logger.warn(
        `[UNLIMITED] Job ${job.id} [${job.name}] encerrado sem nova tentativa: ${terminal.name} (${terminal.failureCode})`,
      );
      await this.finalize(meta, terminal);
    }
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
    if (willBeRetried(job)) {
      this.logger.warn(`[UNLIMITED] Job ${job.id} will be retried`);
      return;
    }

    try {
      await this.finalize(meta, error);
    } finally {
      // o lock sai mesmo se o encerramento falhar: preso, travaria o ilimitado do usuário
      await this.unlimitedService.releaseLock(meta.userId).catch((err) => {
        this.logger.warn(
          `[UNLIMITED] Failed to release lock for user ${meta.userId}: ${(err as Error).message}`,
        );
      });
    }
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
   * Encerra a geração (markFailed). Nunca lança: no process() um erro faria o BullMQ repetir o job e reenviar o
   * pedido ao provedor; no onFailed a geração ficaria PROCESSING. Se o encerramento normal falhar, marca FAILED só
   * se ainda estiver PROCESSING (failStuckGeneration).
   */
  private async finalize(meta: UnlimitedJobMeta, error: Error): Promise<void> {
    try {
      await this.markFailed(meta.generationId, meta.userId, error);
    } catch (finalizeError) {
      this.logger.error(
        `[UNLIMITED] Encerramento da geração ${meta.generationId} falhou: ${(finalizeError as Error).message}`,
      );
      await this.generationProcessor.failStuckGeneration(
        meta.generationId,
        meta.userId,
        error,
      );
    }
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
    // mesma classificação do fluxo normal — o front mostra o motivo pelo código;
    // o código que a guarda de segurança decidiu (menor, foto sem atestado) vem pronto no erro
    const errorCode = failureCodeOf(error, isSafetyError);
    // bloqueio nunca mostra o texto cru do provedor; menor usa o texto da trava da API
    const userMessage = failureUserMessage(errorCode, error);

    await this.prisma.generation.update({
      where: { id: generationId },
      data: {
        status: GenerationStatus.FAILED,
        errorMessage: userMessage,
        errorCode,
      },
    });

    // MINOR_BLOCKED uma vez por geração: só aqui, depois da trava de idempotência acima
    if (errorCode === GenerationFailureCode.CONTENT_POLICY_MINOR) {
      await this.generationProcessor.recordProviderMinorBlock(
        generationId,
        userId,
        error,
      );
    }

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
