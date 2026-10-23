import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ContentSafetyEventKind,
  GenerationStatus,
  Prisma,
  type ContentSafetyScanStage,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  StorageReadError,
  UploadsService,
  contentTypeOfKey,
  type StoredMediaLocation,
} from '../../uploads/uploads.service';
import {
  InputImageSafetyBlockError,
  OutputImageSafetyBlockError,
  TextSafetyBlockError,
  type PlatformSafetyBlockError,
} from '../../generations/errors/content-safety.error';
import { ContentSafetyService } from '../content-safety.service';
import {
  IMAGE_SAFETY_CONFIG,
  RULES_VERSION,
  SAFETY_TIMING,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import {
  ImageSafetyService,
  type HoldState,
} from '../image-safety/image-safety.service';
import {
  holdReasonOf,
  isInputStage,
  isOutputStage,
  type HoldReason,
} from '../image-safety/image-safety.scans';
import { BLOCKLIST } from '../image-safety/image-safety.tokens';
import type { BlocklistPort, StorageArea } from '../image-safety/types';
import { reviewConfirmedRoute } from '../safety-event-kinds';
import {
  STRIKE_ACCESS_ACTIONS,
  STRIKES,
  hasOpenSafetySuspension,
  type StrikePhoto,
  type StrikesPort,
} from '../strikes/strikes.types';
import {
  TakedownService,
  type PurgeStatus,
  type ReviewRemovalFile,
} from '../takedown/takedown.service';
import { invalidateActiveUser } from '../../auth/strategies/jwt.strategy';
import {
  HeldGenerationDispatcher,
  type HeldGenerationRow,
  type ReviewFinisher,
} from './held-generation.dispatcher';
import {
  REVIEW_CONFIRMED_RULE,
  REVIEW_REASON_MAX_LENGTH,
  REVIEW_REASON_MIN_LENGTH,
  formatReportReason,
  hasStoredMedia,
  matchesPromotedKey,
  parseDateBound,
  parseReportReason,
  percentile,
  utcDayKey,
  utcDayStart,
  type ReportChannel,
  type ReviewAccessAction,
  type ReviewDecision,
} from './review.helpers';

/** Quem está revisando (do token) e de onde (para o registro de acesso). */
export interface ReviewActor {
  id: string;
  email?: string | null;
  ip: string | null;
}

export interface ScanListQuery {
  page: number;
  limit: number;
  verdict?: string;
  stage?: string;
  rule?: string;
  from?: string;
  to?: string;
  generationId?: string;
  userId?: string;
  inReview?: boolean;
}

export interface AccessLogQuery {
  page: number;
  limit: number;
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

export interface DecisionInput {
  action: ReviewDecision;
  reason: string;
  channel?: ReportChannel;
  protocol?: string;
}

const SCAN_SELECT = {
  id: true,
  generationId: true,
  userId: true,
  stage: true,
  mediaKey: true,
  sha256: true,
  phash: true,
  scores: true,
  verdict: true,
  ruleId: true,
  strength: true,
  rulesVersion: true,
  mode: true,
  enforced: true,
  scanner: true,
  region: true,
  latencyMs: true,
  evidenceKey: true,
  createdAt: true,
} satisfies Prisma.ContentSafetyScanSelect;

type ScanRow = Prisma.ContentSafetyScanGetPayload<{ select: typeof SCAN_SELECT }>;

const HELD_GENERATION_SELECT = {
  id: true,
  userId: true,
  type: true,
  modelUsed: true,
  prompt: true,
  resolution: true,
  aspectRatio: true,
  creditsConsumed: true,
  usedFreeGeneration: true,
  parameters: true,
} satisfies Prisma.GenerationSelect;

const DECISION_ACTIONS: ReviewAccessAction[] = ['release', 'confirm', 'report'];
const ACCESS_LOG_TARGET_SCAN = 'scan';
/** Gerações IN_REVIEW lidas para o filtro `inReview` e para a fila das métricas. */
const IN_REVIEW_MAX = 2_000;
/** Linhas de bloqueio/retenção lidas nas métricas (a janela é de até 30 dias). */
const METRICS_ROW_CAP = 50_000;
/** Amostra de latência: as checagens mais recentes da janela. */
const LATENCY_SAMPLE_MAX = 20_000;
/** Janela do "porteiro cego" nas métricas. */
const RECENT_WINDOW_MINUTES = 15;
const HOUR_MS = 3_600_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Hora do hold do resultado (parameters.safetyHold.heldAt) e se há resultado guardado. */
function heldOutputOf(
  parameters: Prisma.JsonValue,
): { heldAt: Date | null } | null {
  const hold = asRecord(asRecord(parameters).safetyHold);
  if (hold.stage !== 'output') return null;
  const heldAt =
    typeof hold.heldAt === 'string' ? new Date(hold.heldAt) : null;
  return {
    heldAt: heldAt && Number.isFinite(heldAt.getTime()) ? heldAt : null,
  };
}

function layerOf(stage: ContentSafetyScanStage): 'input' | 'output' | 'text' {
  if (stage === 'TEXT') return 'text';
  return isInputStage(stage) ? 'input' : 'output';
}

function errorText(error: unknown): string {
  return ((error as Error)?.message ?? String(error)).slice(0, 200);
}

/**
 * Fluxo do revisor de segurança (camada 7; passos 12 e 23): fila de checagens sem URL de mídia, mídia só por URL
 * assinada de 120 s e sempre com motivo, decisões liberar/confirmar/comunicar, registro de acesso no servidor (só
 * acréscimo) e métricas. Quem chega aqui já passou pelo SafetyReviewerGuard (ADMIN + SAFETY_REVIEWER_IDS).
 *
 * Princípios: toda ação é gravada em content_safety_access_log ANTES de agir (sem registro, nada acontece); nada de
 * evidência é apagado (confirmar só move para a evidência); a cliente nunca recebe o motivo exato (o encerramento usa
 * o código público genérico da checagem).
 */
@Injectable()
export class SafetyReviewService {
  private readonly logger = new Logger(SafetyReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly imageSafety: ImageSafetyService,
    private readonly contentSafety: ContentSafetyService,
    @Inject(BLOCKLIST) private readonly blocklist: BlocklistPort,
    @Inject(IMAGE_SAFETY_CONFIG) private readonly config: ImageSafetyConfig,
    private readonly dispatcher: HeldGenerationDispatcher,
    /** pontos e suspensão (camada 6); ausente = só o evento e a lista de bloqueio */
    @Optional()
    @Inject(STRIKES)
    private readonly strikes: StrikesPort | null = null,
    /** remoção (camada 8): grava o arquivo tirado do público e purga o CDN; ausente = a resposta avisa a purga pendente */
    @Optional()
    private readonly takedown: TakedownService | null = null,
  ) {}

  /* ════════════════════════════════════════════════════════════ fila */

  /** Checagens com filtro, paginadas. Nunca devolve URL nem chave de mídia; só se há mídia guardada e se é evidência. */
  async listScans(query: ScanListQuery) {
    const from = parseDateBound(query.from, false);
    const to = parseDateBound(query.to, true);
    if (from === null || to === null) {
      throw new BadRequestException(
        'from/to inválido (use AAAA-MM-DD ou data ISO)',
      );
    }
    const page = Math.max(1, Math.floor(query.page || 1));
    const limit = Math.min(Math.max(Math.floor(query.limit || 50), 1), 200);
    const where: Prisma.ContentSafetyScanWhereInput = {
      ...(query.verdict
        ? { verdict: query.verdict as Prisma.ContentSafetyScanWhereInput['verdict'] }
        : {}),
      ...(query.stage
        ? { stage: query.stage as Prisma.ContentSafetyScanWhereInput['stage'] }
        : {}),
      ...(query.rule ? { ruleId: query.rule } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.generationId ? { generationId: query.generationId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lt: to } : {}),
            },
          }
        : {}),
    };
    if (query.inReview) {
      const held = await this.prisma.generation.findMany({
        where: {
          status: GenerationStatus.IN_REVIEW,
          ...(query.generationId ? { id: query.generationId } : {}),
        },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: IN_REVIEW_MAX,
      });
      where.generationId = { in: held.map((generation) => generation.id) };
    }

    const [rows, total] = await Promise.all([
      this.prisma.contentSafetyScan.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: SCAN_SELECT,
      }),
      this.prisma.contentSafetyScan.count({ where }),
    ]);

    const generationIds = [
      ...new Set(
        rows
          .map((row) => row.generationId)
          .filter((id): id is string => !!id),
      ),
    ];
    const generations = generationIds.length
      ? await this.prisma.generation.findMany({
          where: { id: { in: generationIds } },
          select: {
            id: true,
            status: true,
            type: true,
            modelUsed: true,
            safetyCheckedAt: true,
            updatedAt: true,
            parameters: true,
          },
        })
      : [];
    const heldIds = generations
      .filter((generation) => generation.status === GenerationStatus.IN_REVIEW)
      .map((generation) => generation.id);
    const heldScans = heldIds.length
      ? await this.prisma.contentSafetyScan.findMany({
          where: { generationId: { in: heldIds } },
          select: {
            generationId: true,
            stage: true,
            verdict: true,
            mediaKey: true,
            sha256: true,
            createdAt: true,
            enforced: true,
          },
        })
      : [];
    const generationById = new Map(
      generations.map((generation) => {
        let holdReason: HoldReason | null = null;
        let heldAt: Date | null = null;
        if (generation.status === GenerationStatus.IN_REVIEW) {
          const output = heldOutputOf(generation.parameters);
          holdReason = holdReasonOf(
            heldScans.filter((scan) => scan.generationId === generation.id),
            output !== null,
          );
          heldAt =
            output?.heldAt ?? generation.safetyCheckedAt ?? generation.updatedAt;
        }
        return [
          generation.id,
          {
            status: generation.status,
            type: generation.type,
            modelUsed: generation.modelUsed,
            holdReason,
            heldAt,
          },
        ] as const;
      }),
    );

    const logs = rows.length
      ? await this.prisma.contentSafetyAccessLog.findMany({
          where: {
            targetType: ACCESS_LOG_TARGET_SCAN,
            targetId: { in: rows.map((row) => row.id) },
            action: { in: DECISION_ACTIONS },
          },
          orderBy: { createdAt: 'asc' },
          select: {
            targetId: true,
            action: true,
            actorId: true,
            reason: true,
            createdAt: true,
          },
        })
      : [];

    const data = rows.map((row) => {
      const own = logs.filter((log) => log.targetId === row.id);
      const last = own[own.length - 1];
      return {
        id: row.id,
        generationId: row.generationId,
        userId: row.userId,
        stage: row.stage,
        verdict: row.verdict,
        ruleId: row.ruleId,
        strength: row.strength,
        mode: row.mode,
        enforced: row.enforced,
        scanner: row.scanner,
        region: row.region,
        latencyMs: row.latencyMs,
        rulesVersion: row.rulesVersion,
        createdAt: row.createdAt,
        scores: row.scores,
        media: {
          stored: hasStoredMedia(row.mediaKey) || !!row.evidenceKey,
          inEvidence: !!row.evidenceKey,
        },
        generation: row.generationId
          ? (generationById.get(row.generationId) ?? null)
          : null,
        review: {
          confirmed: own.some((log) => log.action === 'confirm'),
          lastDecision: last
            ? { action: last.action, actorId: last.actorId, at: last.createdAt }
            : null,
          reports: own
            .filter((log) => log.action === 'report')
            .map((log) => ({
              ...(parseReportReason(log.reason) ?? {
                channel: null,
                protocol: null,
              }),
              actorId: log.actorId,
              at: log.createdAt,
            })),
        },
      };
    });
    return { data, total, page, limit };
  }

  /* ════════════════════════════════════════════════════════════ mídia */

  /**
   * URL assinada de 120 s da mídia da checagem, na área certa (evidência, quarentena, entrada privada; o publicado só
   * quando é o que existe). O acesso é gravado ANTES de assinar: sem registro, sem URL.
   */
  async mediaUrl(scanId: string, reason: string, actor: ReviewActor) {
    const text = this.requireReason(reason);
    const scan = await this.findScan(scanId);
    await this.writeAccessLog('view_media', scan.id, text, actor);
    const location = await this.locateScanMedia(scan);
    if (!location) {
      throw new NotFoundException(
        'Esta checagem não tem mídia guardada (caso leve, texto ou mídia já removida).',
      );
    }
    const ttl = SAFETY_TIMING.reviewMediaUrlTtlSeconds;
    let url: string;
    try {
      url = await this.uploads.signedReviewMediaUrl(
        location.area,
        location.key,
        ttl,
      );
    } catch (error) {
      this.logger.error(
        `[SAFETY_REVIEW] scan=${scan.id}: URL assinada não gerada (${errorText(error)})`,
      );
      throw new ServiceUnavailableException(
        'Armazenamento da revisão indisponível agora.',
      );
    }
    return {
      url,
      expiresInSeconds: ttl,
      expiresAt: new Date(Date.now() + ttl * 1000),
      area: location.area,
      contentType: contentTypeOfKey(location.key),
      stage: scan.stage,
    };
  }

  /* ════════════════════════════════════════════════════════════ decisões */

  async decide(scanId: string, input: DecisionInput, actor: ReviewActor) {
    const reason = this.requireReason(input.reason);
    const scan = await this.findScan(scanId);
    switch (input.action) {
      case 'release':
        return this.release(scan, reason, actor);
      case 'confirm':
        return this.confirm(scan, reason, actor);
      case 'report':
        return this.report(scan, input, reason, actor);
      default:
        throw new BadRequestException('action inválida');
    }
  }

  /**
   * Falso positivo de uma geração SEGURADA: entrada (E3a) volta a rodar com o hold liberado; resultado sai da
   * quarentena, é publicado e a geração conclui pelo mesmo caminho do cron (completeHeldGeneration). Bloqueio já
   * encerrado não é "liberado" aqui (sai pelo jurídico, em events/:id/release).
   */
  private async release(scan: ScanRow, reason: string, actor: ReviewActor) {
    const notHeld = new ConflictException({
      code: 'SAFETY_REVIEW_NOT_HELD',
      message:
        'Só uma geração em revisão (segurada) pode ser liberada aqui. Bloqueio já encerrado é liberado pelo jurídico.',
    });
    if (!scan.generationId) throw notHeld;
    const state = await this.imageSafety.holdStateOf(scan.generationId);
    if (!state) throw notHeld;
    const finisher = this.requireFinisher();
    if (state.reason === 'input_review') {
      return this.releaseHeldInput(
        scan,
        scan.generationId,
        state,
        reason,
        actor,
      );
    }
    return this.releaseHeldOutput(
      scan,
      scan.generationId,
      state,
      reason,
      actor,
      finisher,
    );
  }

  private async releaseHeldInput(
    scan: ScanRow,
    generationId: string,
    state: HoldState,
    reason: string,
    actor: ReviewActor,
  ) {
    const generation = (await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: HELD_GENERATION_SELECT,
    })) as HeldGenerationRow | null;
    if (!generation) throw new NotFoundException('Geração não encontrada');
    const plan = await this.dispatcher.planRequeue(generation, state.heldAt);
    if (!plan) {
      throw new ConflictException({
        code: 'SAFETY_REVIEW_REQUEUE_UNAVAILABLE',
        message:
          'O pedido original não está mais na fila para rodar de novo. A geração segue em revisão: confirme ou deixe vencer (estorno automático).',
      });
    }
    await this.writeAccessLog('release', scan.id, reason, actor);
    // trava: só uma decisão vence (o cron da quarentena e outro revisor também trocam IN_REVIEW)
    const { count } = await this.prisma.generation.updateMany({
      where: { id: generationId, status: GenerationStatus.IN_REVIEW },
      data: { status: GenerationStatus.PROCESSING, safetyCheckedAt: new Date() },
    });
    if (count === 0) throw this.alreadyDecided();
    const backToReview = () =>
      this.prisma.generation
        .updateMany({
          where: { id: generationId, status: GenerationStatus.PROCESSING },
          data: {
            status: GenerationStatus.IN_REVIEW,
            safetyCheckedAt: state.heldAt,
          },
        })
        .catch((error: unknown) =>
          this.logger.error(
            `[SAFETY_REVIEW] gen=${generationId}: não voltou para a revisão (${errorText(error)}) — o cron de presas encerra com estorno`,
          ),
        );
    try {
      // o preflight da nova rodada só segue com o INPUT_HELD liberado (senão segura de novo)
      await this.releaseHeldEvents(
        generationId,
        generation.userId,
        ContentSafetyEventKind.INPUT_HELD,
        reason,
        actor,
        true,
      );
      await this.dispatcher.dispatch(plan);
    } catch (error) {
      await backToReview();
      this.logger.error(
        `[SAFETY_REVIEW] gen=${generationId}: liberação da entrada não reenfileirou (${errorText(error)}) — segue em revisão`,
      );
      throw new ServiceUnavailableException(
        'Não deu para pôr a geração de volta na fila agora; ela continua em revisão. Tente de novo.',
      );
    }
    this.logger.warn(
      `[SAFETY_REVIEW] gen=${generationId}: entrada segurada liberada por ${actor.email || actor.id} (${plan.kind === 'queue' ? 'fila' : 'execução direta'})`,
    );
    return {
      action: 'release' as const,
      generationId,
      outcome: 'requeued' as const,
      via: plan.kind,
    };
  }

  private async releaseHeldOutput(
    scan: ScanRow,
    generationId: string,
    state: HoldState,
    reason: string,
    actor: ReviewActor,
    finisher: ReviewFinisher,
  ) {
    const hold = state.hold;
    if (!hold || hold.outputs.length === 0) {
      throw new ConflictException({
        code: 'SAFETY_REVIEW_NOTHING_HELD',
        message:
          'Não há resultado guardado para publicar nesta geração (o prazo encerra com estorno).',
      });
    }
    if (
      hold.outputs.some(
        (item) => item.area === 'evidence' || item.area === 'input-private',
      )
    ) {
      throw new ConflictException({
        code: 'SAFETY_REVIEW_IN_EVIDENCE',
        message: 'Este resultado já está na evidência e não pode ser publicado.',
      });
    }
    await this.writeAccessLog('release', scan.id, reason, actor);
    // 1ª fase: cópias públicas sem apagar a quarentena (nada sai pela metade)
    const copies: Array<{ quarantineKey: string; publicKey: string }> = [];
    const urls: string[] = [];
    const undoCopies = async () => {
      for (const copy of copies) {
        try {
          await this.uploads.deleteStoredObject('public', copy.publicKey);
        } catch (error) {
          this.logger.error(
            `[SAFETY_REVIEW] gen=${generationId}: cópia pública ${copy.publicKey} não apagada (${errorText(error)}) — apagar à mão`,
          );
        }
      }
    };
    try {
      for (const item of hold.outputs) {
        if (item.area === 'quarantine') {
          const promoted = await this.uploads.copyQuarantineToPublic(item.key, {
            contentType: item.mimeType,
          });
          copies.push({ quarantineKey: item.key, publicKey: promoted.key });
          urls.push(promoted.url);
        } else {
          urls.push(this.uploads.getPublicUrl(item.key));
        }
      }
    } catch (error) {
      await undoCopies();
      this.logger.error(
        `[SAFETY_REVIEW] gen=${generationId}: promoção falhou (${errorText(error)}) — segue em revisão`,
      );
      throw new ServiceUnavailableException(
        'Não deu para publicar o resultado agora; a geração continua em revisão.',
      );
    }

    let done: boolean;
    try {
      done = await finisher.completeHeldGeneration(generationId, urls, hold);
    } catch (error) {
      this.logger.error(
        `[SAFETY_REVIEW] gen=${generationId}: conclusão depois da liberação falhou (${errorText(error)}) — conferir no admin`,
      );
      throw new InternalServerErrorException(
        'A conclusão da geração falhou depois da liberação; confira a geração.',
      );
    }
    if (!done) {
      await undoCopies();
      throw this.alreadyDecided();
    }
    // 2ª fase: só agora a quarentena sai
    for (const copy of copies) {
      await this.uploads.deleteQuarantineObject(copy.quarantineKey);
    }
    let eventsReleased = true;
    try {
      await this.releaseHeldEvents(
        generationId,
        null,
        ContentSafetyEventKind.OUTPUT_HELD,
        reason,
        actor,
        false,
      );
    } catch (error) {
      eventsReleased = false;
      this.logger.error(
        `[SAFETY_REVIEW] gen=${generationId}: OUTPUT_HELD não liberado (${errorText(error)}) — liberar em events/:id/release`,
      );
    }
    this.logger.warn(
      `[SAFETY_REVIEW] gen=${generationId}: resultado segurado liberado por ${actor.email || actor.id} (${urls.length} arquivo(s))`,
    );
    return {
      action: 'release' as const,
      generationId,
      outcome: 'published' as const,
      outputs: urls.length,
      eventsReleased,
    };
  }

  /**
   * Caso confirmado (sinal forte). Geração segurada: a mídia segurada e as entradas vão para a evidência e a geração
   * encerra com estorno (código público genérico). Publicada: o resultado sai do público para a evidência, as entradas
   * também, e a geração some da galeria. Outras: a mídia da checagem (e as entradas, se for entrada) vai para a
   * evidência. Em todos: evento de menor (guarda legal da conta e da geração) e hash na lista de bloqueio.
   * Repetir refaz só o que faltou (cada passo pula o que já está na evidência; o evento não duplica): uma confirmação
   * que caiu no meio termina na nova tentativa.
   */
  private async confirm(scan: ScanRow, reason: string, actor: ReviewActor) {
    const alreadyConfirmed =
      (await this.prisma.contentSafetyAccessLog.count({
        where: {
          action: 'confirm',
          targetType: ACCESS_LOG_TARGET_SCAN,
          targetId: scan.id,
        },
      })) > 0;
    const generation = scan.generationId
      ? await this.prisma.generation.findUnique({
          where: { id: scan.generationId },
          select: { id: true, userId: true, status: true },
        })
      : null;
    const finisher =
      generation?.status === GenerationStatus.IN_REVIEW
        ? this.requireFinisher()
        : null;
    await this.writeAccessLog('confirm', scan.id, reason, actor);

    const layer = layerOf(scan.stage);
    // o evento vem antes das cópias: ele já segura a geração e a conta na guarda legal enquanto a evidência é movida
    const eventId = await this.confirmEvent(scan, layer, generation?.userId);

    let evidencePending = false;
    let mediaMissing = false;
    let generationClosed = false;
    /** a geração estava sendo concluída por outro caminho: repetir a confirmação tira o resultado do ar */
    let retryNeeded = false;
    let takenDown = 0;
    let externalStillPublic = 0;
    let cdnPurge: Record<PurgeStatus, number> | null = null;
    const state =
      generation && finisher
        ? await this.imageSafety.holdStateOf(generation.id)
        : null;
    // trava ANTES de mexer na mídia: só uma decisão vence (a liberação de outro revisor e o cron da quarentena trocam o
    // mesmo IN_REVIEW). Quem não ganhou relê o status: a geração pode ter saído de IN_REVIEW (e o holdStateOf voltado
    // null) durante o registro e o evento, e cai no ramo do status de agora
    const claimed =
      generation && state ? await this.claimHeld(generation.id) : false;
    const status =
      generation && !claimed
        ? await this.currentStatus(generation.id)
        : generation?.status;
    if (generation && finisher && state && claimed) {
      let expired: PlatformSafetyBlockError;
      try {
        expired =
          state.reason === 'input_review'
            ? await this.imageSafety.expireHeldInput(generation.id)
            : await this.imageSafety.expireReviewedOutput(
                generation.id,
                state.hold,
              );
        evidencePending = expired.evidencePending;
        evidencePending =
          (await this.preserveInputs(generation)) || evidencePending;
      } catch (error) {
        // sem a evidência movida, a geração volta para a revisão (repetir a confirmação refaz só o que faltou)
        await this.backToReview(generation.id, state.heldAt);
        this.logger.error(
          `[SAFETY_REVIEW] gen=${generation.id}: confirmação não moveu a mídia segurada (${errorText(error)}) — segue em revisão`,
        );
        throw new ServiceUnavailableException(
          'Não deu para guardar a mídia segurada agora; a geração continua em revisão. Tente de novo.',
        );
      }
      await finisher.failForSafety(
        generation.id,
        this.confirmedError(expired, evidencePending),
        'processing',
      );
      generationClosed = true;
    } else if (generation && status === GenerationStatus.COMPLETED) {
      const takedown = await this.takedownPublished(generation, scan.id, actor);
      takenDown = takedown.moved;
      evidencePending = takedown.pending;
      externalStillPublic = takedown.external;
      cdnPurge = takedown.purge;
      evidencePending =
        (await this.preserveInputs(generation)) || evidencePending;
      if (layer !== 'output') {
        const moved = await this.moveScanMediaToEvidence(scan);
        evidencePending ||= moved.pending;
        mediaMissing = moved.missing;
      }
    } else {
      const moved = await this.moveScanMediaToEvidence(scan);
      evidencePending = moved.pending;
      mediaMissing = moved.missing;
      if (generation && layer === 'input') {
        evidencePending =
          (await this.preserveInputs(generation)) || evidencePending;
      }
      // estava segurada na 1ª leitura e ainda não terminou (outra decisão concluindo, ou voltou à revisão): repetir
      if (
        generation &&
        finisher &&
        !claimed &&
        (status === GenerationStatus.PROCESSING ||
          status === GenerationStatus.IN_REVIEW)
      ) {
        retryNeeded = true;
        this.logger.warn(
          `[SAFETY_REVIEW] gen=${generation.id}: a liberação ou o cron concluía a geração durante a confirmação — repetir a confirmação para tirar o resultado do ar`,
        );
      }
    }
    const photos = await this.blockHashes(scan, eventId);
    const suspended = await this.strongSignal(
      scan.userId ?? generation?.userId ?? null,
      eventId,
      layer,
      scan.generationId,
      layer === 'input' ? photos : [],
    );
    this.logger.warn(
      `[SAFETY_REVIEW] scan=${scan.id} gen=${scan.generationId ?? '-'}: caso confirmado por ${actor.email || actor.id}${evidencePending ? ' — evidência pendente' : ''}`,
    );
    return {
      action: 'confirm' as const,
      scanId: scan.id,
      generationId: scan.generationId,
      alreadyConfirmed,
      generationClosed,
      retryNeeded,
      takenDown,
      evidencePending,
      mediaMissing,
      /** resultado hospedado fora do storage (link do provedor): segue no ar; pedir a remoção a quem hospeda */
      externalStillPublic,
      /** purga do CDN dos arquivos que saíram do público (pending/failed: a varredura de 10 min repete) */
      cdnPurge,
      accountSuspended: suspended,
    };
  }

  /**
   * Sinal forte para a camada 6 (suspensão, fila da conta cancelada, sessão derrubada). O próprio serviço de pontos
   * nunca lança e só age fora do modo off; sem ele, o evento já segura a conta na guarda legal.
   */
  private async strongSignal(
    userId: string | null,
    eventId: string | null,
    layer: 'input' | 'output' | 'text',
    generationId: string | null,
    photos: StrikePhoto[],
  ): Promise<boolean> {
    if (!this.strikes || !userId) return false;
    try {
      const outcome = await this.strikes.applySignal(userId, 'STRONG', eventId, {
        layer,
        match: `${REVIEW_CONFIRMED_RULE}/STRONG`,
        generationId,
        photos,
      });
      return outcome.action === 'suspended';
    } catch (error) {
      this.logger.error(
        `[SAFETY_REVIEW] conta ${userId}: sinal forte da confirmação não aplicado (${errorText(error)})`,
      );
      return false;
    }
  }

  /**
   * Evento de menor da confirmação (OUTPUT_MINOR_BLOCKED, IMAGE_MINOR_BLOCKED ou, no texto, MINOR_BLOCKED). Numa
   * geração, reaproveita o da confirmação anterior (nova tentativa não duplica a trilha).
   */
  private async confirmEvent(
    scan: ScanRow,
    layer: 'input' | 'output' | 'text',
    generationUserId: string | undefined,
  ): Promise<string | null> {
    const kind =
      layer === 'output'
        ? ContentSafetyEventKind.OUTPUT_MINOR_BLOCKED
        : layer === 'input'
          ? ContentSafetyEventKind.IMAGE_MINOR_BLOCKED
          : ContentSafetyEventKind.MINOR_BLOCKED;
    // a guarda legal reconhece a rota (review:<camada>): o caso confirmado segura a conta em qualquer data, sem override
    const route = reviewConfirmedRoute(layer);
    const match = `${REVIEW_CONFIRMED_RULE}/STRONG`;
    if (scan.generationId) {
      const existing = await this.prisma.contentSafetyEvent.findFirst({
        where: { generationId: scan.generationId, kind, route, match },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    return this.contentSafety.record({
      userId: scan.userId ?? generationUserId ?? null,
      kind,
      route,
      match,
      excerpt: null,
      generationId: scan.generationId,
    });
  }

  /** Comunicação feita à autoridade: só depois da confirmação (desta checagem ou de outra da mesma geração). */
  private async report(
    scan: ScanRow,
    input: DecisionInput,
    reason: string,
    actor: ReviewActor,
  ) {
    if (!input.channel) {
      throw new BadRequestException('channel é obrigatório em report');
    }
    const siblings = scan.generationId
      ? (
          await this.prisma.contentSafetyScan.findMany({
            where: { generationId: scan.generationId },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [];
    const confirmed = await this.prisma.contentSafetyAccessLog.count({
      where: {
        action: 'confirm',
        targetType: ACCESS_LOG_TARGET_SCAN,
        targetId: { in: [...new Set([scan.id, ...siblings])] },
      },
    });
    if (confirmed === 0) {
      throw new ConflictException({
        code: 'SAFETY_REVIEW_REPORT_NEEDS_CONFIRM',
        message: 'Confirme o caso antes de registrar a comunicação.',
      });
    }
    const protocol = input.protocol?.trim() || null;
    await this.writeAccessLog(
      'report',
      scan.id,
      formatReportReason(input.channel, protocol, reason),
      actor,
    );
    return {
      action: 'report' as const,
      scanId: scan.id,
      generationId: scan.generationId,
      channel: input.channel,
      protocol,
    };
  }

  /* ════════════════════════════════════════════════════════════ conta suspensa */

  /**
   * Reativa a conta suspensa pela camada 6 (a revisão humana da decisão automática). Só a conta com suspensão aberta na
   * trilha: a desativada à mão pelo admin sai pelo admin (409 aqui). Numa transação, a conta volta e a linha
   * `reactivate` entra na trilha com quem, por quê e o IP (sem a linha, nada muda: 503). Os posts tirados do ar e o
   * prazo da galeria não voltam sozinhos (o admin decide o post; a retenção legal continua valendo).
   */
  async reactivateAccount(userId: string, reason: string, actor: ReviewActor) {
    const text = this.requireReason(reason);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true },
    });
    if (!user) throw new NotFoundException('Conta não encontrada');
    if (!(await hasOpenSafetySuspension(this.prisma, userId))) {
      throw new ConflictException({
        code: 'SAFETY_REVIEW_NOT_SUSPENDED',
        message: user.isActive
          ? 'A conta já está ativa.'
          : 'Esta conta não foi suspensa pela revisão de segurança: a reativação é pelo admin.',
      });
    }
    let reactivated: boolean;
    try {
      reactivated = await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.user.updateMany({
          where: { id: userId, isActive: false },
          data: { isActive: true },
        });
        await tx.contentSafetyAccessLog.create({
          data: {
            actorId: actor.id,
            action: STRIKE_ACCESS_ACTIONS.reactivate,
            targetType: 'user',
            targetId: userId,
            reason: text,
            ip: actor.ip,
          },
        });
        return count > 0;
      });
    } catch (error) {
      this.logger.error(
        `[SAFETY_REVIEW] conta ${userId}: reativação não gravada (${errorText(error)})`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível registrar a reativação; nada foi alterado.',
      );
    }
    // a sessão nova entra já na próxima requisição (aqui e, com o aviso pelo Redis, nas outras instâncias)
    invalidateActiveUser(userId);
    this.logger.warn(
      `[SAFETY_REVIEW] conta ${userId} reativada por ${actor.email || actor.id}`,
    );
    return { userId, reactivated, alreadyActive: !reactivated };
  }

  /* ════════════════════════════════════════════════════════════ registro e métricas */

  async accessLog(query: AccessLogQuery) {
    const from = parseDateBound(query.from, false);
    const to = parseDateBound(query.to, true);
    if (from === null || to === null) {
      throw new BadRequestException(
        'from/to inválido (use AAAA-MM-DD ou data ISO)',
      );
    }
    const page = Math.max(1, Math.floor(query.page || 1));
    const limit = Math.min(Math.max(Math.floor(query.limit || 50), 1), 200);
    const where: Prisma.ContentSafetyAccessLogWhereInput = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lt: to } : {}),
            },
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.contentSafetyAccessLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.contentSafetyAccessLog.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * Métricas da trava (seção 5.6), dias em UTC: bloqueios e retenções por regra e dia (agidos × só sombra), checagens e
   * indisponibilidade por dia, latência p50/p95 por camada, fila de revisão por idade e motivo, decisões do revisor.
   */
  async metrics(days: number) {
    const now = new Date();
    const windowDays = Math.min(Math.max(Math.floor(days || 7), 1), 30);
    const since = utcDayStart(
      new Date(now.getTime() - (windowDays - 1) * 86_400_000),
    );

    // 1. bloqueios e retenções por regra e dia
    const acted = await this.prisma.contentSafetyScan.findMany({
      where: { createdAt: { gte: since }, verdict: { in: ['BLOCK', 'HOLD'] } },
      select: { createdAt: true, ruleId: true, verdict: true, enforced: true },
      orderBy: { createdAt: 'desc' },
      take: METRICS_ROW_CAP,
    });
    const byRule = new Map<
      string,
      { day: string; ruleId: string | null; verdict: string; enforced: number; shadow: number }
    >();
    for (const row of acted) {
      const day = utcDayKey(row.createdAt);
      const key = `${day}|${row.ruleId ?? ''}|${row.verdict}`;
      const entry = byRule.get(key) ?? {
        day,
        ruleId: row.ruleId,
        verdict: row.verdict,
        enforced: 0,
        shadow: 0,
      };
      if (row.enforced) entry.enforced++;
      else entry.shadow++;
      byRule.set(key, entry);
    }

    // 2. checagens e indisponibilidade por dia
    const checksByDay: Array<{
      day: string;
      total: number;
      byVerdict: Record<string, number>;
      unavailable: number;
      unavailableRate: number | null;
    }> = [];
    for (let index = 0; index < windowDays; index++) {
      const start = new Date(since.getTime() + index * 86_400_000);
      const end = new Date(start.getTime() + 86_400_000);
      const groups = await this.prisma.contentSafetyScan.groupBy({
        by: ['verdict'],
        where: { createdAt: { gte: start, lt: end } },
        _count: { _all: true },
      });
      const byVerdict: Record<string, number> = {};
      let total = 0;
      for (const group of groups) {
        byVerdict[group.verdict] = group._count._all;
        total += group._count._all;
      }
      const unavailable = byVerdict.UNAVAILABLE ?? 0;
      checksByDay.push({
        day: utcDayKey(start),
        total,
        byVerdict,
        unavailable,
        unavailableRate: total ? unavailable / total : null,
      });
    }
    const recentGroups = await this.prisma.contentSafetyScan.groupBy({
      by: ['verdict'],
      where: {
        createdAt: {
          gte: new Date(now.getTime() - RECENT_WINDOW_MINUTES * 60_000),
        },
      },
      _count: { _all: true },
    });
    const recentTotal = recentGroups.reduce(
      (sum, group) => sum + group._count._all,
      0,
    );
    const recentUnavailable =
      recentGroups.find((group) => group.verdict === 'UNAVAILABLE')?._count
        ._all ?? 0;

    // 3. latência p50/p95 por camada (as checagens mais recentes da janela)
    const latencyRows = await this.prisma.contentSafetyScan.findMany({
      where: { createdAt: { gte: since }, latencyMs: { not: null } },
      select: { stage: true, latencyMs: true },
      orderBy: { createdAt: 'desc' },
      take: LATENCY_SAMPLE_MAX,
    });
    const samples: Record<'input' | 'output' | 'text', number[]> = {
      input: [],
      output: [],
      text: [],
    };
    for (const row of latencyRows) {
      if (typeof row.latencyMs === 'number')
        samples[layerOf(row.stage)].push(row.latencyMs);
    }
    const latency = Object.fromEntries(
      (Object.keys(samples) as Array<keyof typeof samples>).map((layer) => {
        const sorted = samples[layer].sort((left, right) => left - right);
        return [
          layer,
          {
            count: sorted.length,
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
          },
        ];
      }),
    );

    // 4. fila de revisão: idade e motivo
    const held = await this.prisma.generation.findMany({
      where: { status: GenerationStatus.IN_REVIEW },
      select: {
        id: true,
        safetyCheckedAt: true,
        updatedAt: true,
        parameters: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: IN_REVIEW_MAX,
    });
    const heldScans = held.length
      ? await this.prisma.contentSafetyScan.findMany({
          where: { generationId: { in: held.map((generation) => generation.id) } },
          select: {
            generationId: true,
            stage: true,
            verdict: true,
            mediaKey: true,
            sha256: true,
            createdAt: true,
            enforced: true,
          },
        })
      : [];
    const byAge = { under1h: 0, from1to4h: 0, from4to24h: 0, over24h: 0 };
    const byReason: Record<HoldReason, number> = {
      input_review: 0,
      output_review: 0,
      output_unchecked: 0,
    };
    let overTarget = 0;
    let oldestHeldAt: Date | null = null;
    for (const generation of held) {
      const output = heldOutputOf(generation.parameters);
      const reason = holdReasonOf(
        heldScans.filter((scan) => scan.generationId === generation.id),
        output !== null,
      );
      byReason[reason]++;
      const heldAt =
        output?.heldAt ?? generation.safetyCheckedAt ?? generation.updatedAt;
      const age = now.getTime() - heldAt.getTime();
      if (age < HOUR_MS) byAge.under1h++;
      else if (age < 4 * HOUR_MS) byAge.from1to4h++;
      else if (age < 24 * HOUR_MS) byAge.from4to24h++;
      else byAge.over24h++;
      if (age >= SAFETY_TIMING.outputReviewTargetMs) overTarget++;
      if (!oldestHeldAt || heldAt < oldestHeldAt) oldestHeldAt = heldAt;
    }

    // 5. decisões do revisor na janela
    const decisionGroups = await this.prisma.contentSafetyAccessLog.groupBy({
      by: ['action'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });

    return {
      generatedAt: now,
      timezone: 'UTC',
      windowDays,
      since,
      rulesVersion: RULES_VERSION,
      modes: {
        image: this.config.imageMode,
        text: this.config.textMode,
        enforceStrong: this.config.enforceStrong,
      },
      blocksByRuleDay: [...byRule.values()].sort((left, right) =>
        left.day === right.day
          ? String(left.ruleId).localeCompare(String(right.ruleId))
          : left.day.localeCompare(right.day),
      ),
      blocksTruncated: acted.length >= METRICS_ROW_CAP,
      checksByDay,
      unavailability: {
        windowMinutes: RECENT_WINDOW_MINUTES,
        total: recentTotal,
        unavailable: recentUnavailable,
        rate: recentTotal ? recentUnavailable / recentTotal : null,
      },
      latencyMs: { ...latency, sampled: latencyRows.length },
      reviewQueue: {
        total: held.length,
        truncated: held.length >= IN_REVIEW_MAX,
        byReason,
        byAge,
        overTargetHours: SAFETY_TIMING.outputReviewTargetMs / HOUR_MS,
        overTarget,
        oldestHeldAt,
      },
      decisions: Object.fromEntries(
        decisionGroups.map((group) => [group.action, group._count._all]),
      ),
    };
  }

  /* ════════════════════════════════════════════════════════════ apoio */

  private requireReason(reason: unknown): string {
    const text = typeof reason === 'string' ? reason.trim() : '';
    if (
      text.length < REVIEW_REASON_MIN_LENGTH ||
      text.length > REVIEW_REASON_MAX_LENGTH
    ) {
      throw new BadRequestException(
        `Explique o motivo (de ${REVIEW_REASON_MIN_LENGTH} a ${REVIEW_REASON_MAX_LENGTH} caracteres).`,
      );
    }
    return text;
  }

  private requireFinisher(): ReviewFinisher {
    const finisher = this.dispatcher.finisher();
    if (!finisher) {
      throw new ServiceUnavailableException(
        'Processamento de gerações indisponível agora; nada foi alterado.',
      );
    }
    return finisher;
  }

  /**
   * Trava da confirmação de uma geração segurada: IN_REVIEW → PROCESSING com safetyCheckedAt agora (o cron de presas
   * não encerra no meio). Só quem vence move a mídia e encerra; false = outra decisão chegou antes.
   */
  private async claimHeld(generationId: string): Promise<boolean> {
    const { count } = await this.prisma.generation.updateMany({
      where: { id: generationId, status: GenerationStatus.IN_REVIEW },
      data: { status: GenerationStatus.PROCESSING, safetyCheckedAt: new Date() },
    });
    return count > 0;
  }

  private async currentStatus(
    generationId: string,
  ): Promise<GenerationStatus | undefined> {
    const row = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    return row?.status;
  }

  /** Desfaz a trava da confirmação que não terminou: volta a IN_REVIEW com a hora do hold. Nunca lança. */
  private async backToReview(generationId: string, heldAt: Date): Promise<void> {
    try {
      await this.prisma.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.PROCESSING },
        data: { status: GenerationStatus.IN_REVIEW, safetyCheckedAt: heldAt },
      });
    } catch (error) {
      this.logger.error(
        `[SAFETY_REVIEW] gen=${generationId}: não voltou para a revisão (${errorText(error)}) — o cron de presas encerra com estorno`,
      );
    }
  }

  private alreadyDecided(): ConflictException {
    return new ConflictException({
      code: 'SAFETY_REVIEW_ALREADY_DECIDED',
      message:
        'Esta geração já saiu da revisão (outro revisor ou o prazo decidiu antes).',
    });
  }

  private async findScan(scanId: string): Promise<ScanRow> {
    const scan = await this.prisma.contentSafetyScan.findUnique({
      where: { id: scanId },
      select: SCAN_SELECT,
    });
    if (!scan) throw new NotFoundException('Checagem não encontrada');
    return scan;
  }

  /** Registro de acesso, só acréscimo. Sem registro, a ação não acontece (503). */
  private async writeAccessLog(
    action: ReviewAccessAction,
    targetId: string,
    reason: string,
    actor: ReviewActor,
  ): Promise<void> {
    try {
      await this.prisma.contentSafetyAccessLog.create({
        data: {
          actorId: actor.id,
          action,
          targetType: ACCESS_LOG_TARGET_SCAN,
          targetId,
          reason,
          ip: actor.ip,
        },
      });
    } catch (error) {
      this.logger.error(
        `[SAFETY_REVIEW] registro de acesso (${action}, scan=${targetId}) não gravado: ${errorText(error)}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível registrar o acesso; nada foi feito.',
      );
    }
  }

  /**
   * Libera os eventos de retenção da geração (INPUT_HELD / OUTPUT_HELD): o falso positivo deixa de segurar a conta na
   * guarda legal. `ensure` (entrada): sem evento nenhum (o registro falhou no hold), grava um já liberado, senão a nova
   * rodada do preflight seguraria de novo.
   */
  private async releaseHeldEvents(
    generationId: string,
    userId: string | null,
    kind: ContentSafetyEventKind,
    reason: string,
    actor: ReviewActor,
    ensure: boolean,
  ): Promise<void> {
    const note = `revisão de segurança: ${reason}`.slice(
      0,
      REVIEW_REASON_MAX_LENGTH,
    );
    const releasedAt = new Date();
    const { count } = await this.prisma.contentSafetyEvent.updateMany({
      where: { generationId, kind, releasedAt: null },
      data: { releasedAt, releasedBy: actor.id, releaseNote: note },
    });
    if (count > 0 || !ensure) return;
    const existing = await this.prisma.contentSafetyEvent.count({
      where: { generationId, kind },
    });
    if (existing > 0) return;
    await this.prisma.contentSafetyEvent.create({
      data: {
        userId,
        kind,
        route: 'review:release',
        match: 'REVIEW_RELEASED',
        generationId,
        releasedAt,
        releasedBy: actor.id,
        releaseNote: note,
      },
    });
  }

  /** Erro do encerramento da geração confirmada: mesmo código público de toda regra; regra e força só no log. */
  private confirmedError(
    expired: PlatformSafetyBlockError,
    evidencePending: boolean,
  ): PlatformSafetyBlockError {
    const options = { evidencePending };
    if (expired.stage === 'output') {
      return new OutputImageSafetyBlockError(
        REVIEW_CONFIRMED_RULE,
        'STRONG',
        options,
      );
    }
    if (expired.stage === 'text') {
      return new TextSafetyBlockError(REVIEW_CONFIRMED_RULE, 'STRONG', options);
    }
    return new InputImageSafetyBlockError(
      REVIEW_CONFIRMED_RULE,
      'STRONG',
      options,
    );
  }

  /** Onde está a mídia desta checagem agora (evidência, retenção, entrada, publicado). null = nada guardado. */
  private async locateScanMedia(
    scan: Pick<ScanRow, 'generationId' | 'stage' | 'mediaKey' | 'evidenceKey'>,
  ): Promise<StoredMediaLocation | null> {
    if (scan.evidenceKey) return { area: 'evidence', key: scan.evidenceKey };
    if (!hasStoredMedia(scan.mediaKey)) return null;
    const key = scan.mediaKey as string;
    if (key.startsWith('evidence/')) return { area: 'evidence', key };

    if (isInputStage(scan.stage)) {
      if (scan.generationId) {
        const inputs = await this.prisma.generationInputImage.findMany({
          where: { generationId: scan.generationId },
          select: { url: true },
        });
        for (const input of inputs) {
          const location = this.uploads.locateStoredMedia(input.url);
          if (location?.key === key) return location;
        }
      }
      if (key.startsWith('inputs/')) {
        const area: StorageArea = this.uploads.privateInputsEnabled
          ? 'input-private'
          : 'public';
        return { area, key };
      }
      return null;
    }

    if (isOutputStage(scan.stage)) {
      if (scan.generationId) {
        const state = await this.imageSafety.holdStateOf(scan.generationId);
        const heldItem = state?.hold?.outputs.find((item) => item.key === key);
        if (heldItem) return { area: heldItem.area, key: heldItem.key };
        const outputs = await this.prisma.generationOutput.findMany({
          where: { generationId: scan.generationId },
          select: { url: true },
        });
        for (const output of outputs) {
          const location = this.uploads.locateStoredMedia(output.url);
          if (location && matchesPromotedKey(key, location.key)) return location;
        }
      }
      return this.uploads.quarantineConfigured
        ? { area: 'quarantine', key }
        : null;
    }
    return null;
  }

  /** A mídia da checagem vai para a evidência (se ainda não estiver) e as linhas da mesma mídia ganham a chave. */
  private async moveScanMediaToEvidence(
    scan: ScanRow,
  ): Promise<{ pending: boolean; missing: boolean }> {
    // lida de novo: um passo anterior desta confirmação (entradas, resultado publicado) pode já ter guardado a mídia
    const fresh = await this.prisma.contentSafetyScan.findUnique({
      where: { id: scan.id },
      select: { evidenceKey: true },
    });
    if (fresh?.evidenceKey || scan.evidenceKey) {
      return { pending: false, missing: false };
    }
    const location = await this.locateScanMedia(scan);
    if (!location) {
      return { pending: false, missing: hasStoredMedia(scan.mediaKey) };
    }
    let evidenceKey = location.key;
    if (location.area !== 'evidence') {
      try {
        evidenceKey = await this.uploads.moveToEvidence(
          location.area,
          location.key,
          scan.sha256,
        );
      } catch (error) {
        if (error instanceof StorageReadError && error.reason === 'not_found') {
          return { pending: false, missing: true };
        }
        this.logger.error(
          `[SAFETY_REVIEW] scan=${scan.id}: mídia não foi para a evidência (${errorText(error)})`,
        );
        return { pending: true, missing: false };
      }
    }
    await this.prisma.contentSafetyScan
      .updateMany({
        where:
          scan.generationId && scan.mediaKey
            ? { generationId: scan.generationId, mediaKey: scan.mediaKey }
            : { id: scan.id },
        data: { evidenceKey },
      })
      .catch((error: unknown) =>
        this.logger.error(
          `[SAFETY_REVIEW] scan=${scan.id}: evidência ${evidenceKey} sem ligação com a checagem (${errorText(error)})`,
        ),
      );
    return { pending: false, missing: false };
  }

  /**
   * Entradas da geração vão para a evidência (as que ainda não estão) e ficam ligadas a ela: a checagem da entrada
   * ganha a chave; entrada sem checagem ganha uma linha do revisor. true = alguma não foi (o encerramento mantém as
   * entradas).
   */
  private async preserveInputs(generation: {
    id: string;
    userId: string;
  }): Promise<boolean> {
    let rows: Array<{ url: string | null }>;
    try {
      rows = await this.prisma.generationInputImage.findMany({
        where: { generationId: generation.id },
        select: { url: true },
      });
    } catch (error) {
      this.logger.error(
        `[SAFETY_REVIEW] gen=${generation.id}: entradas não lidas para a evidência (${errorText(error)})`,
      );
      return true;
    }
    let pending = false;
    for (const row of rows) {
      const location = this.uploads.locateStoredMedia(row.url);
      if (!location || location.area === 'evidence') continue;
      const linked = await this.prisma.contentSafetyScan.count({
        where: {
          generationId: generation.id,
          mediaKey: location.key,
          evidenceKey: { not: null },
        },
      });
      if (linked > 0) continue;
      let evidenceKey: string;
      try {
        evidenceKey = await this.uploads.moveToEvidence(
          location.area,
          location.key,
          null,
        );
      } catch (error) {
        if (error instanceof StorageReadError && error.reason === 'not_found')
          continue;
        pending = true;
        this.logger.error(
          `[SAFETY_REVIEW] gen=${generation.id}: entrada ${location.key} não foi para a evidência (${errorText(error)})`,
        );
        continue;
      }
      await this.linkEvidence(generation, 'INPUT', location.key, evidenceKey);
    }
    return pending;
  }

  /**
   * Resultado publicado de um caso confirmado: cada arquivo (e a miniatura, cópia derivada) sai do público para a
   * evidência, ligado à geração, e a geração some da galeria (isDeleted). Nada é apagado. Depois, cada arquivo que saiu
   * vira item da remoção (camada 8) e o CDN é purgado na hora (a cópia em cache servia por até um dia); o que ficar
   * pendente a varredura repete. Resultado hospedado fora do storage não é pulado em silêncio: vira item `external` e
   * a resposta avisa que ele segue no ar.
   */
  private async takedownPublished(
    generation: { id: string; userId: string },
    scanId: string,
    actor: ReviewActor,
  ): Promise<{
    moved: number;
    pending: boolean;
    external: number;
    purge: Record<PurgeStatus, number>;
  }> {
    const outputs = await this.prisma.generationOutput.findMany({
      where: { generationId: generation.id },
      select: { url: true, thumbnailUrl: true },
    });
    const scans = await this.prisma.contentSafetyScan.findMany({
      where: {
        generationId: generation.id,
        stage: { in: ['OUTPUT', 'OUTPUT_FRAME'] },
      },
      select: { id: true, mediaKey: true },
    });
    let moved = 0;
    let pending = false;
    const removed: ReviewRemovalFile[] = [];
    const external = (url: string | null, role: 'output' | 'thumbnail') => {
      if (!url) return;
      removed.push({
        generationId: generation.id,
        role,
        url,
        location: null,
        evidenceKey: null,
      });
    };
    for (const output of outputs) {
      const location = this.uploads.locateStoredMedia(output.url);
      if (!location) external(output.url, 'output');
      if (location && location.area !== 'evidence') {
        try {
          const evidenceKey = await this.uploads.moveToEvidence(
            location.area,
            location.key,
            null,
          );
          moved++;
          removed.push({
            generationId: generation.id,
            role: 'output',
            url: output.url,
            location,
            evidenceKey,
          });
          const ids = scans
            .filter(
              (scan) =>
                !!scan.mediaKey && matchesPromotedKey(scan.mediaKey, location.key),
            )
            .map((scan) => scan.id);
          if (ids.length > 0) {
            await this.prisma.contentSafetyScan
              .updateMany({ where: { id: { in: ids } }, data: { evidenceKey } })
              .catch((error: unknown) =>
                this.logger.error(
                  `[SAFETY_REVIEW] gen=${generation.id}: evidência ${evidenceKey} sem ligação (${errorText(error)})`,
                ),
              );
          } else {
            await this.linkEvidence(generation, 'OUTPUT', location.key, evidenceKey);
          }
        } catch (error) {
          if (!(error instanceof StorageReadError && error.reason === 'not_found')) {
            pending = true;
            this.logger.error(
              `[SAFETY_REVIEW] gen=${generation.id}: resultado ${location.key} não saiu do público (${errorText(error)})`,
            );
          }
        }
      }
      const thumbnail = this.uploads.locateStoredMedia(output.thumbnailUrl);
      if (!thumbnail) external(output.thumbnailUrl, 'thumbnail');
      if (thumbnail && thumbnail.area !== 'evidence') {
        try {
          const evidenceKey = await this.uploads.moveToEvidence(
            thumbnail.area,
            thumbnail.key,
            null,
          );
          removed.push({
            generationId: generation.id,
            role: 'thumbnail',
            url: output.thumbnailUrl as string,
            location: thumbnail,
            evidenceKey,
          });
          await this.linkEvidence(generation, 'OUTPUT', thumbnail.key, evidenceKey);
        } catch (error) {
          if (!(error instanceof StorageReadError && error.reason === 'not_found')) {
            pending = true;
            this.logger.error(
              `[SAFETY_REVIEW] gen=${generation.id}: miniatura ${thumbnail.key} não saiu do público (${errorText(error)})`,
            );
          }
        }
      }
    }
    await this.prisma.generation
      .updateMany({ where: { id: generation.id }, data: { isDeleted: true } })
      .catch((error: unknown) =>
        this.logger.error(
          `[SAFETY_REVIEW] gen=${generation.id}: geração não saiu da galeria (${errorText(error)})`,
        ),
      );
    const externalCount = removed.filter((file) => !file.location).length;
    if (externalCount > 0) {
      this.logger.error(
        `[SAFETY_REVIEW] gen=${generation.id}: ${externalCount} arquivo(s) do caso confirmado fora do storage da plataforma seguem no ar (pedir a remoção a quem hospeda)`,
      );
    }
    return {
      moved,
      pending,
      external: externalCount,
      purge: await this.recordRemoval(scanId, actor, removed),
    };
  }

  /**
   * Itens da remoção e purga do CDN do que saiu do público (pelo TakedownService). Sem ele, nada é purgado agora: o
   * que era público conta como pendente e vai para o log, para alguém purgar à mão.
   */
  private async recordRemoval(
    scanId: string,
    actor: ReviewActor,
    files: ReviewRemovalFile[],
  ): Promise<Record<PurgeStatus, number>> {
    const purge: Record<PurgeStatus, number> = {
      none: 0,
      pending: 0,
      done: 0,
      failed: 0,
    };
    if (files.length === 0) return purge;
    if (this.takedown) {
      try {
        return await this.takedown.recordReviewRemoval({
          scanId,
          actorId: actor.id,
          files,
        });
      } catch (error) {
        this.logger.error(
          `[SAFETY_REVIEW] scan=${scanId}: itens da remoção e purga do CDN não gravados (${errorText(error)})`,
        );
      }
    }
    for (const file of files) {
      if (file.location?.area === 'public') purge.pending += 1;
      else purge.none += 1;
    }
    if (purge.pending > 0) {
      this.logger.error(
        `[SAFETY_REVIEW] scan=${scanId}: ${purge.pending} arquivo(s) saíram do público sem purga do CDN (a cópia em cache vence no max-age): purgar à mão`,
      );
    }
    return purge;
  }

  /** Linha do revisor que liga uma evidência movida aqui à geração (sem ela, a chave ficaria sem dono). */
  private async linkEvidence(
    generation: { id: string; userId: string },
    stage: 'INPUT' | 'OUTPUT',
    mediaKey: string,
    evidenceKey: string,
  ): Promise<void> {
    const updated = await this.prisma.contentSafetyScan
      .updateMany({
        where: {
          generationId: generation.id,
          mediaKey,
          stage: {
            in: stage === 'INPUT' ? ['INPUT', 'INPUT_FRAME'] : ['OUTPUT', 'OUTPUT_FRAME'],
          },
        },
        data: { evidenceKey },
      })
      .catch(() => ({ count: 0 }));
    if (updated.count > 0) return;
    await this.prisma.contentSafetyScan
      .create({
        data: {
          generationId: generation.id,
          userId: generation.userId,
          stage,
          mediaKey,
          sha256: /^evidence\/([0-9a-f]{64})\//.exec(evidenceKey)?.[1] ?? null,
          phash: null,
          scores: { reason: 'guardada pela confirmação do revisor' },
          verdict: 'BLOCK',
          ruleId: REVIEW_CONFIRMED_RULE,
          strength: 'STRONG',
          rulesVersion: RULES_VERSION,
          mode: this.config.imageMode,
          enforced: true,
          scanner: 'reviewer',
          evidenceKey,
        },
      })
      .catch((error: unknown) =>
        this.logger.error(
          `[SAFETY_REVIEW] gen=${generation.id}: evidência ${evidenceKey} sem linha de checagem (${errorText(error)})`,
        ),
      );
  }

  /**
   * Hash perceptual da mídia confirmada na lista de bloqueio (forte, origem manual). Falha vira log. Devolve as fotos
   * (hash e linha da lista) para a contagem de repetição da camada 6.
   */
  private async blockHashes(
    scan: ScanRow,
    eventId: string | null,
  ): Promise<StrikePhoto[]> {
    const photos: StrikePhoto[] = [];
    const rows =
      scan.generationId && scan.mediaKey && hasStoredMedia(scan.mediaKey)
        ? await this.prisma.contentSafetyScan.findMany({
            where: {
              generationId: scan.generationId,
              mediaKey: scan.mediaKey,
              phash: { not: null },
            },
            select: { phash: true, sha256: true, stage: true },
          })
        : scan.phash
          ? [{ phash: scan.phash, sha256: scan.sha256, stage: scan.stage }]
          : [];
    const seen = new Set<string>();
    const wholeFile =
      rows.length === 1 && (rows[0].stage === 'INPUT' || rows[0].stage === 'OUTPUT');
    for (const row of rows) {
      if (!row.phash || seen.has(row.phash)) continue;
      seen.add(row.phash);
      // o sha256 exato só vale para o arquivo inteiro (quadro de vídeo fica só com o pHash)
      const sha256 = wholeFile ? row.sha256 : null;
      let blockId: string | null = null;
      try {
        blockId = await this.blocklist.add({
          phash: row.phash,
          sha256,
          strength: 'STRONG',
          origin: 'manual',
          eventId,
        });
      } catch (error) {
        this.logger.warn(
          `[SAFETY_REVIEW] scan=${scan.id}: lista de bloqueio não gravada (${errorText(error)})`,
        );
      }
      photos.push({ phash: row.phash, sha256, blockId });
    }
    return photos;
  }
}
