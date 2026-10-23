import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ContentReportStatus, GenerationStatus } from '@prisma/client';
import { CronLoggerService } from '../cron/cron-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  createAccountMatcher,
  holdAccountEmail,
  loadLegalHold,
  minorBlockedGenerationIds,
  readHoldAccount,
  type HoldAccount,
  type HoldReport,
  type LegalHoldDb,
} from '../users/account-erasure.service';
import { ACCESS_LOG_CONFIG, type AccessLogConfig } from './access-log.config';

/**
 * Apagamento do registro de acesso depois da guarda (Marco Civil, art. 15: 6 meses; ACCESS_LOG_RETENTION_MONTHS só
 * aumenta). Nunca apaga:
 *  - nada de conta sob guarda legal, pela MESMA regra da exclusão LGPD (loadLegalHold: denúncia de menor, crime ou
 *    imagem íntima citando a conta, recusa do provedor ou checagem de imagem com mídia da conta, 3+ tentativas por
 *    menor em 90 dias), conferida dentro da transação do apagamento;
 *  - a linha ligada a geração que é evidência (bloqueio por menor ou de imagem sem liberação do jurídico) ou que ainda
 *    está em revisão (IN_REVIEW), mesmo sem a conta estar sob guarda.
 * Linha sem conta (tentativa de entrada que falhou) sai no prazo. Roda em qualquer modo da trava de imagem.
 */

export const ACCESS_LOG_RETENTION_SCHEDULE = '43 4 * * *';
const CRON_NAME = 'AccessLogRetentionCron.purge';
/** Contas por página e teto de páginas por rodada (o que sobrar fica para a próxima). */
const ACCOUNT_PAGE = 200;
const MAX_ACCOUNT_PAGES = 50;
/** Linhas sem conta apagadas por lote, e teto de lotes por rodada. */
const ANONYMOUS_BATCH = 5_000;
const MAX_ANONYMOUS_BATCHES = 40;
const REPORT_PAGE = 1_000;
const IN_CHUNK = 1_000;
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 };

/**
 * Corte da guarda: o mesmo dia e hora, `months` meses de calendário antes, em UTC. Mês mais curto prende no último dia
 * (31/08 menos 6 meses = 28/02), nunca empurra para março: o corte nunca fica depois do prazo mínimo.
 */
export function retentionCutoff(now: Date, months: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(now.getUTCDate(), lastDay),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

export type AccessLogRetentionSummary = {
  cutoff: string;
  /** linhas de contas apagadas */
  deleted: number;
  /** linhas sem conta (tentativas de entrada que falharam) apagadas */
  anonymousDeleted: number;
  accountsChecked: number;
  /** contas sob guarda legal: nenhuma linha delas saiu */
  accountsHeld: number;
  /** contas sem guarda com linha ligada a geração em evidência ou em revisão (essas linhas ficaram) */
  accountsWithEvidence: number;
  /** conta cuja conferência falhou: nada dela saiu nesta rodada */
  accountsFailed: number;
  /** a rodada parou num teto: o resto fica para a próxima */
  capped: boolean;
};

type ReportCandidate = Pick<HoldReport, 'id' | 'target' | 'description'>;

/** O que a conferência de uma conta usa do banco (o PrismaService ou o cliente da transação). */
type RetentionDb = LegalHoldDb & Pick<PrismaService, 'accessLog' | 'user'>;

/** Ids das denúncias (entre as já lidas) que citam a conta: a 1ª passada da guarda, com a leitura feita uma vez. */
export function reportsCitingAccount(
  reports: readonly ReportCandidate[],
  account: HoldAccount,
): string[] {
  const match = createAccountMatcher(account);
  return reports
    .filter((report) => match(report) !== null)
    .map((report) => report.id);
}

@Injectable()
export class AccessLogRetentionCron {
  private readonly logger = new Logger(AccessLogRetentionCron.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cronLogger: CronLoggerService,
    @Inject(ACCESS_LOG_CONFIG) private readonly config: AccessLogConfig,
  ) {}

  @Cron(ACCESS_LOG_RETENTION_SCHEDULE)
  async purge(
    now: Date = new Date(),
  ): Promise<AccessLogRetentionSummary | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.cronLogger.wrap(
        { cronName: CRON_NAME, schedule: ACCESS_LOG_RETENTION_SCHEDULE },
        async () => {
          const summary = await this.run(now);
          if (
            summary.deleted ||
            summary.anonymousDeleted ||
            summary.accountsHeld
          ) {
            this.logger.log(
              `registro de acesso: ${summary.deleted + summary.anonymousDeleted} linha(s) com mais de ` +
                `${this.config.retentionMonths} meses apagada(s); ${summary.accountsHeld} conta(s) sob guarda legal mantida(s)`,
            );
          }
          if (summary.accountsFailed) {
            this.logger.warn(
              `registro de acesso: ${summary.accountsFailed} conta(s) sem conferência da guarda nesta rodada (nada delas saiu)`,
            );
          }
          return summary;
        },
      );
    } catch (error) {
      this.logger.error(
        `Apagamento do registro de acesso falhou: ${errorLabel(error)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  async run(now: Date): Promise<AccessLogRetentionSummary> {
    const cutoff = retentionCutoff(now, this.config.retentionMonths);
    const summary: AccessLogRetentionSummary = {
      cutoff: cutoff.toISOString(),
      deleted: 0,
      anonymousDeleted: 0,
      accountsChecked: 0,
      accountsHeld: 0,
      accountsWithEvidence: 0,
      accountsFailed: 0,
      capped: false,
    };

    summary.capped = await this.purgeAnonymous(cutoff, summary);

    // as denúncias são lidas uma vez por rodada; dentro da transação de cada conta a guarda relê as candidatas e as
    // criadas ou alteradas desde o começo desta leitura (recheckReportsCitingAccount)
    const scanStartedAt = new Date();
    const reports = await this.readReports();

    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= MAX_ACCOUNT_PAGES) {
        summary.capped = true;
        break;
      }
      const userIds = await this.expiredAccountPage(cutoff, cursor);
      if (userIds.length === 0) break;
      for (const userId of userIds) {
        summary.accountsChecked++;
        try {
          const outcome = await this.purgeAccount(
            userId,
            cutoff,
            now,
            reports,
            scanStartedAt,
          );
          if (outcome.held) summary.accountsHeld++;
          if (outcome.evidence) summary.accountsWithEvidence++;
          summary.deleted += outcome.deleted;
        } catch (error) {
          // na dúvida, fica: a conta volta na próxima rodada
          summary.accountsFailed++;
          this.logger.warn(
            `registro de acesso: conferência da guarda da conta ${userId} falhou (${errorLabel(error)}); nada dela saiu`,
          );
        }
      }
      cursor = userIds[userIds.length - 1];
      if (userIds.length < ACCOUNT_PAGE) break;
    }
    return summary;
  }

  /** Uma página de contas (em ordem de id, depois do cursor) com linha vencida. */
  private async expiredAccountPage(
    cutoff: Date,
    cursor: string | null,
  ): Promise<string[]> {
    const groups = await this.prisma.accessLog.groupBy({
      by: ['userId'],
      where: {
        createdAt: { lt: cutoff },
        userId: cursor ? { gt: cursor } : { not: null },
      },
      orderBy: { userId: 'asc' },
      take: ACCOUNT_PAGE,
    });
    return groups
      .map((group) => group.userId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  /** Linhas sem conta: nenhuma guarda se aplica. Devolve true quando parou no teto de lotes. */
  private async purgeAnonymous(
    cutoff: Date,
    summary: AccessLogRetentionSummary,
  ): Promise<boolean> {
    for (let batch = 0; batch < MAX_ANONYMOUS_BATCHES; batch++) {
      const rows = await this.prisma.accessLog.findMany({
        where: { userId: null, createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: ANONYMOUS_BATCH,
      });
      if (rows.length === 0) return false;
      const result = await this.prisma.accessLog.deleteMany({
        where: {
          id: { in: rows.map((row) => row.id) },
          userId: null,
          createdAt: { lt: cutoff },
        },
      });
      summary.anonymousDeleted += result.count;
      if (rows.length < ANONYMOUS_BATCH) return false;
    }
    return true;
  }

  /** Denúncias não descartadas (a mesma leitura da 1ª passada da exclusão LGPD), em páginas. */
  private async readReports(): Promise<ReportCandidate[]> {
    const reports: ReportCandidate[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: ReportCandidate[] = await this.prisma.contentReport.findMany({
        where: {
          status: { not: ContentReportStatus.DISMISSED },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, target: true, description: true },
        orderBy: { id: 'asc' },
        take: REPORT_PAGE,
      });
      reports.push(...page);
      if (page.length < REPORT_PAGE) break;
      cursor = page[page.length - 1].id;
    }
    return reports;
  }

  /**
   * Uma conta, numa transação: guarda legal conferida com os dados de agora e, sem guarda, apaga as linhas vencidas,
   * menos as ligadas a geração em evidência ou em revisão.
   */
  private purgeAccount(
    userId: string,
    cutoff: Date,
    now: Date,
    reports: readonly ReportCandidate[],
    scanStartedAt: Date,
  ): Promise<{ held: boolean; evidence: boolean; deleted: number }> {
    return this.prisma.$transaction(async (tx) => {
      const db = tx as unknown as RetentionDb;
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });
      const account = await readHoldAccount(
        db,
        userId,
        user ? holdAccountEmail(user) : null,
      );
      const hold = await loadLegalHold(db, {
        account,
        scan: {
          candidateIds: reportsCitingAccount(reports, account),
          startedAt: scanStartedAt,
        },
        now,
        ignoreSafetyEvents: false,
      });
      if (hold.active) return { held: true, evidence: false, deleted: 0 };

      const kept = await this.evidenceGenerationIds(db, userId, cutoff);
      const result = await db.accessLog.deleteMany({
        where: {
          userId,
          createdAt: { lt: cutoff },
          ...(kept.length
            ? {
                OR: [{ generationId: null }, { generationId: { notIn: kept } }],
              }
            : {}),
        },
      });
      return { held: false, evidence: kept.length > 0, deleted: result.count };
    }, TRANSACTION_OPTIONS);
  }

  /** Gerações das linhas vencidas da conta que seguram a linha: evidência sem liberação ou ainda em revisão. */
  private async evidenceGenerationIds(
    db: RetentionDb,
    userId: string,
    cutoff: Date,
  ): Promise<string[]> {
    const rows = await db.accessLog.findMany({
      where: { userId, createdAt: { lt: cutoff }, generationId: { not: null } },
      select: { generationId: true },
      distinct: ['generationId'],
    });
    const ids = rows
      .map((row) => row.generationId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return [];
    const kept = await minorBlockedGenerationIds(db, ids);
    for (let start = 0; start < ids.length; start += IN_CHUNK) {
      const inReview = await db.generation.findMany({
        where: {
          id: { in: ids.slice(start, start + IN_CHUNK) },
          status: GenerationStatus.IN_REVIEW,
        },
        select: { id: true },
      });
      for (const row of inReview) kept.add(row.id);
    }
    return [...kept];
  }
}

function errorLabel(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code))
      return code;
  }
  return error instanceof Error
    ? error.message.slice(0, 200)
    : 'erro desconhecido';
}
