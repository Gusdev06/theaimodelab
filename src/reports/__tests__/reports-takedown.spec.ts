import { BadRequestException, Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ContentReportCategory } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SafetyReviewerGuard } from '../../content-safety/reviewer/safety-reviewer.guard';
import { VICTIM_TAKEDOWN_WINDOW_MS } from '../../content-safety/takedown/takedown.deadline';
import type { TakedownService } from '../../content-safety/takedown/takedown.service';
import { ExecuteTakedownDto } from '../dto/takedown.dto';
import { buildUrgentDigest } from '../reports-alert-digest';
import { ReportsRateLimiter } from '../reports-rate-limiter';
import { ReportsTakedownController } from '../reports-takedown.controller';
import { ReportsService, toAdminReport, urgentReasons } from '../reports.service';

type Row = Record<string, unknown>;
const HOUR = 60 * 60_000;

function setup(opts: { accessLogFails?: boolean } = {}) {
  const rows: Row[] = [];
  const calls: Array<{ op: string; args: unknown }> = [];
  const prisma = {
    contentReport: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = {
          id: `rep-${rows.length + 1}`,
          status: 'OPEN',
          takedownDoneAt: null,
          evidenceReleasedAt: null,
          handledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = rows.find((r) => r.id === where.id) as Row;
        Object.assign(row, data);
        return { ...row };
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async (args: unknown) => {
        calls.push({ op: 'findMany', args });
        return rows.map((row) => ({ ...row }));
      }),
      count: jest.fn(async (args: unknown) => {
        calls.push({ op: 'count', args });
        return 1;
      }),
    },
    contentTakedownItem: {
      count: jest.fn(async (args: unknown) => {
        calls.push({ op: 'items.count', args });
        return 2;
      }),
    },
    contentSafetyAccessLog: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (opts.accessLogFails) throw new Error('banco fora do ar');
        return data;
      }),
    },
  };
  const email = { sendContentReportAlert: jest.fn(async () => true), sendRawEmail: jest.fn(async () => ({ id: 'x' })) };
  const config = { get: jest.fn((key: string) => (key === 'REPORTS_IP_SALT' ? 'chave' : undefined)) };
  const service = new ReportsService(prisma as never, email as never, config as never, new ReportsRateLimiter());
  return { service, prisma, rows, calls };
}

const base = { target: 'https://www.theaimodelab.com/p/abc', description: 'Sou eu nessa imagem, não autorizei.' };

describe('denúncia "sou a pessoa da imagem" (SELF_DEPICTED)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it('é urgente, é sempre a própria pessoa e grava o prazo de 48 h', async () => {
    const { service, rows } = setup();
    const before = Date.now();
    await service.create({ ...base, category: ContentReportCategory.SELF_DEPICTED, isDepictedPerson: false }, { ip: '203.0.113.1' });
    await service.drainAlerts();
    const row = rows[0];
    expect(row).toMatchObject({ category: 'SELF_DEPICTED', urgent: true, isDepictedPerson: true });
    const due = (row.takedownDueAt as Date).getTime();
    expect(due).toBeGreaterThanOrEqual(before + VICTIM_TAKEDOWN_WINDOW_MS);
    expect(due).toBeLessThanOrEqual(Date.now() + VICTIM_TAKEDOWN_WINDOW_MS);
    expect(urgentReasons({ ...base, category: ContentReportCategory.SELF_DEPICTED, isDepictedPerson: true })).toEqual([
      'category',
      'depicted_person',
    ]);
  });

  it.each([
    ['íntima sem consentimento pela própria pessoa', ContentReportCategory.NON_CONSENSUAL, true, true],
    ['íntima sem consentimento por terceiro', ContentReportCategory.NON_CONSENSUAL, false, false],
    ['menor de idade', ContentReportCategory.MINOR, false, false],
    ['direito autoral', ContentReportCategory.COPYRIGHT, true, false],
  ])('%s → prazo de vítima gravado: %s', async (_label, category, isDepictedPerson, hasDue) => {
    const { service, rows } = setup();
    await service.create({ ...base, category, isDepictedPerson }, {});
    await service.drainAlerts();
    expect(rows[0].takedownDueAt instanceof Date).toBe(hasDue);
  });

  it('a linha do admin traz o relógio da remoção', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    const row = {
      id: 'rep-1',
      category: 'SELF_DEPICTED',
      status: 'OPEN',
      target: 'x',
      description: 'y',
      isDepictedPerson: true,
      takedownDueAt: new Date(now.getTime() + 2 * HOUR),
      takedownDoneAt: null,
    };
    expect(toAdminReport(row as never, now).takedown).toEqual({
      dueAt: row.takedownDueAt.toISOString(),
      doneAt: null,
      remainingMs: 2 * HOUR,
      state: 'due_soon',
    });
    expect(toAdminReport({ ...row, takedownDueAt: null } as never, now).takedown).toBeNull();
  });

  it('o resumo de urgentes diz o que é o pedido da vítima', () => {
    const digest = buildUrgentDigest(
      [{ id: 'rep-1', category: ContentReportCategory.SELF_DEPICTED, target: 'x', description: 'y', createdAt: new Date(), reasons: ['category'] }],
      { adminUrl: null },
    );
    expect(digest.html).toContain('a própria pessoa da imagem pede a remoção');
  });

  describe('fila de remoções (cockpit)', () => {
    it('abertas: com prazo, sem remoção e não descartadas, pelo prazo mais próximo; contagens do radar', async () => {
      const { service, calls } = setup();
      const now = new Date('2026-10-22T12:00:00Z');
      const out = await service.takedownQueue('open', 1, 50, now);
      const open = { takedownDueAt: { not: null }, takedownDoneAt: null, status: { not: 'DISMISSED' } };
      expect(calls[0]).toEqual({ op: 'findMany', args: { where: open, orderBy: [{ takedownDueAt: 'asc' }], skip: 0, take: 50 } });
      expect(calls).toContainEqual({ op: 'count', args: { where: { ...open, takedownDueAt: { not: null, lt: now } } } });
      expect(calls).toContainEqual({
        op: 'count',
        args: { where: { ...open, takedownDueAt: { gte: now, lte: new Date(now.getTime() + 6 * HOUR) } } },
      });
      expect(calls).toContainEqual({ op: 'items.count', args: { where: { purgeStatus: { in: ['pending', 'failed'] } } } });
      expect(out).toMatchObject({ counts: { open: 1, overdue: 1, dueSoon: 1, purgePending: 2 }, now: now.toISOString() });
    });

    it.each([
      ['overdue', { takedownDueAt: { not: null, lt: expect.any(Date) }, takedownDoneAt: null, status: { not: 'DISMISSED' } }, [{ takedownDueAt: 'asc' }]],
      ['done', { takedownDueAt: { not: null }, takedownDoneAt: { not: null } }, [{ takedownDoneAt: 'desc' }]],
      ['all', { takedownDueAt: { not: null } }, [{ takedownDueAt: 'desc' }]],
    ] as const)('%s', async (state, where, orderBy) => {
      const { service, calls } = setup();
      await service.takedownQueue(state, 2, 10);
      expect(calls[0]).toEqual({ op: 'findMany', args: { where, orderBy, skip: 10, take: 10 } });
    });
  });

  describe('andamento do admin vai para a trilha do revisor', () => {
    it('grava quem, o quê (sem o texto da nota) e o IP', async () => {
      const { service, prisma, rows } = setup();
      rows.push({ id: 'rep-9', status: 'OPEN', category: 'OTHER', target: 'x', description: 'y', evidenceReleasedAt: null, handledAt: null });
      await service.update('rep-9', { status: 'ACTIONED', adminNote: 'texto sensível da nota' }, { id: 'admin-1', email: 'a@t.com', ip: '198.51.100.2' });
      expect(prisma.contentSafetyAccessLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 'admin-1',
          action: 'report_update',
          targetType: 'report',
          targetId: 'rep-9',
          reason: 'status OPEN → ACTIONED; nota alterada',
          ip: '198.51.100.2',
        },
      });
    });

    it('falha da trilha não desfaz a decisão gravada', async () => {
      const { service, rows } = setup({ accessLogFails: true });
      rows.push({ id: 'rep-9', status: 'OPEN', category: 'OTHER', target: 'x', description: 'y', evidenceReleasedAt: null, handledAt: null });
      await expect(service.update('rep-9', { status: 'IN_REVIEW' }, { id: 'admin-1', email: 'a@t.com' })).resolves.toMatchObject({
        status: 'IN_REVIEW',
      });
    });
  });
});

describe('ReportsTakedownController', () => {
  const reports = { takedownQueue: jest.fn(async () => ({ data: [] })) };
  const takedown = {
    execute: jest.fn(async () => ({ complete: true })),
    listItems: jest.fn(async (reportId: string) => ({ reportId, items: [] })),
  };
  const controller = new ReportsTakedownController(reports as unknown as ReportsService, takedown as unknown as TakedownService);

  it('fila: state padrão open; state desconhecido = 400', async () => {
    await controller.queue(1, 50);
    expect(reports.takedownQueue).toHaveBeenLastCalledWith('open', 1, 50);
    await controller.queue(1, 20, 'overdue');
    expect(reports.takedownQueue).toHaveBeenLastCalledWith('overdue', 1, 20);
    await expect(controller.queue(1, 50, 'toString')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('remoção leva o revisor (id e e-mail) e o IP real do x-forwarded-for', async () => {
    await controller.execute(
      'rep-1',
      { reason: 'pedido válido da própria pessoa', generationIds: undefined, preserveEvidence: true },
      { sub: 'revisor-1', email: 'r@t.com', role: 'ADMIN' },
      { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, ip: '10.0.0.2' },
    );
    expect(takedown.execute).toHaveBeenCalledWith({
      reportId: 'rep-1',
      generationIds: undefined,
      reason: 'pedido válido da própria pessoa',
      preserveEvidence: true,
      actor: { id: 'revisor-1', email: 'r@t.com' },
      ip: '203.0.113.9',
    });
  });

  it('remover e ver os arquivos exige o revisor designado; a fila (só texto e prazo) é do ADMIN', () => {
    const guardsOf = (method: keyof ReportsTakedownController) =>
      (Reflect.getMetadata(GUARDS_METADATA, ReportsTakedownController.prototype[method]) as unknown[] | undefined) ?? [];
    expect(guardsOf('execute')).toContain(SafetyReviewerGuard);
    expect(guardsOf('items')).toContain(SafetyReviewerGuard);
    expect(guardsOf('queue')).not.toContain(SafetyReviewerGuard);
  });
});

describe('ExecuteTakedownDto', () => {
  const check = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(ExecuteTakedownDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((error) => error.property);

  it('motivo de 10 a 1000 caracteres (aparado)', async () => {
    expect(await check({ reason: '   curto   ' })).toEqual(['reason']);
    expect(await check({ reason: 'pedido válido da própria pessoa' })).toEqual([]);
    expect(await check({ reason: 'x'.repeat(1001) })).toEqual(['reason']);
  });

  it('generationIds só com ids, até 50; preserveEvidence booleano', async () => {
    const reason = 'pedido válido da própria pessoa';
    expect(await check({ reason, generationIds: ['cgen000000000000000000001'] })).toEqual([]);
    expect(await check({ reason, generationIds: ['../../etc'] })).toEqual(['generationIds']);
    expect(await check({ reason, generationIds: Array.from({ length: 51 }, (_, i) => `cgen${String(i).padStart(21, '0')}`) })).toEqual([
      'generationIds',
    ]);
    expect(await check({ reason, preserveEvidence: 'sim' })).toEqual(['preserveEvidence']);
  });
});
