import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Cron } from '@nestjs/schedule';
import { GenerationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SafetyCheckUnavailableError,
  type TerminalSafetyBlockError,
} from '../../generations/errors/content-safety.error';
import { GenerationProcessor } from '../../generations/queue/generation.processor';
import {
  IMAGE_SAFETY_CONFIG,
  SAFETY_TIMING,
  type ImageSafetyConfig,
} from './image-safety.config';
import {
  ImageSafetyService,
  type HoldState,
  type OutputCompletion,
  type SafetyHoldRecord,
  type StagedPromotion,
} from './image-safety.service';

/** Quem conclui ou encerra a geração segurada (o GenerationProcessor: miniaturas, saídas, estorno, SSE). */
export interface HeldGenerationFinisher {
  completeHeldGeneration(
    generationId: string,
    outputUrls: string[],
    completion: OutputCompletion,
  ): Promise<boolean>;
  /** `from` padrão 'held' (troca IN_REVIEW → PROCESSING); 'processing' = quem chama já ganhou essa troca */
  failForSafety(
    generationId: string,
    error: TerminalSafetyBlockError,
    from?: 'held' | 'processing',
  ): Promise<void>;
}

export const QUARANTINE_SCHEDULE = '*/5 * * * *';
/** Gerações IN_REVIEW lidas por página (a rodada percorre as páginas até o fim ou até o tempo da rodada acabar). */
const SWEEP_PAGE = 100;

export type QuarantineAction = 'completed' | 'failed' | 'alerted' | 'waiting';

export interface QuarantineSweepSummary {
  checked: number;
  completed: number;
  failed: number;
  alerted: number;
}

/**
 * Cron da quarentena (camada 5), a cada 5 min. Motivo de cada IN_REVIEW lido das checagens (holdReasonOf):
 *  - resultado sem checagem: checa de novo; aprovado conclui, menor encerra com estorno; provedor com filtro de
 *    confiança (SAFETY_TRUSTED_FILTER_MODELS) depois de 10 min sai sem checagem (registrado); 2 h sem checagem = falha
 *    com estorno;
 *  - resultado em revisão: aviso no prazo da meta (4 h, gravado no banco, uma vez); sem decisão do revisor em 24 h vai
 *    para a evidência e falha com estorno. NUNCA é publicado sozinho;
 *  - entrada segurada sem decisão em 24 h: vai para a evidência e falha com estorno.
 * Com as duas checagens desligadas (kill switch), ou só a de imagem com o resultado segurado, a rodada continua
 * enquanto houver IN_REVIEW: nada é checado nem publicado; tudo encerra na hora com estorno (o que era suspeito vai
 * para a evidência, o resto é apagado).
 * A rodada percorre TODAS as IN_REVIEW por cursor (o que só espera revisor não trava a fila) e continua na próxima
 * rodada de onde parou quando o tempo acaba.
 */
@Injectable()
export class QuarantineCron {
  private readonly logger = new Logger(QuarantineCron.name);
  private running = false;
  /** de onde a próxima rodada continua quando a anterior parou pelo tempo (id da última geração vista) */
  private resumeAfter: string | null = null;
  /** revisões vencidas já avisadas neste processo (além da marca no banco, que sobrevive ao reinício) */
  private readonly alerted = new Set<string>();

  constructor(
    @Inject(IMAGE_SAFETY_CONFIG) private readonly config: ImageSafetyConfig,
    private readonly prisma: PrismaService,
    private readonly imageSafety: ImageSafetyService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Ninguém mais decidiria esta geração: as duas checagens desligadas, ou a de imagem desligada com o RESULTADO
   * segurado (sem leitor de imagem, a nova checagem não checaria nada e acabaria promovendo sem checar).
   */
  private closesWithoutReview(reason: HoldState['reason']): boolean {
    if (this.config.imageMode !== 'off') return false;
    return this.config.textMode === 'off' || reason !== 'input_review';
  }

  @Cron(QUARANTINE_SCHEDULE)
  async sweep(now: Date = new Date()): Promise<QuarantineSweepSummary | null> {
    if (this.running) return null;
    this.running = true;
    const summary: QuarantineSweepSummary = {
      checked: 0,
      completed: 0,
      failed: 0,
      alerted: 0,
    };
    const startedAt = Date.now();
    try {
      // começa de onde a rodada anterior parou e, no fim da lista, volta ao começo até esse ponto
      const start = this.resumeAfter;
      const ranges: Array<{ gt?: string; lte?: string }> = start
        ? [{ gt: start }, { lte: start }]
        : [{}];
      let finisher: HeldGenerationFinisher | null | undefined;
      for (const range of ranges) {
        let cursor: string | null = null;
        for (;;) {
          const idFilter = { ...range, ...(cursor ? { gt: cursor } : {}) };
          const page = await this.prisma.generation.findMany({
            where: {
              status: GenerationStatus.IN_REVIEW,
              ...(Object.keys(idFilter).length ? { id: idFilter } : {}),
            },
            select: { id: true },
            orderBy: { id: 'asc' },
            take: SWEEP_PAGE,
          });
          if (page.length === 0) break;
          finisher ??= this.finisher();
          if (!finisher) {
            this.logger.error(
              'GenerationProcessor indisponível: quarentena não processada nesta rodada',
            );
            return summary;
          }
          for (const generation of page) {
            summary.checked++;
            cursor = generation.id;
            try {
              const action = await this.handle(generation.id, finisher, now);
              if (action === 'completed') summary.completed++;
              if (action === 'failed') summary.failed++;
              if (action === 'alerted') summary.alerted++;
            } catch (error) {
              this.logger.error(
                `gen=${generation.id}: quarentena não processada (${(error as Error).message?.slice(0, 200)})`,
              );
            }
            if (
              Date.now() - startedAt >=
              SAFETY_TIMING.quarantineSweepBudgetMs
            ) {
              // tempo da rodada acabou: a próxima continua daqui
              this.resumeAfter = cursor;
              return summary;
            }
          }
          if (page.length < SWEEP_PAGE) break;
        }
      }
      this.resumeAfter = null;
      return summary;
    } catch (error) {
      this.logger.error(
        `Cron da quarentena falhou: ${(error as Error).message?.slice(0, 200)}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** Uma geração IN_REVIEW. Público para os testes. */
  async handle(
    generationId: string,
    finisher: HeldGenerationFinisher,
    now: Date,
  ): Promise<QuarantineAction> {
    const state = await this.imageSafety.holdStateOf(generationId);
    if (!state) return 'waiting';
    if (this.closesWithoutReview(state.reason)) {
      return this.closeOnKillSwitch(generationId, state, finisher);
    }
    const age = now.getTime() - state.heldAt.getTime();

    if (state.reason === 'input_review') {
      if (age < SAFETY_TIMING.inputHoldDecisionMs) return 'waiting';
      const error = await this.imageSafety.expireHeldInput(generationId);
      await finisher.failForSafety(generationId, error);
      this.logger.warn(
        `gen=${generationId}: entrada segurada sem decisão do revisor em 24 h — encerrada com estorno`,
      );
      return 'failed';
    }

    if (state.reason === 'output_review') {
      if (age >= SAFETY_TIMING.outputReviewDecisionMs) {
        const error = await this.imageSafety.expireReviewedOutput(generationId);
        await finisher.failForSafety(generationId, error);
        this.logger.warn(
          `gen=${generationId}: resultado em revisão sem decisão em ${Math.round(SAFETY_TIMING.outputReviewDecisionMs / 3_600_000)} h — evidência guardada, encerrado com estorno (nunca publicado)`,
        );
        return 'failed';
      }
      if (
        age >= SAFETY_TIMING.outputReviewTargetMs &&
        !state.alertedAt &&
        !this.alerted.has(generationId)
      ) {
        this.alerted.add(generationId);
        await this.imageSafety.markReviewAlerted(generationId);
        this.logger.warn(
          `[ALERTA] gen=${generationId}: resultado em revisão há mais de ${Math.round(age / 3_600_000)} h — continua segurado até um revisor decidir (ou até o prazo final)`,
        );
        return 'alerted';
      }
      return 'waiting';
    }

    // resultado aguardando checagem: tenta de novo
    const outcome = await this.imageSafety.recheckHeldOutput(generationId);
    if (outcome?.action === 'promote' && state.hold) {
      return this.completePromoted(
        generationId,
        outcome.outputs,
        outcome.staged ?? [],
        state.hold,
        finisher,
      );
    }
    if (outcome?.action === 'blocked') {
      await finisher.failForSafety(generationId, outcome.error);
      return 'failed';
    }

    const after = await this.imageSafety.holdStateOf(generationId);
    if (after?.reason !== 'output_unchecked') return 'waiting';

    const model = (after.modelUsed || '').trim().toLowerCase();
    if (
      after.hold &&
      this.config.trustedFilterModels.has(model) &&
      age >= SAFETY_TIMING.trustedFilterReleaseMs
    ) {
      const released = await this.imageSafety.releaseUncheckedOutput(
        generationId,
        `provedor com filtro de confiança (${model}) sem checagem há mais de ${Math.round(SAFETY_TIMING.trustedFilterReleaseMs / 60_000)} min`,
      );
      if (released) {
        return this.completePromoted(
          generationId,
          released.outputs,
          released.staged,
          after.hold,
          finisher,
        );
      }
    }

    if (age >= SAFETY_TIMING.quarantineMaxUncheckedMs) {
      await this.imageSafety.discardHeldOutput(generationId);
      await finisher.failForSafety(
        generationId,
        new SafetyCheckUnavailableError('quarentena', 'sem checagem no prazo'),
      );
      this.logger.warn(
        `gen=${generationId}: resultado sem checagem há mais de 2 h — encerrado com estorno`,
      );
      return 'failed';
    }
    return 'waiting';
  }

  /**
   * Conclui o resultado aprovado (cópias públicas já feitas, quarentena inteira) e só então resolve a 2ª fase: venceu a
   * troca IN_REVIEW → PROCESSING = a quarentena sai; perdeu (o revisor confirmou ou liberou antes) = as cópias públicas
   * saem e a quarentena fica para quem venceu. Conclusão que lança deixa as duas (nada se perde) e sobe para o log.
   */
  private async completePromoted(
    generationId: string,
    outputs: string[],
    staged: StagedPromotion[],
    hold: SafetyHoldRecord,
    finisher: HeldGenerationFinisher,
  ): Promise<QuarantineAction> {
    const done = await finisher.completeHeldGeneration(
      generationId,
      outputs,
      hold,
    );
    await this.imageSafety.settleHeldPromotion(generationId, staged, done);
    return done ? 'completed' : 'waiting';
  }

  /**
   * Checagens desligadas com geração ainda segurada: sem revisor e sem checagem, ninguém mais a decidiria. Encerra na
   * hora com estorno, sem chamar fornecedor e sem publicar: entrada segurada e resultado em revisão vão para a
   * evidência; resultado sem checagem é apagado.
   */
  private async closeOnKillSwitch(
    generationId: string,
    state: HoldState,
    finisher: HeldGenerationFinisher,
  ): Promise<QuarantineAction> {
    let error: TerminalSafetyBlockError;
    if (state.reason === 'input_review') {
      error = await this.imageSafety.expireHeldInput(generationId);
    } else if (state.reason === 'output_review') {
      error = await this.imageSafety.expireReviewedOutput(generationId);
    } else {
      await this.imageSafety.discardHeldOutput(generationId);
      error = new SafetyCheckUnavailableError(
        'quarentena',
        'checagem desligada',
      );
    }
    await finisher.failForSafety(generationId, error);
    this.logger.warn(
      `gen=${generationId}: checagens desligadas com a geração segurada (${state.reason}) — encerrada com estorno, nada publicado`,
    );
    return 'failed';
  }

  private finisher(): HeldGenerationFinisher | null {
    try {
      return this.moduleRef.get(GenerationProcessor, { strict: false });
    } catch {
      return null;
    }
  }
}
