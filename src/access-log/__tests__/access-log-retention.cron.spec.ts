import { Logger } from '@nestjs/common';
import {
  ContentReportCategory,
  ContentReportStatus,
  ContentSafetyEventKind,
  GenerationStatus,
} from '@prisma/client';
import {
  loadAccessLogConfig,
  type AccessLogConfig,
} from '../access-log.config';
import {
  AccessLogRetentionCron,
  retentionCutoff,
} from '../access-log-retention.cron';

/**
 * Apagamento do registro de acesso depois de 6 meses, com a guarda legal da exclusão LGPD (a função real,
 * loadLegalHold) sobre um banco simulado em memória. Ids no formato cuid inventados; IPs de documentação.
 */

const NOW = new Date('2026-10-22T04:43:00.000Z');
const OLD = new Date('2026-03-01T12:00:00.000Z');
const RECENT = new Date('2026-10-01T12:00:00.000Z');

const id = (prefix: string, n: number) =>
  `c${prefix}${String(n).padStart(24 - prefix.length, '0')}`;

const PLAIN = id('usr', 1);
const IMAGE_HELD = id('usr', 2);
const REPORTED = id('usr', 3);
const EVIDENCE_ROWS = id('usr', 4);
const GONE = id('usr', 5);
const TEXT_ATTEMPTS = id('usr', 6);
const RELEASED = id('usr', 7);

const REPORTED_GEN = id('gen', 31);
const MINOR_GEN = id('gen', 41);
const REVIEW_GEN = id('gen', 42);
const PLAIN_GEN = id('gen', 43);

interface LogRow {
  id: string;
  userId: string | null;
  generationId: string | null;
  createdAt: Date;
}

interface EventRow {
  id: string;
  userId: string | null;
  kind: ContentSafetyEventKind;
  generationId: string | null;
  route: string;
  excerpt: string | null;
  releasedAt: Date | null;
  createdAt: Date;
}

interface ReportRow {
  id: string;
  category: ContentReportCategory;
  status: ContentReportStatus;
  target: string;
  description: string;
  isDepictedPerson: boolean | null;
  urgent: boolean | null;
  reporterUserId: string | null;
  reporterEmail: string | null;
  evidenceReleasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface Fixture {
  logs: LogRow[];
  users: Array<{ id: string; email: string }>;
  generations: Array<{ id: string; userId: string; status: GenerationStatus }>;
  events: EventRow[];
  reports: ReportRow[];
}

let logSeq = 0;
function log(
  userId: string | null,
  createdAt: Date,
  generationId: string | null = null,
): LogRow {
  logSeq++;
  return { id: id('log', logSeq), userId, generationId, createdAt };
}

function event(
  overrides: Partial<EventRow> & Pick<EventRow, 'userId' | 'kind'>,
): EventRow {
  return {
    id: id('evt', ++logSeq),
    generationId: null,
    route: 'POST /api/v1/generations/generate-image',
    excerpt: null,
    releasedAt: null,
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    ...overrides,
  };
}

function inList(value: unknown, list: unknown): boolean {
  return Array.isArray(list) && list.includes(value);
}

/** Banco simulado: só as consultas que o cron e a guarda legal fazem. */
function fakePrisma(data: Fixture) {
  const lt = (where: any): Date => where.createdAt.lt;
  const prisma: any = {
    accessLog: {
      findMany: jest.fn(async ({ where, take }: any) => {
        if (where.userId === null) {
          return data.logs
            .filter((row) => row.userId === null && row.createdAt < lt(where))
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, take)
            .map((row) => ({ id: row.id }));
        }
        const ids = new Set(
          data.logs
            .filter(
              (row) =>
                row.userId === where.userId &&
                row.createdAt < lt(where) &&
                row.generationId,
            )
            .map((row) => row.generationId),
        );
        return [...ids].map((generationId) => ({ generationId }));
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = data.logs.length;
        data.logs = data.logs.filter((row) => {
          if (row.createdAt >= lt(where)) return true;
          if (where.id)
            return !(inList(row.id, where.id.in) && row.userId === null);
          if (row.userId !== where.userId) return true;
          if (where.OR) {
            const notIn: string[] = where.OR[1].generationId.notIn;
            const deletable =
              row.generationId === null || !notIn.includes(row.generationId);
            return !deletable;
          }
          return false;
        });
        return { count: before - data.logs.length };
      }),
      groupBy: jest.fn(async ({ where, take }: any) => {
        const ids = new Set(
          data.logs
            .filter(
              (row) =>
                row.userId !== null &&
                row.createdAt < lt(where) &&
                (where.userId.gt === undefined || row.userId > where.userId.gt),
            )
            .map((row) => row.userId as string),
        );
        return [...ids]
          .sort()
          .slice(0, take)
          .map((userId) => ({ userId }));
      }),
    },
    user: {
      findUnique: jest.fn(
        async ({ where }: any) =>
          data.users.find((user) => user.id === where.id) ?? null,
      ),
    },
    generation: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.userId) {
          return data.generations
            .filter((row) => row.userId === where.userId)
            .map((row) => ({
              id: row.id,
              userAvatarId: null,
              voiceProfileId: null,
            }));
        }
        return data.generations
          .filter(
            (row) =>
              inList(row.id, where.id.in) &&
              (!where.status || row.status === where.status),
          )
          .map((row) => ({ id: row.id, userAvatarId: null, parameters: {} }));
      }),
    },
    communityPost: { findMany: jest.fn(async () => []) },
    userAvatar: { findMany: jest.fn(async () => []) },
    voiceProfile: { findMany: jest.fn(async () => []) },
    generationInputImage: { findMany: jest.fn(async () => []) },
    contentReport: {
      findMany: jest.fn(async ({ where, take }: any) => {
        const open = data.reports.filter(
          (report) => report.status !== ContentReportStatus.DISMISSED,
        );
        if (where.id?.in)
          return open.filter((report) => where.id.in.includes(report.id));
        const after = where.id?.gt;
        let rows = open.filter(
          (report) => after === undefined || report.id > after,
        );
        if (where.OR) {
          const since: Date = where.OR[0].createdAt.gte;
          rows = rows.filter(
            (report) => report.createdAt >= since || report.updatedAt >= since,
          );
        }
        return rows.sort((a, b) => a.id.localeCompare(b.id)).slice(0, take);
      }),
    },
    contentSafetyEvent: {
      findMany: jest.fn(async ({ where }: any) => {
        return data.events
          .filter((row) => {
            if (where.releasedAt === null && row.releasedAt !== null)
              return false;
            if (where.userId !== undefined && row.userId !== where.userId)
              return false;
            if (typeof where.kind === 'string' && row.kind !== where.kind)
              return false;
            if (where.kind?.in && !where.kind.in.includes(row.kind))
              return false;
            if (
              where.generationId?.in &&
              !where.generationId.in.includes(row.generationId)
            )
              return false;
            if (where.OR) {
              // cada parte: createdAt.gte ou route.startsWith (a janela de 90 dias, o provedor e o revisor)
              const hit = (where.OR as any[]).some((part) =>
                part.createdAt
                  ? row.createdAt >= part.createdAt.gte
                  : row.route.startsWith(part.route.startsWith),
              );
              if (!hit) return false;
            }
            return true;
          })
          .map((row) => ({ ...row }));
      }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(prisma),
  );
  return prisma;
}

function baseFixture(): Fixture {
  return {
    logs: [
      log(null, OLD),
      log(null, OLD),
      log(null, RECENT),
      log(PLAIN, OLD),
      log(PLAIN, OLD, PLAIN_GEN),
      log(PLAIN, RECENT),
      log(IMAGE_HELD, OLD),
      log(REPORTED, OLD, REPORTED_GEN),
      log(EVIDENCE_ROWS, OLD, MINOR_GEN),
      log(EVIDENCE_ROWS, OLD, REVIEW_GEN),
      log(EVIDENCE_ROWS, OLD),
      log(GONE, OLD),
      log(TEXT_ATTEMPTS, OLD),
      log(RELEASED, OLD),
    ],
    users: [
      PLAIN,
      IMAGE_HELD,
      REPORTED,
      EVIDENCE_ROWS,
      TEXT_ATTEMPTS,
      RELEASED,
    ].map((userId) => ({
      id: userId,
      email: `${userId}@example.com`,
    })),
    generations: [
      { id: PLAIN_GEN, userId: PLAIN, status: GenerationStatus.COMPLETED },
      {
        id: REPORTED_GEN,
        userId: REPORTED,
        status: GenerationStatus.COMPLETED,
      },
      { id: MINOR_GEN, userId: EVIDENCE_ROWS, status: GenerationStatus.FAILED },
      {
        id: REVIEW_GEN,
        userId: EVIDENCE_ROWS,
        status: GenerationStatus.IN_REVIEW,
      },
    ],
    events: [
      // foto com sinal de menor sem liberação: guarda a conta inteira (qualquer data)
      event({
        userId: IMAGE_HELD,
        kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
        createdAt: OLD,
      }),
      // 1 bloqueio de texto ligado à geração: a conta não fica sob guarda, mas a linha da geração fica
      event({
        userId: EVIDENCE_ROWS,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        generationId: MINOR_GEN,
        excerpt: 'a',
      }),
      // 3 tentativas distintas em 90 dias: guarda
      event({
        userId: TEXT_ATTEMPTS,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        excerpt: 'pedido um',
      }),
      event({
        userId: TEXT_ATTEMPTS,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        excerpt: 'pedido dois',
      }),
      event({
        userId: TEXT_ATTEMPTS,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        excerpt: 'pedido três',
      }),
      // liberado pelo jurídico: não segura nada
      event({
        userId: RELEASED,
        kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
        releasedAt: new Date('2026-09-10T00:00:00.000Z'),
      }),
    ],
    reports: [
      {
        id: id('rep', 1),
        category: ContentReportCategory.MINOR,
        status: ContentReportStatus.OPEN,
        target: `https://www.theaimodelab.com/gallery/${REPORTED_GEN}`,
        description: 'denúncia de teste',
        isDepictedPerson: null,
        urgent: true,
        reporterUserId: null,
        reporterEmail: null,
        evidenceReleasedAt: null,
        createdAt: OLD,
        updatedAt: OLD,
      },
    ],
  };
}

function setup(
  fixture: Fixture,
  config: AccessLogConfig = loadAccessLogConfig(() => undefined).config,
) {
  const prisma = fakePrisma(fixture);
  const cronLogger = {
    wrap: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn()),
  };
  const cron = new AccessLogRetentionCron(prisma, cronLogger as never, config);
  return { prisma, cron, cronLogger };
}

describe('retentionCutoff', () => {
  it.each([
    ['2026-10-22T04:43:00.000Z', 6, '2026-04-22T04:43:00.000Z'],
    // mês mais curto: prende no último dia, nunca empurra para março (o corte nunca encurta a guarda)
    ['2026-08-31T10:00:00.000Z', 6, '2026-02-28T10:00:00.000Z'],
    ['2028-08-31T10:00:00.000Z', 6, '2028-02-29T10:00:00.000Z'],
    ['2027-01-15T00:00:00.000Z', 6, '2026-07-15T00:00:00.000Z'],
    ['2026-10-22T04:43:00.000Z', 12, '2025-10-22T04:43:00.000Z'],
  ])('%s menos %i meses = %s', (now, months, expected) => {
    expect(retentionCutoff(new Date(now), months).toISOString()).toBe(expected);
  });
});

describe('AccessLogRetentionCron', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('apaga o que passou de 6 meses e nunca o que está sob guarda legal ou ligado a evidência', async () => {
    const fixture = baseFixture();
    const { cron, cronLogger } = setup(fixture);

    const summary = await cron.purge(NOW);

    expect(cronLogger.wrap).toHaveBeenCalledWith(
      expect.objectContaining({ cronName: 'AccessLogRetentionCron.purge' }),
      expect.any(Function),
    );
    expect(summary).toEqual({
      cutoff: '2026-04-22T04:43:00.000Z',
      // PLAIN (2) + EVIDENCE_ROWS sem geração (1) + GONE (1) + RELEASED (1)
      deleted: 5,
      anonymousDeleted: 2,
      accountsChecked: 7,
      // IMAGE_HELD, REPORTED e TEXT_ATTEMPTS
      accountsHeld: 3,
      accountsWithEvidence: 1,
      accountsFailed: 0,
      capped: false,
    });

    const left = (userId: string | null) =>
      fixture.logs.filter((row) => row.userId === userId);
    // o recente fica (sem conta e de conta comum)
    expect(left(null).map((row) => row.createdAt)).toEqual([RECENT]);
    expect(left(PLAIN).map((row) => row.createdAt)).toEqual([RECENT]);
    // guarda legal: nada sai
    expect(left(IMAGE_HELD)).toHaveLength(1);
    expect(left(REPORTED)).toHaveLength(1);
    expect(left(TEXT_ATTEMPTS)).toHaveLength(1);
    // sem guarda, mas a linha da geração em evidência e a da geração em revisão ficam
    expect(
      left(EVIDENCE_ROWS)
        .map((row) => row.generationId)
        .sort(),
    ).toEqual([MINOR_GEN, REVIEW_GEN].sort());
    // conta apagada de vez e evento liberado: o prazo vale
    expect(left(GONE)).toHaveLength(0);
    expect(left(RELEASED)).toHaveLength(0);
  });

  it('caso de texto confirmado pelo revisor (1 só, de mais de 90 dias): nenhuma linha da conta sai, nem as sem geração', async () => {
    const CONFIRMED = id('usr', 8);
    const fixture = baseFixture();
    fixture.users.push({ id: CONFIRMED, email: `${CONFIRMED}@example.com` });
    fixture.logs.push(log(CONFIRMED, OLD), log(CONFIRMED, OLD));
    fixture.events.push(
      event({
        userId: CONFIRMED,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        route: 'review:text',
        createdAt: new Date('2026-03-20T12:00:00.000Z'),
      }),
    );
    const { cron } = setup(fixture);

    const summary = await cron.purge(NOW);

    expect(fixture.logs.filter((row) => row.userId === CONFIRMED)).toHaveLength(
      2,
    );
    // IMAGE_HELD, REPORTED, TEXT_ATTEMPTS e a conta do caso confirmado
    expect(summary?.accountsHeld).toBe(4);
  });

  it('caso confirmado e depois liberado pelo revisor: volta à regra comum e as linhas vencidas saem', async () => {
    const CONFIRMED = id('usr', 9);
    const fixture = baseFixture();
    fixture.users.push({ id: CONFIRMED, email: `${CONFIRMED}@example.com` });
    fixture.logs.push(log(CONFIRMED, OLD));
    fixture.events.push(
      event({
        userId: CONFIRMED,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        route: 'review:text',
        createdAt: new Date('2026-03-20T12:00:00.000Z'),
        releasedAt: new Date('2026-04-01T12:00:00.000Z'),
      }),
    );
    const { cron } = setup(fixture);
    await cron.purge(NOW);
    expect(fixture.logs.filter((row) => row.userId === CONFIRMED)).toHaveLength(
      0,
    );
  });

  it('a guarda é conferida dentro da transação do apagamento, conta a conta', async () => {
    const { cron, prisma } = setup(baseFixture());
    await cron.purge(NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(7);
  });

  it('a denúncia descartada não segura mais a conta', async () => {
    const fixture = baseFixture();
    fixture.reports[0].status = ContentReportStatus.DISMISSED;
    const { cron } = setup(fixture);
    await cron.purge(NOW);
    expect(fixture.logs.filter((row) => row.userId === REPORTED)).toHaveLength(
      0,
    );
  });

  it('guarda maior no env (a autoridade pediu mais tempo): o corte recua', async () => {
    const fixture = baseFixture();
    const config = loadAccessLogConfig((key) =>
      key === 'ACCESS_LOG_RETENTION_MONTHS' ? '12' : undefined,
    ).config;
    const { cron } = setup(fixture, config);
    const summary = await cron.purge(NOW);
    expect(summary?.cutoff).toBe('2025-10-22T04:43:00.000Z');
    expect(summary?.deleted).toBe(0);
    expect(summary?.anonymousDeleted).toBe(0);
  });

  it('falha na conferência de uma conta: nada dela sai, as outras seguem', async () => {
    const fixture = baseFixture();
    const { cron, prisma } = setup(fixture);
    const original = prisma.user.findUnique.getMockImplementation();
    prisma.user.findUnique.mockImplementation(async (args: any) => {
      if (args.where.id === PLAIN)
        throw Object.assign(new Error('timeout'), { code: 'P2028' });
      return original(args);
    });
    const summary = await cron.purge(NOW);
    expect(summary?.accountsFailed).toBe(1);
    expect(fixture.logs.filter((row) => row.userId === PLAIN)).toHaveLength(3);
    expect(fixture.logs.filter((row) => row.userId === GONE)).toHaveLength(0);
  });

  it('banco fora: a rodada termina sem lançar e não apaga nada', async () => {
    const fixture = baseFixture();
    const { cron, prisma } = setup(fixture);
    prisma.accessLog.findMany.mockRejectedValue(new Error('banco fora'));
    await expect(cron.purge(NOW)).resolves.toBeNull();
    expect(prisma.accessLog.deleteMany).not.toHaveBeenCalled();
  });

  it('rodada em andamento: a segunda chamada não roda junto', async () => {
    const { cron } = setup(baseFixture());
    const first = cron.purge(NOW);
    await expect(cron.purge(NOW)).resolves.toBeNull();
    await expect(first).resolves.not.toBeNull();
  });

  it('nada vencido: nenhuma escrita', async () => {
    const fixture = baseFixture();
    fixture.logs = fixture.logs.filter((row) => row.createdAt === RECENT);
    const { cron, prisma } = setup(fixture);
    const summary = await cron.purge(NOW);
    expect(summary).toEqual(
      expect.objectContaining({
        deleted: 0,
        anonymousDeleted: 0,
        accountsChecked: 0,
      }),
    );
    expect(prisma.accessLog.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
