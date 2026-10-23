import { ContentReportStatus, GenerationStatus, Prisma } from '@prisma/client';
import {
  generationsCitedByReports,
  holdAccountEmail,
  minorBlockedGenerationIds,
  reportHoldsEvidence,
  type EvidenceCandidate,
  type HoldReport,
} from '../../users/account-erasure.service';
import { SAFETY_REVIEW_MARKER } from './review.helpers';

export { SAFETY_REVIEW_MARKER };

/** O que a máscara lê do banco (o PrismaService ou um cliente de teste). */
export type MaskingDb = Pick<
  Prisma.TransactionClient,
  'contentSafetyEvent' | 'contentSafetyScan' | 'contentReport' | 'communityPost'
>;

/** Geração de uma página do admin: o suficiente para saber se a mídia pode sair. */
export interface MaskableGeneration {
  id: string;
  userId: string;
  status: GenerationStatus | string;
  userAvatarId?: string | null;
  voiceProfileId?: string | null;
  /** dona (o e-mail entra na busca das denúncias que citam o perfil ou o e-mail) */
  user?: { id: string; email: string } | null;
}

const REPORT_PAGE = 500;
const IN_CHUNK = 500;

const HOLD_REPORT_SELECT = {
  id: true,
  category: true,
  status: true,
  target: true,
  description: true,
  isDepictedPerson: true,
  urgent: true,
  reporterUserId: true,
  reporterEmail: true,
  evidenceReleasedAt: true,
} satisfies Prisma.ContentReportSelect;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    chunks.push(items.slice(start, start + size));
  return chunks;
}

/** Denúncias que seguram evidência (menor, crime, íntima, pessoa retratada; não descartadas nem encerradas). */
export async function reportsHoldingEvidence(
  db: Pick<MaskingDb, 'contentReport'>,
): Promise<HoldReport[]> {
  const holding: HoldReport[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: HoldReport[] = await db.contentReport.findMany({
      where: {
        status: { not: ContentReportStatus.DISMISSED },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: HOLD_REPORT_SELECT,
      orderBy: { id: 'asc' },
      take: REPORT_PAGE,
    });
    for (const report of page)
      if (reportHoldsEvidence(report)) holding.push(report);
    if (page.length < REPORT_PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return holding;
}

/** Leitura das denúncias que seguram evidência (direta ou pelo cache curto do admin). */
export type HoldingReportsReader = (
  db: Pick<MaskingDb, 'contentReport'>,
) => Promise<HoldReport[]>;

/** Denúncias que mudam no máximo a cada tanto: a máscara de cada página do admin não pagina a tabela toda de novo. */
export const HOLDING_REPORTS_CACHE_MS = 60_000;

/**
 * Cache curto (60 s) das denúncias que seguram evidência. Leitura em andamento é compartilhada; erro não fica no cache
 * (a próxima página tenta de novo). Denúncia nova pode levar até 60 s para mascarar a página do admin.
 */
export function createHoldingReportsCache(
  ttlMs = HOLDING_REPORTS_CACHE_MS,
  now: () => number = Date.now,
): HoldingReportsReader {
  let cached: { at: number; reports: HoldReport[] } | null = null;
  let loading: Promise<HoldReport[]> | null = null;
  return async (db) => {
    if (cached && now() - cached.at < ttlMs) return cached.reports;
    if (!loading) {
      loading = reportsHoldingEvidence(db)
        .then((reports) => {
          cached = { at: now(), reports };
          return reports;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  };
}

export interface SafetyMaskOptions {
  /**
   * Lê também as checagens com evidência guardada (content_safety_scans, da checagem de imagem e texto). Padrão true;
   * com as duas checagens desligadas o admin passa false. A retenção legal da PR #4 (bloqueio por menor não liberado e
   * denúncia que segura evidência) e o IN_REVIEW valem sempre.
   */
  scans?: boolean;
  /** leitura das denúncias (padrão: direta, sem cache) */
  holdingReports?: HoldingReportsReader;
}

/**
 * Gerações de uma página do admin cuja mídia NÃO pode sair para o admin comum (camada 7; ECA, art. 241-B: só o revisor
 * designado vê, pela URL assinada de 120 s): em revisão (IN_REVIEW), com mídia na evidência (content_safety_scans),
 * com bloqueio por menor ou de imagem não liberado (a mesma régua da guarda legal da exclusão e do cron da galeria) ou
 * citadas por denúncia que segura evidência. Erro de leitura fecha: todas as da página ficam mascaradas.
 */
export async function safetyMaskedGenerationIds(
  db: MaskingDb,
  generations: readonly MaskableGeneration[],
  onError?: (error: unknown) => void,
  options: SafetyMaskOptions = {},
): Promise<Set<string>> {
  const masked = new Set<string>();
  if (generations.length === 0) return masked;
  for (const generation of generations) {
    if (generation.status === GenerationStatus.IN_REVIEW)
      masked.add(generation.id);
  }
  const ids = [...new Set(generations.map((generation) => generation.id))];
  try {
    for (const id of await minorBlockedGenerationIds(db, ids)) masked.add(id);
    if (options.scans !== false) {
      for (const part of chunk(ids)) {
        const rows = await db.contentSafetyScan.findMany({
          where: { generationId: { in: part }, evidenceKey: { not: null } },
          select: { generationId: true },
        });
        for (const row of rows)
          if (row.generationId) masked.add(row.generationId);
      }
    }
    const reports = await (options.holdingReports ?? reportsHoldingEvidence)(
      db,
    );
    if (reports.length > 0) {
      const posts = await db.communityPost.findMany({
        where: { generationId: { in: ids } },
        select: { id: true, generationId: true },
      });
      const candidates: EvidenceCandidate[] = generations.map((generation) => ({
        id: generation.id,
        userId: generation.userId,
        email: generation.user ? holdAccountEmail(generation.user) : null,
        userAvatarId: generation.userAvatarId ?? null,
        voiceProfileId: generation.voiceProfileId ?? null,
      }));
      for (const id of generationsCitedByReports(reports, candidates, posts))
        masked.add(id);
    }
  } catch (error) {
    onError?.(error);
    return new Set(ids);
  }
  return masked;
}
