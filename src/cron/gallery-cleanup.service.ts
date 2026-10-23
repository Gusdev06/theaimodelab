import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ContentReportStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import {
  EvidenceCandidate,
  HoldReport,
  generationsCitedByReports,
  holdAccountEmail,
  minorBlockedGenerationIds,
  reportCaseOpen,
} from '../users/account-erasure.service';
import { CronLoggerService } from './cron-logger.service';

const SCHEDULE = '0 3 * * *';
/** Gerações vencidas marcadas como apagadas por rodada (o mesmo teto de antes). */
const BATCH_SIZE = 200;
/**
 * Páginas lidas por rodada. As gerações que ficam (evidência) continuam vencidas e nunca saem da consulta; por isso a
 * leitura não recomeça do menor id a cada rodada: continua de onde a anterior parou e dá a volta no começo (ver
 * selectExpired), e nenhuma quantidade de evidência trava a fila.
 */
const MAX_SCAN_PAGES = 10;
const REPORT_PAGE = 1000;

/** Geração vencida lida para a limpeza (com o que uma denúncia pode citar dela). */
interface ExpiredGeneration {
  id: string;
  userId: string;
  userAvatarId: string | null;
  voiceProfileId: string | null;
  user: { id: string; email: string };
}

export interface GalleryCleanupSelection {
  /** gerações vencidas que podem sair da galeria */
  expired: string[];
  /** gerações vencidas que ficam por serem evidência (denúncia em aberto ou bloqueio por menor) */
  keptAsEvidence: number;
  /** a leitura parou no teto de páginas: pode haver mais vencidas para a próxima rodada (que continua dali) */
  scanCapped: boolean;
}

@Injectable()
export class GalleryCleanupService {
  private readonly logger = new Logger(GalleryCleanupService.name);
  /**
   * Id da última geração lida pela rodada anterior NESTE processo: a próxima continua depois dele e dá a volta no
   * começo. null = começa do menor id (1ª rodada depois de subir, ou a anterior deu a volta inteira). Em memória de
   * propósito: reiniciar o processo só faz a leitura voltar ao começo (a passada inteira é a reserva).
   */
  private resumeAfter: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleGalleryCleanup() {
    try {
      return await this.cronLogger.wrap(
        {
          cronName: 'GalleryCleanupService.handleGalleryCleanup',
          schedule: SCHEDULE,
        },
        async () => {
          const now = new Date();
          const selection = await this.selectExpired(now);

          if (selection.keptAsEvidence > 0) {
            this.logger.log(
              `${selection.keptAsEvidence} expired generation(s) kept as evidence (open report or minor block)`,
            );
          }
          if (selection.scanCapped) {
            this.logger.warn(
              `Gallery cleanup read ${MAX_SCAN_PAGES} page(s) without filling the batch: the next run resumes from where this one stopped`,
            );
          }
          if (selection.expired.length === 0) {
            return {
              expiredFound: 0,
              keptAsEvidence: selection.keptAsEvidence,
              scanCapped: selection.scanCapped,
            };
          }

          // As mesmas travas de novo na escrita: a guarda legal pode ter tirado o prazo (expiresAt = null) entre a
          // leitura e aqui. Conta inativa sem guarda (exclusão LGPD já feita, bloqueio pelo admin) vence como sempre:
          // a guarda é quem protege a evidência, tirando o prazo de todas as gerações da conta.
          const guard = {
            id: { in: selection.expired },
            isDeleted: false,
            expiresAt: { lte: now },
          };
          const marked = await this.prisma.generation.updateMany({
            where: guard,
            data: { isDeleted: true },
          });

          this.logger.log(
            `Marked ${marked.count} expired generations as deleted`,
          );

          const confirmed =
            marked.count === selection.expired.length
              ? selection.expired
              : (
                  await this.prisma.generation.findMany({
                    where: { ...guard, isDeleted: true },
                    select: { id: true },
                  })
                ).map((generation) => generation.id);

          for (const generationId of confirmed) {
            this.deleteGenerationFiles(generationId).catch((err) => {
              this.logger.warn(
                `Failed to delete S3 files for generation ${generationId}: ${(err as Error).message}`,
              );
            });
          }

          return {
            expiredFound: marked.count,
            keptAsEvidence: selection.keptAsEvidence,
            scanCapped: selection.scanCapped,
          };
        },
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Gallery cleanup cron failed: ${failure.message}`,
        failure.stack,
      );
    }
  }

  /**
   * Gerações vencidas que podem sair da galeria. Ficam de fora (evidência, nunca apagadas por aqui):
   * - de conta sob guarda legal: a guarda tira o prazo (expiresAt = null) de todas as gerações da conta e o processador
   *   não grava prazo para conta inativa, então elas nem entram na consulta;
   * - citadas por denúncia com o caso aberto (não descartada e sem a evidência liberada), pela própria geração, por um
   *   post dela, pelo avatar ou voz usados, ou pelo perfil ou e-mail da dona;
   * - com bloqueio por menor de idade ligado a elas (content_safety_events.generation_id) ainda não liberado.
   *
   * A leitura é em anel: começa depois da última geração lida pela rodada anterior (resumeAfter), vai até o fim e dá a
   * volta do começo até o ponto de partida, no máximo MAX_SCAN_PAGES páginas. Quando a volta fecha, a próxima rodada
   * começa do começo (passada inteira); quando para no teto ou com o lote cheio, a próxima continua dali.
   */
  async selectExpired(now: Date): Promise<GalleryCleanupSelection> {
    const expired: string[] = [];
    let keptAsEvidence = 0;
    let openReports: Array<Pick<HoldReport, 'target' | 'description'>> | null =
      null;
    const start = this.resumeAfter;
    // 1º trecho: depois do ponto de partida até o fim; 2º (a volta): do começo até o ponto de partida
    let wrapped = start === null;
    let cursor: string | null = start;
    let lastRead: string | null = null;
    let pages = 0;
    let scanCapped = false;
    let fullPass = false;

    while (expired.length < BATCH_SIZE) {
      if (pages >= MAX_SCAN_PAGES) {
        scanCapped = true;
        break;
      }
      pages++;
      const idRange: { gt?: string; lte?: string } = {};
      if (cursor) idRange.gt = cursor;
      if (wrapped && start) idRange.lte = start;
      const page: ExpiredGeneration[] = await this.prisma.generation.findMany({
        where: {
          expiresAt: { lte: now },
          isDeleted: false,
          ...(idRange.gt || idRange.lte ? { id: idRange } : {}),
        },
        select: {
          id: true,
          userId: true,
          userAvatarId: true,
          voiceProfileId: true,
          user: { select: { id: true, email: true } },
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
      });

      let batchFull = false;
      if (page.length > 0) {
        openReports ??= await this.readOpenReports();
        const held = await this.evidenceAmong(page, openReports);
        for (const generation of page) {
          if (expired.length >= BATCH_SIZE) {
            batchFull = true;
            break;
          }
          lastRead = generation.id;
          if (held.has(generation.id)) {
            keptAsEvidence++;
            continue;
          }
          expired.push(generation.id);
        }
        cursor = page[page.length - 1].id;
      }
      // lote cheio no meio da página: o resto dela fica para a próxima rodada (que continua de lastRead)
      if (batchFull) break;
      if (page.length < BATCH_SIZE) {
        if (wrapped) {
          fullPass = true;
          break;
        }
        wrapped = true;
        cursor = null;
      }
    }

    this.resumeAfter = fullPass ? null : lastRead;
    return { expired, keptAsEvidence, scanCapped };
  }

  /** Denúncias com o caso aberto (todas, em páginas; a tabela é pequena e a leitura é uma vez por rodada). */
  private async readOpenReports(): Promise<
    Array<Pick<HoldReport, 'target' | 'description'>>
  > {
    const open: Array<Pick<HoldReport, 'target' | 'description'>> = [];
    let cursor: string | null = null;
    for (;;) {
      const page: Array<
        Pick<
          HoldReport,
          'id' | 'status' | 'evidenceReleasedAt' | 'target' | 'description'
        >
      > = await this.prisma.contentReport.findMany({
        where: {
          status: { not: ContentReportStatus.DISMISSED },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: {
          id: true,
          status: true,
          evidenceReleasedAt: true,
          target: true,
          description: true,
        },
        orderBy: { id: 'asc' },
        take: REPORT_PAGE,
      });
      for (const report of page) if (reportCaseOpen(report)) open.push(report);
      if (page.length < REPORT_PAGE) break;
      cursor = page[page.length - 1].id;
    }
    return open;
  }

  /** Ids da página que são evidência: bloqueio por menor ligado à geração ou citação por denúncia em aberto. */
  private async evidenceAmong(
    page: ExpiredGeneration[],
    openReports: Array<Pick<HoldReport, 'target' | 'description'>>,
  ): Promise<Set<string>> {
    const ids = page.map((generation) => generation.id);
    const held = await minorBlockedGenerationIds(this.prisma, ids);
    if (openReports.length === 0) return held;

    const posts = await this.prisma.communityPost.findMany({
      where: { generationId: { in: ids } },
      select: { id: true, generationId: true },
    });
    const candidates: EvidenceCandidate[] = page.map((generation) => ({
      id: generation.id,
      userId: generation.userId,
      email: holdAccountEmail(generation.user),
      userAvatarId: generation.userAvatarId,
      voiceProfileId: generation.voiceProfileId,
    }));
    for (const id of generationsCitedByReports(openReports, candidates, posts))
      held.add(id);
    return held;
  }

  /**
   * ATENÇÃO, não corrigir sem resolver o TKT-135 antes: as saídas das gerações ficam em `generations/<id>/` (é o que os
   * provedores gravam), então `outputs/<id>/` aqui não apaga o arquivo de verdade, só as miniaturas saem. Trocar o
   * prefixo agora começaria a apagar arquivos de planos pagos enquanto a retenção nula do TKT-135 estiver aberta.
   */
  private async deleteGenerationFiles(generationId: string): Promise<void> {
    const [outputsDeleted, thumbnailsDeleted] = await Promise.all([
      this.uploadsService.deleteByPrefix(`outputs/${generationId}/`),
      this.uploadsService.deleteByPrefix(`thumbnails/${generationId}/`),
    ]);

    if (outputsDeleted + thumbnailsDeleted > 0) {
      this.logger.log(
        `Deleted ${outputsDeleted + thumbnailsDeleted} S3 file(s) for expired generation ${generationId}`,
      );
    }
  }
}
