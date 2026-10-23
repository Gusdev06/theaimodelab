import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { GenerationType, type Prisma } from '@prisma/client';
import {
  GENERATION_QUEUE,
  GENERATION_UNLIMITED_QUEUE,
  type ImageJobData,
} from '../../generations/queue/generation-queue.constants';
import { GenerationProcessor } from '../../generations/queue/generation.processor';
import {
  SAFETY_JOB_DEFERRALS_KEY,
  SAFETY_JOB_FIRST_ATTEMPT_KEY,
} from '../image-safety/image-safety.service';
import type { HeldGenerationFinisher } from '../image-safety/quarantine.cron';

/**
 * Quem conclui, encerra e reenfileira a geração que o revisor decidiu: o GenerationProcessor (miniaturas, saídas,
 * estorno, SSE) e as filas da geração. Lidos pelo ModuleRef, como faz o cron da quarentena, para este módulo não
 * depender do GenerationsModule.
 */
export interface ReviewFinisher extends HeldGenerationFinisher {
  /** execução direta, sem fila (o Unlocked de imagem nasce assim) */
  runImageJobDirectly(data: ImageJobData): Promise<void>;
}

/** O que o processor da fila lê de um job (só o necessário para reenfileirar). */
interface HeldJob {
  name: string;
  data: unknown;
  opts?: {
    attempts?: number;
    backoff?: unknown;
    removeOnComplete?: unknown;
    removeOnFail?: unknown;
  };
  finishedOn?: number;
}

interface QueuePort {
  getJobs(
    types: string[],
    start: number,
    end: number,
    asc: boolean,
  ): Promise<HeldJob[]>;
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

/** Como a geração segurada antes do provedor volta a rodar. */
export type RequeuePlan =
  | {
      kind: 'queue';
      /** fila em que o job original rodou (o ilimitado volta pela fila comum: ver planRequeue) */
      source: 'generation' | 'unlimited';
      jobName: string;
      data: Record<string, unknown>;
      opts: Record<string, unknown>;
    }
  | { kind: 'direct'; data: ImageJobData };

/** Geração lida para montar o plano (as colunas que o job de imagem direto usa). */
export interface HeldGenerationRow {
  id: string;
  userId: string;
  type: GenerationType;
  modelUsed: string;
  prompt: string | null;
  resolution: string;
  aspectRatio: string | null;
  creditsConsumed: number;
  usedFreeGeneration: boolean;
  parameters: Prisma.JsonValue;
}

/** Jobs concluídos lidos por página, e o teto da busca por fila. */
const JOB_PAGE = 200;
const JOB_SCAN_MAX = 5_000;
/** Folga entre a hora do hold (banco) e a conclusão do job (Redis): a busca para em jobs mais velhos que isto. */
const HOLD_JOB_MARGIN_MS = 30 * 60_000;
/** Mesmas opções da fila de geração (generations.module.ts), para quando o job original não trouxer as dele. */
const DEFAULT_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 30_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;
/** Modelo que roda direto, sem fila (generations.service.ts:isSeedream). */
const DIRECT_IMAGE_MODEL = 'sem-censura';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

@Injectable()
export class HeldGenerationDispatcher {
  private readonly logger = new Logger(HeldGenerationDispatcher.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /** GenerationProcessor; null quando não está no ar (o revisor recebe 503 e nada muda). */
  finisher(): ReviewFinisher | null {
    try {
      return this.moduleRef.get(GenerationProcessor, { strict: false });
    } catch {
      return null;
    }
  }

  private queue(name: string): QueuePort | null {
    try {
      return this.moduleRef.get<QueuePort>(getQueueToken(name), {
        strict: false,
      });
    } catch {
      return null;
    }
  }

  /**
   * Como a entrada segurada (E3a) volta a rodar: o job original, que concluiu sem chamar o provedor no momento do
   * hold e fica guardado no Redis por 24 h (o mesmo prazo da decisão), ou, no Unlocked de imagem sem fila, o job
   * direto refeito a partir da geração. null = não deu para achar (o revisor recebe 409 e a geração segue segurada).
   */
  async planRequeue(
    generation: HeldGenerationRow,
    heldAt: Date,
  ): Promise<RequeuePlan | null> {
    for (const source of ['generation', 'unlimited'] as const) {
      const job = await this.findHeldJob(
        source === 'generation' ? GENERATION_QUEUE : GENERATION_UNLIMITED_QUEUE,
        generation.id,
        heldAt,
      );
      if (!job) continue;
      const data = { ...asRecord(job.data) };
      // a janela de espera do porteiro é da rodada anterior: a nova rodada conta do zero
      delete data[SAFETY_JOB_FIRST_ATTEMPT_KEY];
      delete data[SAFETY_JOB_DEFERRALS_KEY];
      const opts = job.opts ?? {};
      return {
        kind: 'queue',
        source,
        jobName: job.name,
        data,
        opts: {
          attempts: opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts,
          backoff: opts.backoff ?? DEFAULT_JOB_OPTIONS.backoff,
          removeOnComplete:
            opts.removeOnComplete ?? DEFAULT_JOB_OPTIONS.removeOnComplete,
          removeOnFail: opts.removeOnFail ?? DEFAULT_JOB_OPTIONS.removeOnFail,
        },
      };
    }
    const parameters = asRecord(generation.parameters);
    if (
      generation.modelUsed === DIRECT_IMAGE_MODEL &&
      parameters.unlimited !== true &&
      (generation.type === GenerationType.TEXT_TO_IMAGE ||
        generation.type === GenerationType.IMAGE_TO_IMAGE)
    ) {
      return {
        kind: 'direct',
        data: {
          generationId: generation.id,
          userId: generation.userId,
          creditsConsumed: generation.creditsConsumed,
          usedFreeGeneration: generation.usedFreeGeneration,
          prompt: generation.prompt ?? '',
          model: generation.modelUsed,
          resolution: generation.resolution,
          aspectRatio: generation.aspectRatio ?? undefined,
          mimeType:
            typeof parameters.mimeType === 'string'
              ? parameters.mimeType
              : undefined,
          hasInputImages: generation.type === GenerationType.IMAGE_TO_IMAGE,
        },
      };
    }
    return null;
  }

  /**
   * Põe a geração para rodar de novo. Fila: sempre a de geração comum, com as opções do job original (o ilimitado não
   * volta à fila dele: o lock por conta já foi solto quando o job concluiu, e reenfileirar lá soltaria o lock de outra
   * geração da conta no fim; o ilimitado não debita, então o estorno da fila comum é zero). Direto: não espera a
   * geração (pode levar minutos); a falha é tratada dentro do runImageJobDirectly.
   */
  async dispatch(plan: RequeuePlan): Promise<void> {
    if (plan.kind === 'queue') {
      const queue = this.queue(GENERATION_QUEUE);
      if (!queue) throw new Error('fila de geração indisponível');
      await queue.add(plan.jobName, plan.data, plan.opts);
      return;
    }
    const finisher = this.finisher();
    if (!finisher) throw new Error('GenerationProcessor indisponível');
    void finisher.runImageJobDirectly(plan.data).catch((error: unknown) =>
      this.logger.error(
        `[SAFETY_REVIEW] gen=${plan.data.generationId}: execução direta liberada pelo revisor falhou (${(error as Error).message?.slice(0, 200)})`,
      ),
    );
  }

  /** Job concluído desta geração, do mais novo para o mais velho; para nos que concluíram bem antes do hold. */
  private async findHeldJob(
    queueName: string,
    generationId: string,
    heldAt: Date,
  ): Promise<HeldJob | null> {
    const queue = this.queue(queueName);
    if (!queue) return null;
    const oldest = heldAt.getTime() - HOLD_JOB_MARGIN_MS;
    try {
      for (let start = 0; start < JOB_SCAN_MAX; start += JOB_PAGE) {
        const page = await queue.getJobs(
          ['completed'],
          start,
          start + JOB_PAGE - 1,
          false,
        );
        for (const job of page) {
          if (!job) continue;
          if (asRecord(job.data).generationId === generationId) {
            return typeof job.name === 'string' && job.name ? job : null;
          }
          if (typeof job.finishedOn === 'number' && job.finishedOn < oldest) {
            return null;
          }
        }
        if (page.length < JOB_PAGE) return null;
      }
    } catch (error) {
      this.logger.warn(
        `[SAFETY_REVIEW] gen=${generationId}: busca do job em ${queueName} falhou (${(error as Error).message?.slice(0, 200)})`,
      );
    }
    return null;
  }
}
