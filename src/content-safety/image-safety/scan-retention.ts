import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  ContentSafetyScanStage,
  ContentSafetyScanVerdict,
  ContentSafetyStrength,
  GenerationStatus,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IMAGE_EVIDENCE_EVENT_KINDS } from '../safety-event-kinds';
import { SAFETY_STRIKES, SAFETY_TIMING } from './image-safety.config';

/**
 * Guarda mínima das checagens (content_safety_scans), LGPD art. 16: o hash, o pHash, a chave do arquivo e os sinais
 * (idade por rosto, rótulos) só servem ao cache de 30 dias e à janela de pontos de 90 dias. Depois disso a linha
 * fica só com o veredito, a regra, a força e a data, que é o que as métricas da trava precisam. Nunca toca em:
 *  - linha com evidência guardada (evidenceKey);
 *  - sinal forte (a guarda legal decide o prazo);
 *  - geração ainda em revisão (IN_REVIEW) ou com evento de imagem sem liberação do jurídico.
 * A linha nunca é apagada (o denominador das métricas continua). Roda em qualquer modo: o que foi gravado antes de um
 * desligamento também perde os sinais no prazo.
 */

export const SCAN_RETENTION_SCHEDULE = '17 4 * * *';
/** Linhas minimizadas por página; a rodada para quando acaba o que venceu (ou no teto de páginas). */
const RETENTION_PAGE = 500;
const RETENTION_MAX_PAGES = 200;

const MEDIA_STAGES: readonly ContentSafetyScanStage[] = [
  ContentSafetyScanStage.INPUT,
  ContentSafetyScanStage.INPUT_FRAME,
  ContentSafetyScanStage.OUTPUT,
  ContentSafetyScanStage.OUTPUT_FRAME,
];

/** O que fica de uma checagem minimizada nos sinais (marca, para quem ler saber que não é "sem sinal"). */
export const MINIMIZED_SCAN_SCORES = { minimized: true } as const;

/**
 * Campos zerados na minimização. A chave do arquivo só sai nas etapas de mídia: na etapa TEXT ela é só o marcador da
 * saída do refinador, sem dado da pessoa.
 */
export function minimizedScanData(
  family: 'media' | 'text',
): Prisma.ContentSafetyScanUpdateManyMutationInput {
  return {
    sha256: null,
    phash: null,
    scores: MINIMIZED_SCAN_SCORES,
    ...(family === 'media' ? { mediaKey: null } : {}),
  };
}

/**
 * Filtro das linhas vencidas e ainda não minimizadas (antes das exclusões por geração): veredito sem suspeita depois
 * do cache; sinal leve ou médio sem evidência depois da janela de pontos.
 */
export function expiredScansWhere(
  now: Date,
): Prisma.ContentSafetyScanWhereInput {
  const cacheLimit = new Date(now.getTime() - SAFETY_TIMING.verdictCacheTtlMs);
  const strikeLimit = new Date(
    now.getTime() - SAFETY_STRIKES.mediumStrikeWindowDays * 24 * 60 * 60_000,
  );
  return {
    evidenceKey: null,
    AND: [
      // ainda não minimizada: toda linha com dado da pessoa tem o hash do arquivo (ou do texto) ou o pHash
      { OR: [{ sha256: { not: null } }, { phash: { not: null } }] },
      {
        OR: [
          {
            createdAt: { lt: cacheLimit },
            verdict: {
              in: [
                ContentSafetyScanVerdict.CLEAN,
                ContentSafetyScanVerdict.GRAY,
                ContentSafetyScanVerdict.UNAVAILABLE,
              ],
            },
          },
          {
            createdAt: { lt: strikeLimit },
            verdict: {
              in: [
                ContentSafetyScanVerdict.HOLD,
                ContentSafetyScanVerdict.BLOCK,
              ],
            },
            strength: {
              in: [
                ContentSafetyStrength.NONE,
                ContentSafetyStrength.LIGHT,
                ContentSafetyStrength.MEDIUM,
              ],
            },
          },
        ],
      },
    ],
  };
}

export interface ScanRetentionSummary {
  minimized: number;
  skippedHeld: number;
}

@Injectable()
export class ScanRetentionCron {
  private readonly logger = new Logger(ScanRetentionCron.name);
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(SCAN_RETENTION_SCHEDULE)
  async minimize(now: Date = new Date()): Promise<ScanRetentionSummary | null> {
    if (this.running) return null;
    this.running = true;
    const summary: ScanRetentionSummary = { minimized: 0, skippedHeld: 0 };
    try {
      let cursor: string | null = null;
      for (let page = 0; page < RETENTION_MAX_PAGES; page++) {
        const rows: Array<{
          id: string;
          stage: ContentSafetyScanStage;
          generationId: string | null;
        }> = await this.prisma.contentSafetyScan.findMany({
          where: {
            ...expiredScansWhere(now),
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true, stage: true, generationId: true },
          orderBy: { id: 'asc' },
          take: RETENTION_PAGE,
        });
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;
        const held = await this.heldGenerationIds(rows);
        const eligible = rows.filter(
          (row) => !row.generationId || !held.has(row.generationId),
        );
        summary.skippedHeld += rows.length - eligible.length;
        summary.minimized += await this.minimizeRows(eligible);
        if (rows.length < RETENTION_PAGE) break;
      }
      if (summary.minimized > 0) {
        this.logger.log(
          `${summary.minimized} checagem(ns) minimizada(s) (hash, chave e sinais apagados; veredito mantido)`,
        );
      }
      return summary;
    } catch (error) {
      this.logger.error(
        `Minimização das checagens falhou: ${(error as Error).message?.slice(0, 200)}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  /** Gerações que seguram as linhas: ainda em revisão ou com evento de imagem sem liberação do jurídico. */
  private async heldGenerationIds(
    rows: ReadonlyArray<{ generationId: string | null }>,
  ): Promise<Set<string>> {
    const ids = [
      ...new Set(
        rows.map((row) => row.generationId).filter((id): id is string => !!id),
      ),
    ];
    if (ids.length === 0) return new Set();
    const [inReview, withEvidence] = await Promise.all([
      this.prisma.generation.findMany({
        where: { id: { in: ids }, status: GenerationStatus.IN_REVIEW },
        select: { id: true },
      }),
      this.prisma.contentSafetyEvent.findMany({
        where: {
          generationId: { in: ids },
          kind: { in: [...IMAGE_EVIDENCE_EVENT_KINDS] },
          releasedAt: null,
        },
        select: { generationId: true },
      }),
    ]);
    const held = new Set<string>();
    for (const row of inReview) held.add(row.id);
    for (const row of withEvidence) {
      if (row.generationId) held.add(row.generationId);
    }
    return held;
  }

  private async minimizeRows(
    rows: ReadonlyArray<{ id: string; stage: ContentSafetyScanStage }>,
  ): Promise<number> {
    const media = rows
      .filter((row) => MEDIA_STAGES.includes(row.stage))
      .map((row) => row.id);
    const text = rows
      .filter((row) => !MEDIA_STAGES.includes(row.stage))
      .map((row) => row.id);
    let count = 0;
    if (media.length) {
      count += (
        await this.prisma.contentSafetyScan.updateMany({
          where: { id: { in: media } },
          data: minimizedScanData('media'),
        })
      ).count;
    }
    if (text.length) {
      count += (
        await this.prisma.contentSafetyScan.updateMany({
          where: { id: { in: text } },
          data: minimizedScanData('text'),
        })
      ).count;
    }
    return count;
  }
}

/**
 * Exclusão LGPD sem guarda legal: as checagens da conta perdem hash, chave e sinais na hora (fica o veredito); a linha
 * com evidência guardada fica inteira (a liberação da evidência tem rito próprio). Usado pela exclusão de conta.
 */
export async function minimizeAccountScans(
  db: Pick<PrismaService, 'contentSafetyScan'>,
  userId: string,
): Promise<number> {
  const media = await db.contentSafetyScan.updateMany({
    where: { userId, evidenceKey: null, stage: { in: [...MEDIA_STAGES] } },
    data: minimizedScanData('media'),
  });
  const text = await db.contentSafetyScan.updateMany({
    where: {
      userId,
      evidenceKey: null,
      stage: ContentSafetyScanStage.TEXT,
    },
    data: minimizedScanData('text'),
  });
  return media.count + text.count;
}
