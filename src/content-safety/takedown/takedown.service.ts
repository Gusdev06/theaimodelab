import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  CommunityPostStatus,
  ContentReport,
  ContentReportCategory,
  ContentReportStatus,
  ContentSafetyScanStage,
  ContentTakedownItem,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  contentTypeOfKey,
  StorageReadError,
  UploadsService,
  type StoredMediaLocation,
} from '../../uploads/uploads.service';
import {
  citedIds,
  reportHoldsEvidence,
} from '../../users/account-erasure.service';
import {
  IMAGE_SAFETY_CONFIG,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import type { SafetyMediaToolkit } from '../image-safety/image-safety.service';
import { BLOCKLIST } from '../image-safety/image-safety.tokens';
import { hammingDistance, isValidPhash } from '../image-safety/phash';
import type { BlocklistPort } from '../image-safety/types';
import { CdnPurgeService, type PurgeOutcome } from './cdn-purge.service';
import { LegalRetentionReader } from './legal-retention';
import { takedownClock, type TakedownClock } from './takedown.deadline';
import { TAKEDOWN_MEDIA_TOOLKIT } from './takedown.tokens';

/**
 * Remoção confirmada pelo revisor (camada 8; "sou a pessoa da imagem", TAKE IT DOWN, 48 h). Para cada geração
 * denunciada (citada na denúncia ou indicada pelo revisor):
 *  1. o resultado, a miniatura, a entrada pública e a mídia do post da comunidade saem do bucket público: apagados, ou
 *     levados para o bucket de evidência quando há guarda legal (LegalRetentionReader, a régua da PR #4). Evidência
 *     nunca é apagada;
 *  2. o hash de cada resultado (sha256 e pHash; vídeo por quadro) entra na lista de bloqueio própria (origem
 *     `report`): cópia idêntica ou parecida que voltar como entrada ou resultado é barrada pela checagem de imagem;
 *  3. cópias já geradas: as checagens recentes (content_safety_scans) apontam gerações com o mesmo hash; a idêntica
 *     (mesmo sha256 do arquivo) sai junto, a parecida (pHash perto) só é listada para o revisor decidir;
 *  4. a geração some da galeria (isDeleted), o post sai do ar (REJECTED) e o borrado guardado no banco é apagado;
 *  5. o CDN é purgado pela URL (Cloudflare); sem token, a purga fica pendente com o motivo e a varredura repete. O
 *     prazo de 48 h (takedownDoneAt) só fecha com tudo fora do ar, purga incluída.
 * Funciona em qualquer IMAGE_SAFETY_MODE: é uma ação do revisor, não depende do leitor de imagem. Toda remoção
 * grava quem, quando e por quê em content_safety_access_log ANTES de agir (sem o registro, nada acontece).
 */

/** Gerações por remoção (o revisor manda mais numa segunda vez). */
export const TAKEDOWN_MAX_GENERATIONS = 50;
export const TAKEDOWN_REASON_MIN_LENGTH = 10;
export const TAKEDOWN_REASON_MAX_LENGTH = 1000;
/** Motivo gravado no post da comunidade tirado do ar pela remoção (a linha fica como trilha). */
export const TAKEDOWN_POST_REJECTION_REASON = 'takedown';
/** Teto de leitura de um arquivo (hash e cópia para a evidência). */
export const TAKEDOWN_READ_MAX_BYTES = 512 * 1024 * 1024;
/** Checagens recentes lidas para achar cópias parecidas (as antigas já perderam o hash). */
const COPY_SCAN_MAX_ROWS = 200_000;
/** Gerações candidatas a cópia conferidas por remoção. */
const COPY_CANDIDATES_MAX = 50;
/** Tentativas de purga de um item (a falta de configuração não conta tentativa). */
export const PURGE_MAX_ATTEMPTS = 8;
/** Espera mínima entre tentativas de purga do mesmo item. */
export const PURGE_RETRY_MIN_AGE_MS = 10 * 60_000;
const PURGE_RETRY_BATCH = 300;
const NOT_CONFIGURED_LOG_EVERY_MS = 60 * 60_000;
const DETAIL_MAX_LENGTH = 300;

/** review = arquivo publicado de um caso de checagem confirmado pelo revisor (sem denúncia; o item leva o scanId). */
export type TakedownSource = 'report' | 'identical_copy' | 'post' | 'review';
export type TakedownRole = 'output' | 'thumbnail' | 'input' | 'post';

/** Arquivo publicado que a confirmação de uma checagem tirou do público (ou não conseguiu, por ser de fora). */
export interface ReviewRemovalFile {
  generationId: string;
  role: 'output' | 'thumbnail';
  /** URL gravada no resultado (vai para o item sem a query) */
  url: string;
  /** onde estava no nosso storage; null = link do provedor ou de fora: continua no ar e o revisor pede a remoção */
  location: StoredMediaLocation | null;
  /** chave na evidência para onde o arquivo foi */
  evidenceKey: string | null;
}
/** O que aconteceu com o arquivo. */
export type TakedownAction =
  | 'deleted'
  | 'moved_to_evidence'
  | 'already_evidence'
  | 'not_found'
  | 'external'
  | 'failed';
export type PurgeStatus = 'none' | 'pending' | 'done' | 'failed';

export interface TakedownRequest {
  reportId: string;
  /** gerações a remover; vazio = as citadas na denúncia (id da geração, do post ou link do arquivo) */
  generationIds?: string[];
  reason: string;
  /** preservar como evidência mesmo sem guarda legal (ex.: a pessoa vai à polícia) */
  preserveEvidence?: boolean;
  actor: { id: string; email: string };
  ip: string | null;
}

/** Cópia parecida achada pelo pHash (não removida: o revisor decide e manda o id numa nova remoção). */
export interface NearCopy {
  generationId: string;
  outputId: string;
  distance: number;
}

export interface TakedownItemView {
  id: string;
  generationId: string | null;
  source: string;
  role: string;
  area: string | null;
  action: string;
  detail: string | null;
  evidence: boolean;
  purgeStatus: string;
  purgeError: string | null;
  blocked: number;
}

export interface TakedownResult {
  reportId: string;
  /** todo arquivo saiu do público (nenhum item `failed`) */
  complete: boolean;
  generationIds: string[];
  items: TakedownItemView[];
  nearCopies: NearCopy[];
  purge: Record<PurgeStatus, number>;
  report: {
    status: ContentReportStatus;
    takedownDueAt: string | null;
    takedownDoneAt: string | null;
    takedown: TakedownClock | null;
  };
}

export interface PurgeSweepResult {
  attempted: number;
  done: number;
  failed: number;
  /** itens que falharam na última tentativa (saem da varredura: purgar à mão) */
  exhausted: number;
  /** denúncias cujo prazo fechou agora (a última purga saiu) */
  reportsClosed: number;
  /** a purga não está configurada: nada foi tentado */
  notConfigured: boolean;
}

/** Arquivo a tirar do ar. */
interface MediaTarget {
  generationId: string;
  source: TakedownSource;
  role: TakedownRole;
  url: string;
  /** já lido na busca de cópias (evita baixar de novo) */
  preread?: { body: Buffer; contentType: string | null };
}

interface MediaOutcome {
  item: ContentTakedownItem;
  sha256: string | null;
  phashes: string[];
}

interface GenerationRow {
  id: string;
  userId: string;
  outputs: Array<{ id: string; url: string; thumbnailUrl: string | null }>;
  inputImages: Array<{ url: string | null }>;
}

const GENERATION_SELECT = {
  id: true,
  userId: true,
  outputs: {
    select: { id: true, url: true, thumbnailUrl: true },
    orderBy: { order: 'asc' },
  },
  inputImages: { select: { url: true } },
} satisfies Prisma.GenerationSelect;

const COPY_STAGES: ContentSafetyScanStage[] = [
  ContentSafetyScanStage.OUTPUT,
  ContentSafetyScanStage.OUTPUT_FRAME,
];
const VISIBLE_POST_STATUSES: CommunityPostStatus[] = [
  CommunityPostStatus.APPROVED,
  CommunityPostStatus.PENDING,
];

function clipDetail(text: string): string {
  return text.length > DETAIL_MAX_LENGTH
    ? `${text.slice(0, DETAIL_MAX_LENGTH - 1)}…`
    : text;
}

function describeError(error: unknown): string {
  if (error instanceof StorageReadError) return error.message;
  return clipDetail(error instanceof Error ? error.message : String(error));
}

/** URL sem query nem fragmento (a URL assinada nunca vai para o banco). */
function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0];
}

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function extensionOf(key: string): string {
  const extension = key.split('/').pop()?.split('.').pop()?.toLowerCase();
  return extension && extension !== key ? extension : 'mp4';
}

/** Soma a guarda pela categoria da denúncia ao motivo de cada geração que ainda não tinha guarda. */
function withReportHold(
  retained: Map<string, string | null>,
  reportHold: string | null,
): Map<string, string | null> {
  if (!reportHold) return retained;
  for (const [id, reason] of retained) {
    if (!reason) retained.set(id, reportHold);
  }
  return retained;
}

function minDistance(phashes: string[], targets: string[]): number | null {
  let best: number | null = null;
  for (const phash of phashes) {
    for (const target of targets) {
      const distance = hammingDistance(phash, target);
      if (best === null || distance < best) best = distance;
    }
  }
  return best;
}

export function toItemView(item: ContentTakedownItem): TakedownItemView {
  return {
    id: item.id,
    generationId: item.generationId,
    source: item.source,
    role: item.role,
    area: item.area,
    action: item.action,
    detail: item.detail,
    evidence: Boolean(item.evidenceKey) || item.action === 'already_evidence',
    purgeStatus: item.purgeStatus,
    purgeError: item.purgeError,
    blocked: item.blockIds.length,
  };
}

/** Gravação do resultado da purga num item (a falta de configuração não gasta tentativa). */
function purgeData(
  outcome: PurgeOutcome,
  now: Date,
): Prisma.ContentTakedownItemUpdateManyMutationInput {
  if (outcome.status === 'done') {
    return {
      purgeStatus: 'done',
      purgeError: null,
      purgedAt: now,
      purgeAttempts: { increment: 1 },
    };
  }
  if (outcome.status === 'failed') {
    return {
      purgeStatus: 'failed',
      purgeError: outcome.reason,
      purgeAttempts: { increment: 1 },
    };
  }
  return { purgeStatus: 'pending', purgeError: outcome.reason };
}

@Injectable()
export class TakedownService implements OnModuleInit {
  private readonly logger = new Logger(TakedownService.name);
  /** remoções em andamento neste processo (a 2ª da mesma denúncia ao mesmo tempo = 409) */
  private readonly running = new Set<string>();
  private lastNotConfiguredLogAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    @Inject(BLOCKLIST) private readonly blocklist: BlocklistPort,
    @Inject(IMAGE_SAFETY_CONFIG) private readonly config: ImageSafetyConfig,
    @Inject(TAKEDOWN_MEDIA_TOOLKIT) private readonly media: SafetyMediaToolkit,
    private readonly cdn: CdnPurgeService,
    private readonly retention: LegalRetentionReader,
  ) {}

  onModuleInit(): void {
    if (!this.evidenceStorageAvailable) {
      this.logger.warn(
        'Remoção (denúncia confirmada): sem S3_EVIDENCE_BUCKET nem S3_INPUT_PRIVATE_BUCKET, a remoção de conteúdo sob guarda legal recusa (a evidência não teria onde ficar)',
      );
    }
    if (!this.cdn.configured) {
      this.logger.warn(`Remoção: ${this.cdn.unavailableReason}`);
    }
  }

  /** Existe bucket privado para a evidência (S3_EVIDENCE_BUCKET ou a pasta evidence/ do bucket privado de entradas)? */
  private get evidenceStorageAvailable(): boolean {
    return (
      Boolean(this.config.evidenceBucket) || this.uploads.privateInputsEnabled
    );
  }

  async execute(request: TakedownRequest): Promise<TakedownResult> {
    const reason = request.reason?.trim() ?? '';
    if (
      reason.length < TAKEDOWN_REASON_MIN_LENGTH ||
      reason.length > TAKEDOWN_REASON_MAX_LENGTH
    ) {
      throw new BadRequestException({
        code: 'TAKEDOWN_REASON_REQUIRED',
        message: `Explique a remoção (de ${TAKEDOWN_REASON_MIN_LENGTH} a ${TAKEDOWN_REASON_MAX_LENGTH} caracteres em "reason"): fica no registro de acesso.`,
      });
    }
    if (this.running.has(request.reportId)) {
      throw new ConflictException({
        code: 'TAKEDOWN_IN_PROGRESS',
        message: 'A remoção desta denúncia já está em andamento.',
      });
    }
    this.running.add(request.reportId);
    try {
      return await this.run({ ...request, reason });
    } finally {
      this.running.delete(request.reportId);
    }
  }

  private async run(request: TakedownRequest): Promise<TakedownResult> {
    const report = await this.prisma.contentReport.findUnique({
      where: { id: request.reportId },
    });
    if (!report) throw new NotFoundException('Denúncia não encontrada');
    if (report.status === ContentReportStatus.DISMISSED) {
      throw new ConflictException({
        code: 'TAKEDOWN_REPORT_DISMISSED',
        message:
          'A denúncia está descartada: reabra (status OPEN ou IN_REVIEW) antes de remover.',
      });
    }

    const generations = await this.resolveGenerations(
      report,
      request.generationIds,
    );
    // denúncia que segura evidência (menor, crime, íntima, pessoa retratada, texto que cita menor): todo arquivo desta
    // remoção vai para a evidência, mesmo de geração indicada pelo revisor e de conta que a denúncia não cita
    const reportHold = reportHoldsEvidence(report)
      ? `denúncia que segura evidência (${report.category})`
      : null;
    const retained = withReportHold(
      await this.retention.reasonsFor(generations, {
        preserveEvidence: request.preserveEvidence,
      }),
      reportHold,
    );
    if (
      [...retained.values()].some(Boolean) &&
      !this.evidenceStorageAvailable
    ) {
      throw new ConflictException({
        code: 'TAKEDOWN_EVIDENCE_STORAGE_MISSING',
        message:
          'Há geração sob guarda legal e a evidência não tem onde ficar (S3_EVIDENCE_BUCKET ou S3_INPUT_PRIVATE_BUCKET). Nada foi removido.',
      });
    }

    // registro ANTES de agir: sem ele, nada acontece
    await this.prisma.contentSafetyAccessLog.create({
      data: {
        actorId: request.actor.id,
        action: 'takedown',
        targetType: 'report',
        targetId: report.id,
        reason: request.reason,
        ip: request.ip,
      },
    });

    const strength =
      report.category === ContentReportCategory.MINOR ? 'STRONG' : 'MEDIUM';
    const processed = new Set<string>();
    const outcomes: MediaOutcome[] = [];
    const generationIds = generations.map((generation) => generation.id);
    const posts = await this.prisma.communityPost.findMany({
      where: { generationId: { in: generationIds } },
      select: {
        id: true,
        generationId: true,
        mediaUrl: true,
        thumbnailUrl: true,
      },
    });

    for (const generation of generations) {
      const targets: MediaTarget[] = [];
      for (const output of generation.outputs) {
        targets.push({
          generationId: generation.id,
          source: 'report',
          role: 'output',
          url: output.url,
        });
        if (output.thumbnailUrl) {
          targets.push({
            generationId: generation.id,
            source: 'report',
            role: 'thumbnail',
            url: output.thumbnailUrl,
          });
        }
      }
      for (const input of generation.inputImages) {
        // só a entrada que ainda está no bucket público (a privada não é servida a ninguém)
        if (
          input.url &&
          this.uploads.locateStoredMedia(input.url)?.area === 'public'
        ) {
          targets.push({
            generationId: generation.id,
            source: 'report',
            role: 'input',
            url: input.url,
          });
        }
      }
      for (const post of posts) {
        if (post.generationId !== generation.id) continue;
        targets.push({
          generationId: generation.id,
          source: 'post',
          role: 'post',
          url: post.mediaUrl,
        });
        if (post.thumbnailUrl) {
          targets.push({
            generationId: generation.id,
            source: 'post',
            role: 'thumbnail',
            url: post.thumbnailUrl,
          });
        }
      }
      for (const target of targets) {
        const outcome = await this.processMedia(target, {
          reportId: report.id,
          actorId: request.actor.id,
          retainedReason: retained.get(generation.id) ?? null,
          strength,
          processed,
        });
        if (outcome) outcomes.push(outcome);
      }
    }

    // cópias já geradas por outras gerações, achadas pelo hash das checagens recentes
    const removedSha = new Set(
      outcomes
        .filter((outcome) => outcome.item.role !== 'thumbnail')
        .map((outcome) => outcome.sha256)
        .filter((sha): sha is string => Boolean(sha)),
    );
    const removedPhashes = [
      ...new Set(outcomes.flatMap((outcome) => outcome.phashes)),
    ];
    const copies = await this.handleCopies({
      removedSha,
      removedPhashes,
      exclude: new Set(generationIds),
      reportId: report.id,
      actorId: request.actor.id,
      preserveEvidence: request.preserveEvidence,
      reportHold,
      strength,
      processed,
    });
    outcomes.push(...copies.outcomes);

    const removedGenerationIds = [
      ...generationIds,
      ...copies.removedGenerationIds,
    ];
    await this.hideGenerations(removedGenerationIds, request.actor.id);

    const items = await this.purgeNewItems(
      outcomes.map((outcome) => outcome.item),
    );
    const complete = items.every((item) => item.action !== 'failed');
    // o prazo de 48 h só fecha com tudo FORA DO AR: arquivo fora do bucket e endereço purgado do CDN (sem token ou com
    // a Cloudflare falhando, a cópia em cache segue no ar; a varredura fecha o prazo quando a última purga sair)
    const offAir = complete && (await this.offAir(report.id));
    const updated = await this.recordOnReport(
      report,
      complete,
      offAir,
      request.actor,
    );

    try {
      await this.prisma.contentSafetyAccessLog.createMany({
        data: removedGenerationIds.map((generationId) => ({
          actorId: request.actor.id,
          action: 'takedown',
          targetType: 'generation',
          targetId: generationId,
          reason: `denúncia ${report.id}`,
          ip: request.ip,
        })),
      });
    } catch (error) {
      this.logger.error(
        `Remoção da denúncia ${report.id}: o registro de acesso por geração falhou: ${describeError(error)}`,
      );
    }

    const purge: Record<PurgeStatus, number> = {
      none: 0,
      pending: 0,
      done: 0,
      failed: 0,
    };
    for (const item of items) {
      const status = item.purgeStatus as PurgeStatus;
      if (status in purge) purge[status] += 1;
    }
    this.logger.warn(
      `Remoção da denúncia ${report.id} por ${request.actor.id}: ${removedGenerationIds.length} geração(ões), ${items.length} arquivo(s), ${complete ? 'completa' : 'INCOMPLETA (há arquivo com falha)'}; purga: ${purge.done} feita(s), ${purge.pending} pendente(s), ${purge.failed} com falha`,
    );
    return {
      reportId: report.id,
      complete,
      generationIds: removedGenerationIds,
      items: items.map(toItemView),
      nearCopies: copies.nearCopies,
      purge,
      report: {
        status: updated.status,
        takedownDueAt: updated.takedownDueAt?.toISOString() ?? null,
        takedownDoneAt: updated.takedownDoneAt?.toISOString() ?? null,
        takedown: takedownClock(updated, new Date()),
      },
    };
  }

  /** Itens já gravados de uma denúncia, com o relógio do prazo. */
  async listItems(reportId: string): Promise<{
    reportId: string;
    takedown: TakedownClock | null;
    items: TakedownItemView[];
  }> {
    const report = await this.prisma.contentReport.findUnique({
      where: { id: reportId },
    });
    if (!report) throw new NotFoundException('Denúncia não encontrada');
    const items = await this.prisma.contentTakedownItem.findMany({
      where: { reportId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      reportId,
      takedown: takedownClock(report, new Date()),
      items: items.map(toItemView),
    };
  }

  /**
   * Gerações da remoção: as indicadas pelo revisor (todas precisam existir) ou as citadas na denúncia (id da
   * geração, id do post da comunidade, ou o link do arquivo, que leva o id da geração na pasta).
   */
  private async resolveGenerations(
    report: ContentReport,
    explicit: string[] | undefined,
  ): Promise<GenerationRow[]> {
    if (explicit?.length) {
      const ids = [...new Set(explicit.map((id) => id.trim()))].filter(Boolean);
      if (ids.length > TAKEDOWN_MAX_GENERATIONS) {
        throw new BadRequestException({
          code: 'TAKEDOWN_TOO_MANY_GENERATIONS',
          message: `No máximo ${TAKEDOWN_MAX_GENERATIONS} gerações por remoção.`,
        });
      }
      const rows = await this.prisma.generation.findMany({
        where: { id: { in: ids } },
        select: GENERATION_SELECT,
      });
      if (rows.length !== ids.length) {
        throw new BadRequestException({
          code: 'TAKEDOWN_GENERATION_NOT_FOUND',
          message: `${ids.length - rows.length} das gerações indicadas não existe(m).`,
        });
      }
      return rows;
    }

    const tokens = [
      ...new Set([...citedIds(report.target), ...citedIds(report.description)]),
    ];
    const ids = new Set<string>();
    if (tokens.length) {
      const direct = await this.prisma.generation.findMany({
        where: { id: { in: tokens } },
        select: { id: true },
      });
      direct.forEach((row) => ids.add(row.id));
      const viaPosts = await this.prisma.communityPost.findMany({
        where: { id: { in: tokens } },
        select: { generationId: true },
      });
      viaPosts.forEach((row) => {
        if (row.generationId) ids.add(row.generationId);
      });
    }
    if (!ids.size) {
      throw new BadRequestException({
        code: 'TAKEDOWN_NO_GENERATION',
        message:
          'A denúncia não cita nenhuma geração existente: informe as gerações em "generationIds".',
      });
    }
    if (ids.size > TAKEDOWN_MAX_GENERATIONS) {
      throw new BadRequestException({
        code: 'TAKEDOWN_TOO_MANY_GENERATIONS',
        message: `A denúncia cita ${ids.size} gerações; indique no máximo ${TAKEDOWN_MAX_GENERATIONS} em "generationIds".`,
      });
    }
    return this.prisma.generation.findMany({
      where: { id: { in: [...ids] } },
      select: GENERATION_SELECT,
    });
  }

  /**
   * Tira um arquivo do público: lê (para o hash e a cópia de evidência), guarda ou apaga, põe o hash na lista de
   * bloqueio e grava o item. Evidência nunca é tocada. null = arquivo já tratado nesta remoção.
   */
  private async processMedia(
    target: MediaTarget,
    context: {
      reportId: string;
      actorId: string;
      retainedReason: string | null;
      strength: 'STRONG' | 'MEDIUM';
      processed: Set<string>;
    },
  ): Promise<MediaOutcome | null> {
    const location = this.uploads.locateStoredMedia(target.url);
    const dedupeKey = location
      ? `${location.area}:${location.key}`
      : `url:${withoutQuery(target.url)}`;
    if (context.processed.has(dedupeKey)) return null;
    context.processed.add(dedupeKey);

    const base = {
      reportId: context.reportId,
      generationId: target.generationId,
      source: target.source,
      role: target.role,
      actorId: context.actorId,
    };
    if (!location) {
      // link do provedor ou de fora: não é nosso para apagar nem purgar
      const item = await this.prisma.contentTakedownItem.create({
        data: {
          ...base,
          action: 'external',
          detail:
            'arquivo fora do storage da plataforma (pedir a remoção a quem hospeda)',
          purgeStatus: 'none',
        },
      });
      return { item, sha256: null, phashes: [] };
    }
    if (location.area === 'evidence') {
      const item = await this.prisma.contentTakedownItem.create({
        data: {
          ...base,
          area: location.area,
          mediaKey: location.key,
          action: 'already_evidence',
          purgeStatus: 'none',
        },
      });
      return { item, sha256: null, phashes: [] };
    }

    const publicUrl =
      location.area === 'public' ? withoutQuery(target.url) : null;
    const removal = await this.removeObject(
      location,
      target,
      context.retainedReason,
    );
    const hashes =
      removal.body !== null
        ? await this.hashMedia(
            removal.body,
            removal.contentType,
            location.key,
            target.role === 'output' || target.role === 'post',
          )
        : { sha256: null, phashes: [] as string[] };

    const blockIds: string[] = [];
    let detail = removal.detail;
    if (removal.action !== 'failed' && hashes.phashes.length) {
      for (const [index, phash] of hashes.phashes.entries()) {
        try {
          blockIds.push(
            await this.blocklist.add({
              phash,
              // o sha256 do arquivo vai só na 1ª linha (os quadros do vídeo não são o arquivo)
              sha256: index === 0 ? hashes.sha256 : null,
              strength: context.strength,
              origin: 'report',
              eventId: null,
            }),
          );
        } catch (error) {
          this.logger.error(
            `Remoção da denúncia ${context.reportId}: hash não entrou na lista de bloqueio: ${describeError(error)}`,
          );
          detail = clipDetail(
            `${detail ? `${detail}; ` : ''}hash fora da lista de bloqueio`,
          );
        }
      }
    }

    const purgeStatus: PurgeStatus =
      publicUrl && removal.action !== 'failed' ? 'pending' : 'none';
    try {
      const item = await this.prisma.contentTakedownItem.create({
        data: {
          ...base,
          area: location.area,
          mediaKey: location.key,
          publicUrl,
          sha256: hashes.sha256,
          phashes: hashes.phashes,
          blockIds,
          action: removal.action,
          detail,
          evidenceKey: removal.evidenceKey,
          purgeStatus,
        },
      });
      return { item, sha256: hashes.sha256, phashes: hashes.phashes };
    } catch (error) {
      // o arquivo já foi tratado: o que aconteceu não pode sumir junto com a gravação que falhou
      this.logger.error(
        `Remoção da denúncia ${context.reportId}: ${location.area}:${location.key} ficou "${removal.action}"${removal.evidenceKey ? ` (evidência ${removal.evidenceKey})` : ''}, mas o item não foi gravado: ${describeError(error)}`,
      );
      throw error;
    }
  }

  /**
   * Guarda (evidência) ou apaga o objeto. Com guarda legal, sem conseguir ler o arquivo, nada é apagado (`failed`).
   * Sem guarda, arquivo grande demais para ler sai assim mesmo (sem hash): tirar do ar vem primeiro.
   */
  private async removeObject(
    location: StoredMediaLocation,
    target: MediaTarget,
    retainedReason: string | null,
  ): Promise<{
    action: TakedownAction;
    detail: string | null;
    evidenceKey: string | null;
    body: Buffer | null;
    contentType: string | null;
  }> {
    let body: Buffer | null = target.preread?.body ?? null;
    let contentType: string | null = target.preread?.contentType ?? null;
    if (!body) {
      try {
        const stored = await this.uploads.readStoredObject(
          location.area,
          location.key,
          TAKEDOWN_READ_MAX_BYTES,
        );
        body = stored.body;
        contentType = stored.contentType;
      } catch (error) {
        const failure = error instanceof StorageReadError ? error.reason : null;
        if (failure === 'not_found') {
          return {
            action: 'not_found',
            detail: 'o arquivo já não estava no storage',
            evidenceKey: null,
            body: null,
            contentType: null,
          };
        }
        if (failure !== 'too_large' || retainedReason) {
          return {
            action: 'failed',
            detail: clipDetail(
              `não deu para ler o arquivo (${describeError(error)}); nada foi apagado`,
            ),
            evidenceKey: null,
            body: null,
            contentType: null,
          };
        }
      }
    }

    if (retainedReason && body) {
      let evidenceKey: string;
      try {
        evidenceKey = await this.uploads.moveToEvidence(
          location.area,
          location.key,
          sha256Hex(body),
          { body, contentType: contentType ?? contentTypeOfKey(location.key) },
        );
      } catch (error) {
        return {
          action: 'failed',
          detail: clipDetail(
            `não deu para guardar a evidência (${describeError(error)}); nada foi apagado`,
          ),
          evidenceKey: null,
          body,
          contentType,
        };
      }
      try {
        // a mudança para a evidência apaga a origem em silêncio: apagar de novo confere que saiu (idempotente)
        await this.uploads.deleteStoredObject(location.area, location.key);
      } catch (error) {
        return {
          action: 'failed',
          detail: clipDetail(
            `evidência guardada, mas o storage recusou apagar a origem (${describeError(error)})`,
          ),
          evidenceKey,
          body,
          contentType,
        };
      }
      return {
        action: 'moved_to_evidence',
        detail: clipDetail(`guarda legal: ${retainedReason}`),
        evidenceKey,
        body,
        contentType,
      };
    }
    try {
      await this.uploads.deleteStoredObject(location.area, location.key);
      return {
        action: 'deleted',
        detail: body
          ? null
          : 'apagado sem hash (arquivo grande demais para ler)',
        evidenceKey: null,
        body,
        contentType,
      };
    } catch (error) {
      return {
        action: 'failed',
        detail: clipDetail(
          `o storage recusou a remoção (${describeError(error)})`,
        ),
        evidenceKey: null,
        body: null,
        contentType: null,
      };
    }
  }

  /** sha256 do arquivo e pHash (imagem, ou os quadros do vídeo). Erro no pHash não impede a remoção. */
  private async hashMedia(
    body: Buffer,
    contentType: string | null,
    key: string,
    perceptual: boolean,
  ): Promise<{ sha256: string; phashes: string[] }> {
    const sha256 = sha256Hex(body);
    if (!perceptual) return { sha256, phashes: [] };
    const type = (contentType || contentTypeOfKey(key)).toLowerCase();
    try {
      let phashes: string[] = [];
      if (type.startsWith('image/')) {
        phashes = [await this.media.phash(body)];
      } else if (type.startsWith('video/')) {
        const frames = await this.media.sampleVideoFrames(
          body,
          extensionOf(key),
          this.config.video,
        );
        phashes = await Promise.all(
          frames.map((frame) => this.media.phash(frame.jpeg)),
        );
      }
      return {
        sha256,
        phashes: [...new Set(phashes.filter((phash) => isValidPhash(phash)))],
      };
    } catch (error) {
      this.logger.warn(
        `Remoção: pHash não calculado para um arquivo (${describeError(error)}); fica só o sha256`,
      );
      return { sha256, phashes: [] };
    }
  }

  /**
   * Cópias já geradas: gerações com checagem de resultado de mesmo sha256 ou pHash perto (content_safety_scans; as
   * checagens com mais de 30 dias já perderam o hash). Cada resultado candidato é lido e conferido de novo: mesmo
   * sha256 sai junto (cópia idêntica); pHash perto só vai para a lista do revisor.
   */
  private async handleCopies(input: {
    removedSha: Set<string>;
    removedPhashes: string[];
    exclude: Set<string>;
    reportId: string;
    actorId: string;
    preserveEvidence?: boolean;
    /** motivo da guarda pela categoria da denúncia (a cópia idêntica de outra conta também vai para a evidência) */
    reportHold: string | null;
    strength: 'STRONG' | 'MEDIUM';
    processed: Set<string>;
  }): Promise<{
    outcomes: MediaOutcome[];
    removedGenerationIds: string[];
    nearCopies: NearCopy[];
  }> {
    const empty = { outcomes: [], removedGenerationIds: [], nearCopies: [] };
    if (!input.removedSha.size && !input.removedPhashes.length) return empty;

    let candidates: string[];
    try {
      candidates = await this.copyCandidates(
        input.removedSha,
        input.removedPhashes,
        input.exclude,
      );
    } catch (error) {
      this.logger.error(
        `Remoção da denúncia ${input.reportId}: a busca de cópias falhou (${describeError(error)}); só as gerações denunciadas saíram`,
      );
      return empty;
    }
    if (!candidates.length) return empty;

    const generations = await this.prisma.generation.findMany({
      where: { id: { in: candidates } },
      select: GENERATION_SELECT,
    });
    const identical: Array<{
      generation: GenerationRow;
      output: GenerationRow['outputs'][number];
      body: Buffer;
      contentType: string | null;
    }> = [];
    const nearCopies: NearCopy[] = [];
    const maxDistance = Math.max(
      0,
      Math.floor(this.config.thresholds.phashMaxDistance),
    );
    for (const generation of generations) {
      for (const output of generation.outputs) {
        const location = this.uploads.locateStoredMedia(output.url);
        if (!location || location.area === 'evidence') continue;
        let stored: { body: Buffer; contentType: string | null };
        try {
          stored = await this.uploads.readStoredObject(
            location.area,
            location.key,
            TAKEDOWN_READ_MAX_BYTES,
          );
        } catch {
          continue;
        }
        const hashes = await this.hashMedia(
          stored.body,
          stored.contentType,
          location.key,
          true,
        );
        if (input.removedSha.has(hashes.sha256)) {
          identical.push({ generation, output, ...stored });
          continue;
        }
        const distance = minDistance(hashes.phashes, input.removedPhashes);
        if (distance !== null && distance <= maxDistance) {
          nearCopies.push({
            generationId: generation.id,
            outputId: output.id,
            distance,
          });
        }
      }
    }
    if (!identical.length)
      return { outcomes: [], removedGenerationIds: [], nearCopies };

    const copyGenerations = [
      ...new Map(
        identical.map((entry) => [entry.generation.id, entry.generation]),
      ).values(),
    ];
    const retained = withReportHold(
      await this.retention.reasonsFor(copyGenerations, {
        preserveEvidence: input.preserveEvidence,
      }),
      input.reportHold,
    );
    const outcomes: MediaOutcome[] = [];
    for (const entry of identical) {
      const retainedReason = retained.get(entry.generation.id) ?? null;
      if (retainedReason && !this.evidenceStorageAvailable) {
        // sem bucket de evidência a cópia sob guarda fica onde está: o revisor vê no item
        const item = await this.prisma.contentTakedownItem.create({
          data: {
            reportId: input.reportId,
            generationId: entry.generation.id,
            source: 'identical_copy',
            role: 'output',
            action: 'failed',
            detail:
              'cópia idêntica sob guarda legal sem bucket de evidência; nada foi apagado',
            purgeStatus: 'none',
            actorId: input.actorId,
          },
        });
        outcomes.push({ item, sha256: null, phashes: [] });
        continue;
      }
      const context = {
        reportId: input.reportId,
        actorId: input.actorId,
        retainedReason,
        strength: input.strength,
        processed: input.processed,
      };
      const main = await this.processMedia(
        {
          generationId: entry.generation.id,
          source: 'identical_copy',
          role: 'output',
          url: entry.output.url,
          preread: { body: entry.body, contentType: entry.contentType },
        },
        context,
      );
      if (main) outcomes.push(main);
      if (entry.output.thumbnailUrl) {
        const thumbnail = await this.processMedia(
          {
            generationId: entry.generation.id,
            source: 'identical_copy',
            role: 'thumbnail',
            url: entry.output.thumbnailUrl,
          },
          context,
        );
        if (thumbnail) outcomes.push(thumbnail);
      }
    }
    return {
      outcomes,
      removedGenerationIds: copyGenerations.map((generation) => generation.id),
      nearCopies,
    };
  }

  /** Gerações (fora as excluídas) com checagem de resultado de mesmo sha256 ou pHash a distância ≤ o limite. */
  private async copyCandidates(
    sha256: Set<string>,
    phashes: string[],
    exclude: Set<string>,
  ): Promise<string[]> {
    const found = new Set<string>();
    if (sha256.size) {
      const exact = await this.prisma.contentSafetyScan.findMany({
        where: {
          stage: { in: COPY_STAGES },
          sha256: { in: [...sha256] },
          generationId: { not: null },
        },
        select: { generationId: true },
        take: 1_000,
      });
      for (const row of exact) {
        if (row.generationId && !exclude.has(row.generationId))
          found.add(row.generationId);
      }
    }
    if (phashes.length) {
      const maxDistance = Math.max(
        0,
        Math.floor(this.config.thresholds.phashMaxDistance),
      );
      const rows = await this.prisma.contentSafetyScan.findMany({
        where: {
          stage: { in: COPY_STAGES },
          phash: { not: null },
          generationId: { not: null },
        },
        select: { generationId: true, phash: true },
        orderBy: { createdAt: 'desc' },
        take: COPY_SCAN_MAX_ROWS,
      });
      for (const row of rows) {
        if (
          !row.generationId ||
          exclude.has(row.generationId) ||
          found.has(row.generationId)
        )
          continue;
        const phash = row.phash?.trim().toLowerCase() ?? null;
        if (!isValidPhash(phash)) continue;
        const distance = minDistance([phash], phashes);
        if (distance !== null && distance <= maxDistance)
          found.add(row.generationId);
      }
    }
    return [...found].slice(0, COPY_CANDIDATES_MAX);
  }

  /**
   * A geração some da galeria (isDeleted), o borrado guardado no banco sai e o post da comunidade sai do ar. As linhas
   * ficam (trilha e guarda legal); os links já não abrem.
   */
  private async hideGenerations(ids: string[], actorId: string): Promise<void> {
    if (!ids.length) return;
    try {
      await this.prisma.generation.updateMany({
        where: { id: { in: ids } },
        data: { isDeleted: true },
      });
      await this.prisma.generationOutput.updateMany({
        where: { generationId: { in: ids } },
        data: { blurDataUrl: null },
      });
      await this.prisma.communityPost.updateMany({
        where: {
          generationId: { in: ids },
          status: { in: VISIBLE_POST_STATUSES },
        },
        data: {
          status: CommunityPostStatus.REJECTED,
          rejectionReason: TAKEDOWN_POST_REJECTION_REASON,
        },
      });
    } catch (error) {
      this.logger.error(
        `Remoção por ${actorId}: os arquivos saíram, mas a galeria/comunidade não foi atualizada (${describeError(error)})`,
      );
    }
  }

  /** Purga os endereços públicos dos itens novos (depois de todo arquivo sair, senão o CDN busca de novo). */
  private async purgeNewItems(
    items: ContentTakedownItem[],
  ): Promise<ContentTakedownItem[]> {
    const pending = items.filter(
      (item) => item.purgeStatus === 'pending' && item.publicUrl,
    );
    if (!pending.length) return items;
    const outcomes = await this.cdn.purgeUrls(
      pending.map((item) => item.publicUrl as string),
    );
    const now = new Date();
    const updated = new Map<string, ContentTakedownItem>();
    for (const item of pending) {
      const outcome = outcomes.get(item.publicUrl as string);
      if (!outcome) continue;
      try {
        updated.set(
          item.id,
          await this.prisma.contentTakedownItem.update({
            where: { id: item.id },
            data: purgeData(outcome, now),
          }),
        );
      } catch (error) {
        this.logger.error(
          `Remoção: resultado da purga do item ${item.id} não gravado (${describeError(error)})`,
        );
      }
    }
    return items.map((item) => updated.get(item.id) ?? item);
  }

  /**
   * Andamento na denúncia: completa = removida (ACTIONED), com a data e o revisor. O prazo (takedownDoneAt, só na 1ª
   * vez) fecha só com tudo fora do ar (`offAir`): com purga do CDN pendente ou com falha, a denúncia fica ACTIONED com o
   * relógio correndo (vence e aparece na fila) até a varredura purgar. Incompleta = em análise (o revisor vê o item com
   * falha e repete). Troca de status desfaz a liberação da evidência, como no PATCH do admin.
   */
  private async recordOnReport(
    report: ContentReport,
    complete: boolean,
    offAir: boolean,
    actor: { id: string; email: string },
  ): Promise<ContentReport> {
    const now = new Date();
    const data: Prisma.ContentReportUpdateInput = {};
    const nextStatus = complete
      ? ContentReportStatus.ACTIONED
      : report.status === ContentReportStatus.OPEN
        ? ContentReportStatus.IN_REVIEW
        : report.status;
    if (nextStatus !== report.status) {
      data.status = nextStatus;
      data.evidenceReleasedAt = null;
      data.evidenceReleasedBy = null;
    }
    data.handledBy = actor.email;
    if (complete) {
      data.handledAt = now;
      if (offAir && !report.takedownDoneAt) data.takedownDoneAt = now;
    }
    try {
      return await this.prisma.contentReport.update({
        where: { id: report.id },
        data,
      });
    } catch (error) {
      this.logger.error(
        `Remoção da denúncia ${report.id}: arquivos tratados, mas o andamento não foi gravado (${describeError(error)})`,
      );
      return report;
    }
  }

  /**
   * O que a denúncia ainda tem no ar, olhando TODOS os itens dela (de todas as rodadas): arquivo cuja última tentativa
   * falhou e endereço público com purga pendente ou com falha que nenhum outro item já purgou. O `external` (link do
   * provedor, fora do nosso storage) não segura o prazo: a plataforma não o hospeda; o item fica na lista para o revisor
   * pedir a remoção a quem hospeda.
   */
  private async stillPublic(reportId: string): Promise<number> {
    const rows = await this.prisma.contentTakedownItem.findMany({
      where: { reportId },
      select: {
        action: true,
        area: true,
        mediaKey: true,
        publicUrl: true,
        purgeStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = row.mediaKey ? `${row.area}:${row.mediaKey}` : row.publicUrl;
      if (key) latest.set(key, row);
    }
    const purged = new Set(
      rows
        .filter((row) => row.purgeStatus === 'done' && row.publicUrl)
        .map((row) => row.publicUrl),
    );
    let open = 0;
    for (const row of latest.values()) if (row.action === 'failed') open++;
    const unpurged = new Set(
      rows
        .filter(
          (row) =>
            row.publicUrl &&
            (row.purgeStatus === 'pending' || row.purgeStatus === 'failed') &&
            !purged.has(row.publicUrl),
        )
        .map((row) => row.publicUrl),
    );
    return open + unpurged.size;
  }

  /** Tudo fora do ar? Erro de leitura = não (o prazo continua correndo; nunca fecha às cegas). */
  private async offAir(reportId: string): Promise<boolean> {
    try {
      return (await this.stillPublic(reportId)) === 0;
    } catch (error) {
      this.logger.error(
        `Remoção da denúncia ${reportId}: conferência do que ainda está no ar falhou (${describeError(error)}); o prazo segue aberto`,
      );
      return false;
    }
  }

  /**
   * Fecha o prazo da denúncia removida (ACTIONED) quando a última purga do CDN saiu na varredura. Idempotente: só grava
   * se ainda estiver aberto. Devolve true quando fechou agora.
   */
  private async closeClockWhenOffAir(
    reportId: string,
    now: Date,
  ): Promise<boolean> {
    if (!(await this.offAir(reportId))) return false;
    const { count } = await this.prisma.contentReport.updateMany({
      where: {
        id: reportId,
        status: ContentReportStatus.ACTIONED,
        takedownDoneAt: null,
      },
      data: { takedownDoneAt: now },
    });
    return count > 0;
  }

  /**
   * Resultado publicado de um caso confirmado pelo revisor na checagem (camada 7): cada arquivo que saiu do público
   * para a evidência vira item (source review, com o scanId) e o endereço do CDN é purgado na hora; o que ficar pendente
   * ou falhar a varredura repete, como na remoção por denúncia. Arquivo de fora do storage vira item `external` (segue
   * no ar; pedir a remoção a quem hospeda). Nunca lança: a confirmação e a evidência valem mesmo sem a purga.
   */
  async recordReviewRemoval(input: {
    scanId: string;
    actorId: string;
    files: ReviewRemovalFile[];
  }): Promise<Record<PurgeStatus, number>> {
    const purge: Record<PurgeStatus, number> = {
      none: 0,
      pending: 0,
      done: 0,
      failed: 0,
    };
    const created: ContentTakedownItem[] = [];
    const unrecorded: string[] = [];
    for (const file of input.files) {
      const publicUrl =
        file.location?.area === 'public' ? withoutQuery(file.url) : null;
      try {
        created.push(
          await this.prisma.contentTakedownItem.create({
            data: {
              reportId: null,
              scanId: input.scanId,
              generationId: file.generationId,
              source: 'review',
              role: file.role,
              area: file.location?.area ?? null,
              mediaKey: file.location?.key ?? null,
              publicUrl,
              action: file.location ? 'moved_to_evidence' : 'external',
              detail: file.location
                ? 'caso confirmado pelo revisor'
                : 'arquivo fora do storage da plataforma (pedir a remoção a quem hospeda)',
              evidenceKey: file.evidenceKey,
              purgeStatus: publicUrl ? 'pending' : 'none',
              actorId: input.actorId,
            },
          }),
        );
      } catch (error) {
        this.logger.error(
          `Revisão (checagem ${input.scanId}): arquivo retirado da geração ${file.generationId} sem item gravado (${describeError(error)})`,
        );
        if (publicUrl) unrecorded.push(publicUrl);
        else purge.none += 1;
      }
    }
    let items = created;
    try {
      items = await this.purgeNewItems(created);
    } catch (error) {
      this.logger.error(
        `Revisão (checagem ${input.scanId}): purga do CDN não feita agora (${describeError(error)}); a varredura repete`,
      );
    }
    for (const item of items) {
      const status = item.purgeStatus as PurgeStatus;
      if (status in purge) purge[status] += 1;
    }
    if (unrecorded.length) {
      // sem item a varredura não repete: a purga é tentada uma vez aqui mesmo
      const outcomes = await this.cdn.purgeUrls(unrecorded);
      for (const url of unrecorded) {
        purge[outcomes.get(url)?.status ?? 'failed'] += 1;
      }
    }
    return purge;
  }

  /**
   * Varredura das purgas pendentes ou com falha (cron): só roda com a purga configurada (a falta de token não gasta
   * tentativa); cada item espera 10 min entre tentativas e para em 8. A última purga de uma denúncia removida fecha o
   * prazo dela; o item que esgota as tentativas vira erro no log uma vez (purgar à mão: o prazo segue aberto).
   */
  async retryPendingPurges(now = new Date()): Promise<PurgeSweepResult> {
    if (!this.cdn.configured) {
      if (
        now.getTime() - this.lastNotConfiguredLogAt >=
        NOT_CONFIGURED_LOG_EVERY_MS
      ) {
        const waiting = await this.prisma.contentTakedownItem.count({
          where: { purgeStatus: { in: ['pending', 'failed'] } },
        });
        if (waiting > 0) {
          this.lastNotConfiguredLogAt = now.getTime();
          this.logger.error(
            `Remoção: ${waiting} purga(s) do CDN esperando configuração (${this.cdn.unavailableReason})`,
          );
        }
      }
      return {
        attempted: 0,
        done: 0,
        failed: 0,
        exhausted: 0,
        reportsClosed: 0,
        notConfigured: true,
      };
    }
    const items = await this.prisma.contentTakedownItem.findMany({
      where: {
        purgeStatus: { in: ['pending', 'failed'] },
        publicUrl: { not: null },
        purgeAttempts: { lt: PURGE_MAX_ATTEMPTS },
        updatedAt: { lte: new Date(now.getTime() - PURGE_RETRY_MIN_AGE_MS) },
      },
      orderBy: { updatedAt: 'asc' },
      take: PURGE_RETRY_BATCH,
    });
    const result: PurgeSweepResult = {
      attempted: 0,
      done: 0,
      failed: 0,
      exhausted: 0,
      reportsClosed: 0,
      notConfigured: false,
    };
    if (!items.length) return result;
    const outcomes = await this.cdn.purgeUrls(
      items.map((item) => item.publicUrl as string),
    );
    const purgedReports = new Set<string>();
    for (const item of items) {
      const outcome = outcomes.get(item.publicUrl as string);
      if (!outcome) continue;
      result.attempted += 1;
      if (outcome.status === 'done') result.done += 1;
      else result.failed += 1;
      try {
        // só grava se ninguém mexeu no item desde a leitura
        const { count } = await this.prisma.contentTakedownItem.updateMany({
          where: {
            id: item.id,
            purgeStatus: item.purgeStatus,
            purgeAttempts: item.purgeAttempts,
          },
          data: purgeData(outcome, now),
        });
        if (count && outcome.status === 'done' && item.reportId) {
          purgedReports.add(item.reportId);
        }
        // a última tentativa falhou: o item sai da varredura; um erro só, com o que fazer
        if (
          count &&
          outcome.status === 'failed' &&
          item.purgeAttempts + 1 >= PURGE_MAX_ATTEMPTS
        ) {
          result.exhausted += 1;
          this.logger.error(
            `Remoção: purga do CDN do item ${item.id} (${item.reportId ? `denúncia ${item.reportId}` : `checagem ${item.scanId ?? '-'}`}) esgotou as ${PURGE_MAX_ATTEMPTS} tentativas (${outcome.reason}) — purgar o endereço à mão na Cloudflare; o prazo da denúncia segue aberto`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Remoção: resultado da purga do item ${item.id} não gravado (${describeError(error)})`,
        );
      }
    }
    for (const reportId of purgedReports) {
      try {
        if (await this.closeClockWhenOffAir(reportId, now)) {
          result.reportsClosed += 1;
        }
      } catch (error) {
        this.logger.error(
          `Remoção da denúncia ${reportId}: prazo não fechado depois da purga (${describeError(error)}); a próxima purga confere de novo`,
        );
      }
    }
    if (result.failed) {
      this.logger.warn(
        `Remoção: ${result.failed} purga(s) do CDN falharam de novo (motivo em cada item)`,
      );
    }
    return result;
  }
}
