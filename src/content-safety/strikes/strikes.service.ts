import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommunityPostStatus, ContentSafetyEventKind } from '@prisma/client';
import { invalidateActiveUser } from '../../auth/strategies/jwt.strategy';
import { PrismaService } from '../../prisma/prisma.service';
import {
  IMAGE_SAFETY_CONFIG,
  SAFETY_STRIKES,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import { BLOCKLIST } from '../image-safety/image-safety.tokens';
import type { BlocklistPort, Strength } from '../image-safety/types';
import { AccountSuspendedSafetyError } from './strikes.errors';
import {
  MEDIUM_STRIKE_WINDOW_MS,
  PHOTO_RETRY_LONG_WINDOW_MS,
  countMediumPoints,
  jobGenerationIdOf,
  jobUserIdOf,
  photoRetryDecision,
  suspensionReasonOf,
  uniqueStrings,
  usableStrikePhotos,
} from './strikes.rules';
import {
  SAFETY_SUSPENSION_POST_REJECTION_REASON,
  STRIKE_ACCESS_ACTIONS,
  STRIKE_EVENT_KINDS,
  STRIKES_ACTOR_ID,
  SUSPENSION_EFFECTS,
  type GenerationQueueRef,
  type JobLike,
  type StrikeOutcome,
  type StrikePhoto,
  type StrikeSignalContext,
  type StrikesPort,
  type SuspendNoticeResult,
  type SuspensionCause,
  type SuspensionEffects,
} from './strikes.types';
import { buildSuspensionNotice } from './suspension-notice';

/** Teto de eventos lidos na contagem de pontos (a regra para em 3; o teto só protege contra uma conta anômala). */
const POINT_ROWS_MAX = 500;
/** Teto de linhas lidas no limite de novas tentativas com foto (uma conta, 24 h). */
const RETRY_ROWS_MAX = 5_000;
/** Teto de linhas de outras contas com o mesmo arquivo barrado (sha256 exato, com índice). */
const CROSS_ACCOUNT_ROWS_MAX = 50;
/** Outras contas que vão para revisão de uma vez (proteção contra uma foto muito comum na lista). */
const LINKED_ACCOUNTS_MAX = 10;
/** Jobs lidos por página em cada estado da fila, e teto por estado (a varredura é rara: só na suspensão). */
const QUEUE_PAGE = 500;
const QUEUE_SCAN_MAX = 20_000;
const QUEUE_STATES = ['waiting', 'delayed', 'prioritized', 'paused'] as const;

const EMPTY_OUTCOME = (): StrikeOutcome => ({
  action: 'none',
  points: 0,
  causes: [],
  shadowCauses: [],
  linkedAccounts: [],
});

interface CancelSummary {
  removed: number;
  locked: number;
  failed: number;
}

/**
 * Camada 6 · pontos e suspensão (seção 2 do documento de decisão). Roda a cada bloqueio ou retenção que AGIU nas camadas
 * 2, 3 e 5 (o ImageSafetyService chama applySignal depois de gravar o evento e as checagens):
 *  - forte: suspensão imediata;
 *  - médio: 1 ponto; 3 pontos em 90 dias (eventos não liberados pelo revisor) = suspensão até a revisão;
 *  - repetição: 3 bloqueios de foto parecida (pHash) em 24 h na conta, ou a mesma foto bloqueada em outra conta (as
 *    duas) = suspensão para revisão. Fica na SOMBRA até IMAGE_SAFETY_MODE=enforce (só registra "teria suspendido");
 *  - depois de um bloqueio de foto, limite de novas tentativas com foto (photoRetryAllowed).
 * Suspender = a mesma guarda da exclusão LGPD com retenção (conta inativa, sessões revogadas, posts fora do feed, prazo
 * da galeria tirado: nada é apagado), JWT invalidado na hora (aqui e, com o Redis, nas outras instâncias), jobs da
 * conta fora da fila com estorno, resultados na quarentena esperando o revisor e aviso com o canal de revisão.
 * Com IMAGE_SAFETY_MODE=off nada disto roda.
 */
@Injectable()
export class StrikesService implements StrikesPort {
  private readonly logger = new Logger(StrikesService.name);

  constructor(
    @Inject(IMAGE_SAFETY_CONFIG) private readonly config: ImageSafetyConfig,
    private readonly prisma: PrismaService,
    @Inject(BLOCKLIST) private readonly blocklist: BlocklistPort,
    @Inject(SUSPENSION_EFFECTS) private readonly effects: SuspensionEffects,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  get enabled(): boolean {
    return this.config.imageMode !== 'off';
  }

  /** Repetição por hash só age em enforce (na sombra ela só registra, para calibrar). */
  private get repetitionEnforced(): boolean {
    return this.config.imageMode === 'enforce';
  }

  /* ════════════════════════════════════════════════════════════ sinal */

  async applySignal(
    userId: string | null,
    strength: Strength,
    eventId: string | null,
    ctx: StrikeSignalContext,
  ): Promise<StrikeOutcome> {
    const outcome = EMPTY_OUTCOME();
    if (!this.enabled || !userId) return outcome;
    const now = ctx.now ?? new Date();
    try {
      if (strength === 'STRONG') outcome.causes.push('strong');
      if (strength === 'MEDIUM') {
        outcome.action = 'point';
        outcome.points = await this.mediumPoints(userId, now, eventId);
        if (outcome.points >= SAFETY_STRIKES.mediumStrikesToSuspend) {
          outcome.causes.push('medium_points');
        }
      }

      const photos = usableStrikePhotos(ctx.photos);
      if (photos.length) {
        const repeat = await this.repetition(userId, photos, now);
        const target = this.repetitionEnforced
          ? outcome.causes
          : outcome.shadowCauses;
        if (repeat.sameAccount >= SAFETY_STRIKES.repeatBlocksToSuspend) {
          target.push('repeat_hash');
        }
        if (
          repeat.otherAccounts.length + 1 >=
          SAFETY_STRIKES.crossAccountMatchesToReview
        ) {
          target.push('cross_account');
          outcome.linkedAccounts = repeat.otherAccounts;
        }
      }

      const details = {
        layer: ctx.layer,
        match: ctx.match,
        eventId,
        generationId: ctx.generationId,
        points: outcome.points,
        linkedAccounts: outcome.linkedAccounts,
      };
      if (outcome.causes.length) {
        outcome.action = 'suspended';
        await this.suspend(userId, suspensionReasonOf(outcome.causes, details));
        if (outcome.causes.includes('cross_account')) {
          for (const other of outcome.linkedAccounts) {
            await this.suspend(
              other,
              suspensionReasonOf(['cross_account'], {
                ...details,
                points: 0,
                linkedAccounts: [userId],
              }),
            );
          }
        }
      }
      if (outcome.shadowCauses.length) {
        await this.recordShadow(
          userId,
          suspensionReasonOf(outcome.shadowCauses, details),
        );
        this.logger.warn(
          `[STRIKES] conta ${userId}: teria sido suspensa (${outcome.shadowCauses.join(', ')}) — repetição ainda na sombra`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[STRIKES] conta ${userId}: sinal ${strength} (${ctx.layer}:${ctx.match}) não aplicado (${(error as Error).message?.slice(0, 200)}) — conferir a conta no admin`,
      );
    }
    return outcome;
  }

  /**
   * Pontos médios da conta nos últimos 90 dias, por tentativa, sem os eventos liberados pelo revisor (falso positivo
   * não pesa). A força vem do `match` do evento ("regra/MEDIUM"), gravado pelo próprio porteiro.
   */
  async mediumPoints(
    userId: string,
    now: Date,
    eventId: string | null,
  ): Promise<number> {
    const events = await this.prisma.contentSafetyEvent.findMany({
      where: {
        userId,
        kind: { in: [...STRIKE_EVENT_KINDS] },
        releasedAt: null,
        createdAt: { gte: new Date(now.getTime() - MEDIUM_STRIKE_WINDOW_MS) },
        match: { endsWith: '/MEDIUM' },
      },
      select: { id: true, generationId: true },
      orderBy: { createdAt: 'desc' },
      take: POINT_ROWS_MAX,
    });
    return countMediumPoints(events, eventId === null);
  }

  /**
   * Repetição: quantas tentativas com foto parecida esta conta teve barradas em 24 h (lista de bloqueio, pHash) e quais
   * OUTRAS contas têm a mesma foto barrada: a dona da linha da lista que esta foto acertou, ou outra conta com o mesmo
   * arquivo (sha256 exato) barrado ou segurado nos últimos 90 dias.
   */
  private async repetition(
    userId: string,
    photos: readonly StrikePhoto[],
    now: Date,
  ): Promise<{ sameAccount: number; otherAccounts: string[] }> {
    let sameAccount = 0;
    for (const phash of uniqueStrings(photos.map((photo) => photo.phash))) {
      const count = await this.blocklist.countRecent(
        userId,
        phash,
        SAFETY_STRIKES.repeatWindowHours,
        this.config.thresholds.phashMaxDistance,
      );
      sameAccount = Math.max(sameAccount, count);
    }

    const others = new Set<string>();
    const blockIds = uniqueStrings(photos.map((photo) => photo.blockId));
    if (blockIds.length) {
      const blocks = await this.prisma.contentHashBlock.findMany({
        where: { id: { in: blockIds } },
        select: { eventId: true },
      });
      const eventIds = uniqueStrings(blocks.map((block) => block.eventId));
      if (eventIds.length) {
        const events = await this.prisma.contentSafetyEvent.findMany({
          where: { id: { in: eventIds } },
          select: { userId: true },
        });
        for (const event of events) {
          if (event.userId && event.userId !== userId) others.add(event.userId);
        }
      }
    }
    const shas = uniqueStrings(photos.map((photo) => photo.sha256));
    if (shas.length) {
      const rows = await this.prisma.contentSafetyScan.findMany({
        where: {
          sha256: { in: shas },
          userId: { not: userId },
          stage: { in: ['INPUT', 'INPUT_FRAME'] },
          verdict: { in: ['HOLD', 'BLOCK'] },
          enforced: true,
          createdAt: { gte: new Date(now.getTime() - MEDIUM_STRIKE_WINDOW_MS) },
        },
        select: { userId: true },
        take: CROSS_ACCOUNT_ROWS_MAX,
      });
      for (const row of rows) {
        if (row.userId && row.userId !== userId) others.add(row.userId);
      }
    }
    return {
      sameAccount,
      otherAccounts: [...others].slice(0, LINKED_ACCOUNTS_MAX),
    };
  }

  /* ════════════════════════════════════════════════════════════ conta */

  async isSuspended(userId: string | null): Promise<boolean> {
    if (!this.enabled || !userId) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    return user?.isActive === false;
  }

  async photoRetryAllowed(
    userId: string | null,
    options: { currentGenerationId: string | null; now?: Date },
  ): Promise<boolean> {
    if (!this.enabled || !userId) return true;
    const now = options.now ?? new Date();
    const rows = await this.prisma.contentSafetyScan.findMany({
      where: {
        userId,
        stage: { in: ['INPUT', 'INPUT_FRAME'] },
        createdAt: {
          gte: new Date(now.getTime() - PHOTO_RETRY_LONG_WINDOW_MS),
        },
      },
      select: {
        generationId: true,
        createdAt: true,
        verdict: true,
        enforced: true,
      },
      orderBy: { createdAt: 'desc' },
      take: RETRY_ROWS_MAX,
    });
    // mesma régua do photoRetryDecision: só a geração atual (nova tentativa da fila) fica de fora
    const recentBlock = rows.some(
      (row) =>
        row.enforced &&
        (row.verdict === 'BLOCK' || row.verdict === 'HOLD') &&
        (options.currentGenerationId === null ||
          row.generationId !== options.currentGenerationId),
    );
    // bloqueio de foto mais velho que 24 h ainda sem revisão também segura o limite (até a revisão, 90 dias no máximo)
    const openPhotoEvent =
      !recentBlock &&
      (await this.prisma.contentSafetyEvent.count({
        where: {
          userId,
          kind: {
            in: [
              ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
              ContentSafetyEventKind.INPUT_HELD,
            ],
          },
          route: { startsWith: 'input:' },
          releasedAt: null,
          createdAt: {
            gte: new Date(now.getTime() - MEDIUM_STRIKE_WINDOW_MS),
          },
        },
      })) > 0;
    const decision = photoRetryDecision(rows, {
      now,
      currentGenerationId: options.currentGenerationId,
      openPhotoEvent,
    });
    if (!decision.allowed) {
      this.logger.warn(
        `[STRIKES] conta ${userId}: nova tentativa com foto recusada (${decision.attemptsLast10Min} em 10 min, ${decision.attemptsCounted} desde o bloqueio)`,
      );
    }
    return decision.allowed;
  }

  /**
   * Suspende a conta (forte, pontos, repetição). Numa transação, a mesma guarda da exclusão LGPD com retenção: conta
   * inativa, sessões revogadas, posts fora do feed (a linha fica), prazo da galeria tirado (o cron não apaga
   * evidência); nada é anonimizado nem apagado. Depois do commit: JWT invalidado, jobs fora da fila com estorno,
   * resultados na quarentena esperando o revisor e o aviso (só na 1ª suspensão). Devolve true quando a conta estava
   * ativa. Lança só se a transação falhar.
   */
  async suspend(userId: string, reason: string): Promise<boolean> {
    const changed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: userId, isActive: true },
        data: { isActive: false },
      });
      await tx.refreshToken.updateMany({
        where: { userId, revoked: false },
        data: { revoked: true },
      });
      await tx.communityPost.updateMany({
        where: {
          userId,
          status: {
            in: [CommunityPostStatus.APPROVED, CommunityPostStatus.PENDING],
          },
        },
        data: {
          status: CommunityPostStatus.REJECTED,
          rejectionReason: SAFETY_SUSPENSION_POST_REJECTION_REASON,
        },
      });
      await tx.generation.updateMany({
        where: { userId, expiresAt: { not: null } },
        data: { expiresAt: null },
      });
      if (count > 0) {
        await tx.contentSafetyAccessLog.create({
          data: {
            actorId: STRIKES_ACTOR_ID,
            action: STRIKE_ACCESS_ACTIONS.suspend,
            targetType: 'user',
            targetId: userId,
            reason,
          },
        });
      }
      return count > 0;
    });
    // a sessão aberta cai já na próxima requisição (aqui e, com o aviso pelo Redis, nas outras instâncias)
    invalidateActiveUser(userId);
    if (changed) {
      this.logger.warn(`[STRIKES] conta ${userId} suspensa: ${reason}`);
    }
    await this.stopOpenWork(userId);
    if (changed) await this.notify(userId);
    return changed;
  }

  /** Jobs da conta fora da fila (com estorno) e resultados que esperam checagem passando a esperar o revisor. */
  private async stopOpenWork(userId: string): Promise<void> {
    try {
      const cancelled = await this.cancelQueuedJobs(userId);
      if (cancelled.removed || cancelled.locked || cancelled.failed) {
        this.logger.warn(
          `[STRIKES] conta ${userId}: ${cancelled.removed} job(s) tirado(s) da fila, ${cancelled.locked} já rodando (param no próximo passo), ${cancelled.failed} sem encerramento (conferir)`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[STRIKES] conta ${userId}: fila não varrida (${(error as Error).message?.slice(0, 200)}) — os jobs param no preflight`,
      );
    }
    try {
      const held = await this.effects.holdUncheckedOutputs(userId);
      if (held) {
        this.logger.warn(
          `[STRIKES] conta ${userId}: ${held} resultado(s) na quarentena passam a esperar o revisor`,
        );
      }
    } catch (error) {
      this.logger.error(
        `[STRIKES] conta ${userId}: resultados na quarentena não seguros para revisão (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  /**
   * Tira da fila os jobs da conta que ainda esperam (normal e ilimitado) e encerra cada geração com estorno. Job já
   * rodando não sai (o BullMQ recusa: está travado pelo worker); ele para no próximo passo pelo sinal da conta suspensa
   * (preflight e checagem da saída).
   */
  private async cancelQueuedJobs(userId: string): Promise<CancelSummary> {
    const summary: CancelSummary = { removed: 0, locked: 0, failed: 0 };
    const error = new AccountSuspendedSafetyError();
    for (const ref of this.effects.queues()) {
      const jobs = await this.jobsOf(ref, userId);
      for (const job of jobs) {
        try {
          await job.remove();
        } catch {
          summary.locked++;
          continue;
        }
        summary.removed++;
        const generationId = jobGenerationIdOf(job.data);
        if (generationId) {
          try {
            await this.effects.failGeneration(generationId, error);
          } catch (failError) {
            summary.failed++;
            this.logger.error(
              `[STRIKES] gen=${generationId}: job tirado da fila sem encerramento (${(failError as Error).message?.slice(0, 200)}) — o cron de presas encerra`,
            );
          }
        }
        if (ref.unlimited) {
          await this.effects
            .releaseUnlimitedLock(userId)
            .catch((lockError: unknown) =>
              this.logger.warn(
                `[STRIKES] conta ${userId}: lock do ilimitado não solto (${(lockError as Error).message?.slice(0, 200)})`,
              ),
            );
        }
      }
    }
    return summary;
  }

  /** Jobs da conta nos estados de espera de uma fila (lidos antes de remover: os índices não andam no meio). */
  private async jobsOf(
    ref: GenerationQueueRef,
    userId: string,
  ): Promise<JobLike[]> {
    const found: JobLike[] = [];
    for (const state of QUEUE_STATES) {
      for (let start = 0; start < QUEUE_SCAN_MAX; start += QUEUE_PAGE) {
        const page = await ref.queue.getJobs(
          [state],
          start,
          start + QUEUE_PAGE - 1,
          true,
        );
        for (const job of page) {
          if (job && jobUserIdOf(job.data) === userId) found.push(job);
        }
        if (page.length < QUEUE_PAGE) break;
      }
    }
    return found;
  }

  /** "Teria suspendido" (repetição na sombra): só a trilha, para o relatório da sombra contar. Nunca lança. */
  private async recordShadow(userId: string, reason: string): Promise<void> {
    try {
      await this.prisma.contentSafetyAccessLog.create({
        data: {
          actorId: STRIKES_ACTOR_ID,
          action: STRIKE_ACCESS_ACTIONS.suspendShadow,
          targetType: 'user',
          targetId: userId,
          reason,
        },
      });
    } catch (error) {
      this.logger.warn(
        `[STRIKES] conta ${userId}: registro da sombra não gravado (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  /**
   * Aviso de suspensão com motivo genérico e canal de revisão (LGPD, art. 20). O resultado vai SEMPRE para a trilha
   * (suspend_notice: prova do envio ou da falha, para o suporte avisar por outro canal). Nunca lança; nem o log nem a
   * trilha levam o e-mail.
   */
  private async notify(userId: string): Promise<void> {
    let result: SuspendNoticeResult;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true, locale: true },
      });
      if (!user?.email) {
        result = 'skipped:no_email';
      } else {
        const notice = buildSuspensionNotice({
          name: user.name,
          locale: user.locale,
          reviewContact: this.env('SAFETY_REVIEW_CONTACT'),
          siteUrl: this.env('FRONTEND_URL'),
        });
        const sent = await this.effects.sendNotice({
          to: user.email,
          subject: notice.subject,
          html: notice.html,
        });
        result = sent ? 'sent' : 'failed:not_sent';
        if (!sent) {
          this.logger.warn(
            `[STRIKES] conta ${userId}: aviso de suspensão não enviado (e-mail desligado ou recusado) — avisar pelo suporte`,
          );
        }
      }
    } catch (error) {
      result = 'failed:error';
      this.logger.warn(
        `[STRIKES] conta ${userId}: aviso de suspensão falhou (${(error as Error).message?.slice(0, 200)}) — avisar pelo suporte`,
      );
    }
    await this.recordNotice(userId, result);
  }

  /** Resultado do aviso na trilha (só o código). Nunca lança: a suspensão já valeu. */
  private async recordNotice(
    userId: string,
    result: SuspendNoticeResult,
  ): Promise<void> {
    try {
      await this.prisma.contentSafetyAccessLog.create({
        data: {
          actorId: STRIKES_ACTOR_ID,
          action: STRIKE_ACCESS_ACTIONS.suspendNotice,
          targetType: 'user',
          targetId: userId,
          reason: result,
        },
      });
    } catch (error) {
      this.logger.error(
        `[STRIKES] conta ${userId}: resultado do aviso de suspensão (${result}) não gravado na trilha (${(error as Error).message?.slice(0, 200)})`,
      );
    }
  }

  private env(key: string): string | null {
    const value = this.configService?.get<unknown>(key);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
