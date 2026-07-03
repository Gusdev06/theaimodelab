import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CronSummary {
  cronName: string;
  schedule: string;
  scheduleHuman: string;
  nextRunAt: string | null;
  totalExecutions: number;
  successCount: number;
  errorCount: number;
  runningCount: number;
  lastExecution: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
    metadata: unknown;
  } | null;
  avgDurationMs: number | null;
}

export interface CronExecutionItem {
  id: string;
  cronName: string;
  schedule: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  metadata: unknown;
}

@Injectable()
export class AdminCronsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lista todos os crons que já rodaram pelo menos uma vez, agregando
   * último status, contagens e próxima execução estimada.
   */
  async listCrons(): Promise<CronSummary[]> {
    // Agrega contagens e último execution_id por cronName
    const grouped = await this.prisma.cronExecution.groupBy({
      by: ['cronName', 'schedule'],
      _count: { _all: true },
      _avg: { durationMs: true },
      _max: { startedAt: true },
    });

    if (grouped.length === 0) return [];

    // Pra cada grupo, busca o último execution completo + contagens por status
    const summaries: CronSummary[] = [];
    for (const g of grouped) {
      const [lastExec, byStatus] = await Promise.all([
        this.prisma.cronExecution.findFirst({
          where: { cronName: g.cronName },
          orderBy: { startedAt: 'desc' },
        }),
        this.prisma.cronExecution.groupBy({
          by: ['status'],
          where: { cronName: g.cronName },
          _count: { _all: true },
        }),
      ]);

      const successCount = byStatus.find((s) => s.status === 'SUCCESS')?._count._all ?? 0;
      const errorCount = byStatus.find((s) => s.status === 'ERROR')?._count._all ?? 0;
      const runningCount = byStatus.find((s) => s.status === 'RUNNING')?._count._all ?? 0;

      summaries.push({
        cronName: g.cronName,
        schedule: g.schedule,
        scheduleHuman: this.describeSchedule(g.schedule),
        nextRunAt: this.nextRun(g.schedule)?.toISOString() ?? null,
        totalExecutions: g._count._all,
        successCount,
        errorCount,
        runningCount,
        avgDurationMs: g._avg.durationMs !== null ? Math.round(g._avg.durationMs) : null,
        lastExecution: lastExec
          ? {
              id: lastExec.id,
              status: lastExec.status,
              startedAt: lastExec.startedAt.toISOString(),
              finishedAt: lastExec.finishedAt?.toISOString() ?? null,
              durationMs: lastExec.durationMs,
              error: lastExec.error,
              metadata: lastExec.metadata,
            }
          : null,
      });
    }

    return summaries.sort((a, b) => a.cronName.localeCompare(b.cronName));
  }

  /**
   * Histórico paginado de execuções de um cron específico (ou todos).
   */
  async getExecutions(opts: {
    cronName?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: CronExecutionItem[]; total: number; page: number; limit: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));

    const where: any = {};
    if (opts.cronName) where.cronName = opts.cronName;
    if (opts.status) where.status = opts.status;

    const [items, total] = await Promise.all([
      this.prisma.cronExecution.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.cronExecution.count({ where }),
    ]);

    return {
      items: items.map((i) => ({
        id: i.id,
        cronName: i.cronName,
        schedule: i.schedule,
        status: i.status,
        startedAt: i.startedAt.toISOString(),
        finishedAt: i.finishedAt?.toISOString() ?? null,
        durationMs: i.durationMs,
        error: i.error,
        metadata: i.metadata,
      })),
      total,
      page,
      limit,
    };
  }

  // ─────────────────────────────────────────
  // CRON PARSER MINIMALISTA (cobre os schedules usados no projeto)
  //   * * * * *    (todo minuto)
  //   */N * * * *  (a cada N minutos)
  //   0 * * * *    (a cada hora cheia)
  //   0 H * * *    (diariamente à hora H)
  //   0 H,H * * *  (diariamente às horas H1 e H2)
  // ─────────────────────────────────────────

  private nextRun(schedule: string, from = new Date()): Date | null {
    try {
      const parts = schedule.trim().split(/\s+/);
      if (parts.length !== 5) return null;
      const [minute, hour] = parts;

      const candidate = new Date(from);
      candidate.setUTCSeconds(0, 0);
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

      // Tenta até 366 dias à frente (suficiente pra qualquer schedule sensato)
      for (let i = 0; i < 366 * 24 * 60; i++) {
        if (this.matches(candidate, minute, hour)) return candidate;
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
      }
      return null;
    } catch {
      return null;
    }
  }

  private matches(d: Date, minutePattern: string, hourPattern: string): boolean {
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    return this.fieldMatches(minute, minutePattern) && this.fieldMatches(hour, hourPattern);
  }

  private fieldMatches(value: number, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern.startsWith('*/')) {
      const step = parseInt(pattern.slice(2), 10);
      return step > 0 && value % step === 0;
    }
    if (pattern.includes(',')) {
      return pattern.split(',').some((p) => parseInt(p, 10) === value);
    }
    return parseInt(pattern, 10) === value;
  }

  private describeSchedule(schedule: string): string {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return schedule;
    const [m, h] = parts;

    if (m === '*' && h === '*') return 'A cada minuto';
    if (m.startsWith('*/') && h === '*') return `A cada ${m.slice(2)} minutos`;
    if (m === '0' && h === '*') return 'A cada hora (em ponto)';
    if (m === '0' && /^\d+$/.test(h)) return `Diariamente às ${h.padStart(2, '0')}:00 UTC`;
    if (m === '0' && h.includes(',')) {
      const hours = h.split(',').map((x) => `${x.padStart(2, '0')}:00`).join(' e ');
      return `Diariamente às ${hours} UTC`;
    }
    return schedule;
  }
}
