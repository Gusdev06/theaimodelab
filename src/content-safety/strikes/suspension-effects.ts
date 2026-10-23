import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { EmailService } from '../../email/email.service';
import type { TerminalSafetyBlockError } from '../../generations/errors/content-safety.error';
import { GenerationProcessor } from '../../generations/queue/generation.processor';
import {
  GENERATION_QUEUE,
  GENERATION_UNLIMITED_QUEUE,
} from '../../generations/queue/generation-queue.constants';
import { UnlimitedService } from '../../unlimited/unlimited.service';
import { ImageSafetyService } from '../image-safety/image-safety.service';
import type {
  GenerationQueueRef,
  QueueLike,
  SuspensionEffects,
} from './strikes.types';

/**
 * Efeitos da suspensão buscados na hora pelo ModuleRef (como o cron da quarentena faz com o processor): a camada 6 não
 * importa o módulo de gerações, da fila nem do e-mail, e nada disso cria dependência circular com o porteiro. Peça que
 * não existe neste processo (teste, módulo fora) vira "sem efeito" com log, nunca erro na decisão.
 */
export function createSuspensionEffects(
  moduleRef: ModuleRef,
): SuspensionEffects {
  const logger = new Logger('SuspensionEffects');
  const lookup = <T>(token: unknown, label: string): T | null => {
    try {
      return moduleRef.get<T>(token as never, { strict: false });
    } catch {
      logger.warn(`${label} indisponível neste processo`);
      return null;
    }
  };

  return {
    queues(): GenerationQueueRef[] {
      const refs: GenerationQueueRef[] = [];
      for (const [name, unlimited] of [
        [GENERATION_QUEUE, false],
        [GENERATION_UNLIMITED_QUEUE, true],
      ] as const) {
        const queue = lookup<QueueLike>(getQueueToken(name), `fila ${name}`);
        if (queue) refs.push({ name, queue, unlimited });
      }
      return refs;
    },

    async failGeneration(
      generationId: string,
      error: TerminalSafetyBlockError,
    ): Promise<void> {
      const processor = lookup<GenerationProcessor>(
        GenerationProcessor,
        'GenerationProcessor',
      );
      if (!processor) {
        throw new Error('GenerationProcessor indisponível');
      }
      await processor.failForSafety(generationId, error, 'processing');
    },

    async releaseUnlimitedLock(userId: string): Promise<void> {
      await lookup<UnlimitedService>(
        UnlimitedService,
        'UnlimitedService',
      )?.releaseLock(userId);
    },

    async holdUncheckedOutputs(userId: string): Promise<number> {
      const imageSafety = lookup<ImageSafetyService>(
        ImageSafetyService,
        'ImageSafetyService',
      );
      return imageSafety
        ? imageSafety.holdUncheckedOutputsOfAccount(userId)
        : 0;
    },

    async sendNotice(message): Promise<boolean> {
      const email = lookup<EmailService>(EmailService, 'EmailService');
      if (!email) return false;
      const { id } = await email.sendRawEmail(message);
      return id !== null;
    },
  };
}
