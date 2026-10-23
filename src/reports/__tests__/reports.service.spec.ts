import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ContentReportCategory, Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createHmac } from 'node:crypto';
import { UpdateReportDto, type CreateReportDto } from '../dto/create-report.dto';
import { buildUrgentDigest, DIGEST_LIST_MAX, type DigestReport } from '../reports-alert-digest';
import {
  REPORTS_CONTACT_EMAIL,
  REPORTS_LIMITS,
  ReportsRateLimitedException,
  ReportsRateLimiter,
  type ReportsLimits,
} from '../reports-rate-limiter';
import {
  ALERT_CLAIM_STALE_MS,
  ALERT_DIGEST_QUEUED,
  ALERT_MAX_ATTEMPTS,
  ALERT_NO_RECIPIENT,
  ALERT_RETRY_BACKOFF_MS,
  ALERT_RETRY_MAX_AGE_MS,
  ALERT_RETRY_MIN_AGE_MS,
  ALERT_SENDING,
  alertRetryDelayMs,
  fakeReportId,
  isUrgentReport,
  reportLane,
  ReportsService,
  toAdminReport,
  urgentReasons,
} from '../reports.service';

type Env = Partial<Record<'REPORTS_ALERT_EMAIL' | 'REPORTS_IP_SALT' | 'NODE_ENV' | 'REPORTS_ADMIN_URL', string>>;
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type RawEmail = { to: string; subject: string; html: string };

/** Instante em que as denúncias do teste são gravadas. */
const CREATED_AT = new Date('2026-10-15T12:00:00Z');
const MIN = 60_000;

const numeric = (value: unknown): number => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : NaN);

/**
 * Filtro do Prisma no banco de mentira: igualdade (null casa com ausente), { in, notIn } (NULL NOT IN = fora, como no
 * SQL), { gte, lte, lt } em data ou número e OR.
 */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((inner) => matches(row, inner));
    const value = row[key] ?? null;
    if (cond === null || typeof cond !== 'object') return value === cond;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    const ops = cond as { in?: unknown[]; notIn?: unknown[]; gte?: unknown; lte?: unknown; lt?: unknown };
    if (ops.in && !ops.in.includes(value)) return false;
    if (ops.notIn && (value === null || ops.notIn.includes(value))) return false;
    if (ops.gte !== undefined && !(numeric(value) >= numeric(ops.gte))) return false;
    if (ops.lte !== undefined && !(numeric(value) <= numeric(ops.lte))) return false;
    if (ops.lt !== undefined && !(numeric(value) < numeric(ops.lt))) return false;
    return true;
  });
}

/** Aplica o `data` do Prisma na linha ({ increment } soma). */
function apply(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === 'object' && 'increment' in value
      ? Number(row[key] ?? 0) + Number((value as { increment: number }).increment)
      : value;
  }
}

/** Modos da checagem e revisores (IMAGE_SAFETY_CONFIG); ausente = sem a trava do revisor (como hoje em produção). */
type SafetyGate = { imageMode: 'off' | 'shadow' | 'enforce'; textMode: 'off' | 'shadow' | 'enforce'; reviewerIds: Set<string> };

function setup(
  opts: {
    env?: Env;
    alert?: boolean | Error | 'pendente';
    digest?: 'ok' | 'sem-id' | Error;
    rows?: Row[];
    limits?: ReportsLimits;
    safety?: SafetyGate;
  } = {},
) {
  const created: Row[] = [];
  /** o "banco": denúncias gravadas e as que o teste põe direto (ex.: gravadas antes de um reinício) */
  const rows: Row[] = [...(opts.rows ?? [])];
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const claims: Array<{ where: Where; data: Record<string, unknown>; count: number }> = [];
  const prisma = {
    contentReport: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `rep-${created.length + 1}`,
          status: 'OPEN',
          alertSentAt: null,
          alertError: null,
          alertAttempts: 0,
          evidenceReleasedAt: null,
          evidenceReleasedBy: null,
          adminNote: null,
          handledBy: null,
          handledAt: null,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          ...data,
        };
        created.push(row);
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: Where & { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        const row = rows.find((r) => matches(r, where));
        if (row) apply(row, data);
        else if (Object.keys(where).length > 1) {
          // where com mais que o id (andamento do admin): nenhuma linha casa = o Prisma lança P2025
          throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'teste' });
        }
        return row ? { ...row } : { id: where.id, ...data };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const row of hit) apply(row, data);
        claims.push({ where, data, count: hit.length });
        return { count: hit.length };
      }),
      findMany: jest.fn(async (args?: { where?: Where; take?: number }): Promise<Row[]> => {
        const where = args?.where;
        if (!where || !('urgent' in where)) return [];
        return rows
          .filter((r) => matches(r, where))
          .sort((a, b) => numeric(a.createdAt) - numeric(b.createdAt))
          .slice(0, args?.take)
          .map((r) => ({ ...r }));
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row } : null;
      }),
      count: jest.fn(async () => 0),
    },
    // trilha do revisor (só acréscimo): o andamento do admin grava uma linha
    contentSafetyAccessLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'log-1', ...data })) },
  };
  // transação simulada no mesmo "banco": liberar a evidência grava a trilha junto com o andamento
  Object.assign(prisma, { $transaction: jest.fn(async (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma)) });
  let release: (sent: boolean) => void = () => undefined;
  const digests: RawEmail[] = [];
  const email = {
    sendContentReportAlert: jest.fn((): Promise<boolean> => {
      if (opts.alert === 'pendente') return new Promise<boolean>((resolve) => (release = resolve));
      if (opts.alert instanceof Error) return Promise.reject(opts.alert);
      return Promise.resolve(opts.alert ?? true);
    }),
    sendRawEmail: jest.fn(async (params: RawEmail): Promise<{ id: string | null }> => {
      if (opts.digest instanceof Error) throw opts.digest;
      digests.push(params);
      return { id: opts.digest === 'sem-id' ? null : `resumo-${digests.length}` };
    }),
  };
  const env: Env = { REPORTS_IP_SALT: 'chave-de-teste', ...opts.env };
  const config = { get: jest.fn((key: keyof Env) => env[key]) };
  const limiter = new ReportsRateLimiter(Date.now, opts.limits ?? REPORTS_LIMITS);
  const service = new ReportsService(prisma as never, email as never, config as never, limiter, (opts.safety ?? null) as never);
  return { service, prisma, email, env, created, rows, updates, claims, digests, limiter, release: (sent: boolean) => release(sent) };
}

const base = { target: 'https://www.theaimodelab.com/p/abc', description: 'Esta imagem usa o meu rosto sem autorização.' };
const dto = (extra: Partial<CreateReportDto> & { category: ContentReportCategory }): CreateReportDto => ({ ...base, ...extra });
const CUID = /^c[0-9a-z]{24}$/;
/** IP inventado diferente a cada pedido (X-Forwarded-For forjado por quem chama o VPS direto) */
const forged = (i: number) => `10.${Math.floor(i / 62_500) % 250}.${Math.floor(i / 250) % 250}.${i % 250}`;
const sweep = (over: Partial<Record<'sent' | 'failed' | 'skipped' | 'digested' | 'waiting', number>> = {}) => ({
  sent: 0, failed: 0, skipped: 0, digested: 0, waiting: 0, ...over,
});

describe('ReportsService', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('urgência', () => {
    it.each([
      ['categoria menor', { category: ContentReportCategory.MINOR }, true],
      ['categoria imagem íntima sem consentimento', { category: ContentReportCategory.NON_CONSENSUAL }, true],
      ['a própria pessoa denunciando imagem íntima', { category: ContentReportCategory.NON_CONSENSUAL, isDepictedPerson: true }, true],
      ['a própria pessoa denunciando uso da imagem dela', { category: ContentReportCategory.IMPERSONATION, isDepictedPerson: true }, true],
      ['uso de imagem sem a própria pessoa denunciando', { category: ContentReportCategory.IMPERSONATION }, false],
      ['"sou a pessoa" em OTHER não força 24 h', { category: ContentReportCategory.OTHER, isDepictedPerson: true }, false],
      ['"sou a pessoa" em direito autoral não força 24 h', { category: ContentReportCategory.COPYRIGHT, isDepictedPerson: true }, false],
      ['"sou a pessoa" em ILLEGAL não força 24 h', { category: ContentReportCategory.ILLEGAL, isDepictedPerson: true }, false],
      ['descrição que cita menor', { category: ContentReportCategory.OTHER, description: 'A imagem mostra uma garota de 15 anos.' }, true],
      [
        '"sou a pessoa" em OTHER com descrição que cita menor',
        { category: ContentReportCategory.OTHER, isDepictedPerson: true, description: 'Sou eu nessa foto, eu tinha 16 anos.' },
        true,
      ],
      ['descrição com termo de menor', { category: ContentReportCategory.ILLEGAL, description: 'Conteúdo com uma novinha, por favor removam.' }, true],
      ['alvo que cita menor', { category: ContentReportCategory.IMPERSONATION, target: 'https://x.com/p/teen-schoolgirl-pack' }, true],
      ['direito autoral comum', { category: ContentReportCategory.COPYRIGHT }, false],
      ['adulto citado', { category: ContentReportCategory.IMPERSONATION, description: 'Usaram a foto de uma mulher de 30 anos sem permissão.' }, false],
    ])('%s → %s', (_label, input, expected) => {
      expect(isUrgentReport({ ...base, ...input })).toBe(expected);
      // os motivos seguem a mesma regra: urgente = pelo menos um motivo
      expect(urgentReasons({ ...base, ...input }).length > 0).toBe(expected);
    });

    it.each([
      ['menor', { category: ContentReportCategory.MINOR }, ['category']],
      ['íntima denunciada pela própria pessoa', { category: ContentReportCategory.NON_CONSENSUAL, isDepictedPerson: true }, ['category', 'depicted_person']],
      ['uso da imagem dela', { category: ContentReportCategory.IMPERSONATION, isDepictedPerson: true }, ['depicted_person']],
      [
        'uso da imagem dela citando menor',
        { category: ContentReportCategory.IMPERSONATION, isDepictedPerson: true, description: 'Sou eu nessa foto, eu tinha 16 anos.' },
        ['depicted_person', 'cites_minor'],
      ],
      ['alvo que cita menor', { category: ContentReportCategory.COPYRIGHT, target: 'https://x.com/p/teen-schoolgirl-pack' }, ['cites_minor']],
      ['comum', { category: ContentReportCategory.COPYRIGHT }, []],
    ])('motivos: %s → %j', (_label, input, expected) => {
      expect(urgentReasons({ ...base, ...input })).toEqual(expected);
    });
  });

  it('troll marcando "sou a pessoa" em OTHER: grava não urgente e não manda o aviso de 24 h', async () => {
    const { service, email, created } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
    await service.create(dto({ category: ContentReportCategory.OTHER, isDepictedPerson: true }), {});
    await service.drainAlerts();
    expect(created[0]).toMatchObject({ category: 'OTHER', isDepictedPerson: true, urgent: false });
    expect(email.sendContentReportAlert).not.toHaveBeenCalled();
  });

  it('denúncia urgente: grava urgente, responde antes do aviso e o aviso sai depois, com a data gravada', async () => {
    const { service, email, created, updates, rows, prisma } = setup({ env: { REPORTS_ALERT_EMAIL: 'support@help.theaimodelab.com' } });
    const out = await service.create(
      dto({ category: ContentReportCategory.NON_CONSENSUAL, isDepictedPerson: true, reporterEmail: 'Pessoa@Exemplo.com' }),
      { ip: '203.0.113.9' },
    );
    expect(out).toEqual({ ok: true, id: 'rep-1' });
    expect(created[0]).toMatchObject({ category: 'NON_CONSENSUAL', urgent: true, suspectedBot: false, isDepictedPerson: true, reporterEmail: 'pessoa@exemplo.com' });
    // aviso avulso: grava pendente (sem marca de resumo)
    expect(prisma.contentReport.create.mock.calls[0][0].data).not.toHaveProperty('alertError');
    // a resposta não espera o e-mail: ele ainda nem saiu quando o create resolve
    expect(email.sendContentReportAlert).not.toHaveBeenCalled();

    await service.drainAlerts();
    expect(email.sendContentReportAlert).toHaveBeenCalledWith(
      'support@help.theaimodelab.com',
      expect.objectContaining({ id: 'rep-1', urgent: true, category: 'NON_CONSENSUAL' }),
    );
    expect(updates).toEqual([{ id: 'rep-1', data: { alertSentAt: expect.any(Date), alertError: null } }]);
    expect(rows[0]).toMatchObject({ alertAttempts: 1 });
  });

  it('descrição que cita menor deixa urgente qualquer categoria (e avisa)', async () => {
    const { service, email, created } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
    await service.create(dto({ category: ContentReportCategory.COPYRIGHT, description: 'Isso é uma menina de 12 anos!!' }), {});
    await service.drainAlerts();
    expect(created[0]).toMatchObject({ urgent: true });
    expect(email.sendContentReportAlert).toHaveBeenCalledTimes(1);
  });

  it('denúncia não urgente: grava, sem e-mail e sem marcar aviso', async () => {
    const { service, email, created, updates, claims } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
    await service.create(dto({ category: ContentReportCategory.COPYRIGHT }), {});
    await service.drainAlerts();
    expect(created[0]).toMatchObject({ urgent: false, suspectedBot: false });
    expect(email.sendContentReportAlert).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(claims).toEqual([]);
  });

  it('o aviso nunca segura a resposta: e-mail pendurado e o create já respondeu', async () => {
    const { service, email, updates, release } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, alert: 'pendente' });
    const out = await service.create(dto({ category: ContentReportCategory.MINOR }), {});
    expect(out.ok).toBe(true);
    for (let i = 0; i < 3 && !email.sendContentReportAlert.mock.calls.length; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(email.sendContentReportAlert).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
    release(true);
    await service.drainAlerts();
    expect(updates).toEqual([{ id: 'rep-1', data: { alertSentAt: expect.any(Date), alertError: null } }]);
  });

  it('aviso que falha não perde a denúncia: o motivo e a hora da falha ficam gravados (1 tentativa)', async () => {
    const { service, created, updates, rows } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, alert: false });
    const out = await service.create(dto({ category: ContentReportCategory.MINOR }), {});
    await service.drainAlerts();
    expect(out.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(updates).toEqual([{ id: 'rep-1', data: { alertError: expect.stringContaining('falhou'), updatedAt: expect.any(Date) } }]);
    expect(rows[0]).toMatchObject({ alertAttempts: 1, alertSentAt: null });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('aviso por e-mail falhou'));
  });

  it('erro lançado pelo envio vira alertError com a mensagem', async () => {
    const { service, updates } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, alert: new Error('resend fora do ar') });
    await service.create(dto({ category: ContentReportCategory.NON_CONSENSUAL }), {});
    await service.drainAlerts();
    expect(updates).toEqual([{ id: 'rep-1', data: { alertError: 'resend fora do ar', updatedAt: expect.any(Date) } }]);
  });

  it('urgente sem REPORTS_ALERT_EMAIL: grava, não tenta enviar, registra o motivo e não gasta tentativa', async () => {
    const { service, email, created, rows } = setup({});
    await service.create(dto({ category: ContentReportCategory.MINOR }), {});
    await service.drainAlerts();
    expect(created).toHaveLength(1);
    expect(email.sendContentReportAlert).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ alertError: ALERT_NO_RECIPIENT, alertAttempts: 0, alertSentAt: null });
  });

  describe('isca (campo website)', () => {
    it('não urgente: não grava nada e responde igual a uma denúncia real, com id no formato cuid', async () => {
      const { service, prisma, email } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
      const a = await service.create(dto({ category: ContentReportCategory.OTHER, website: 'http://spam' }), {});
      const b = await service.create(dto({ category: ContentReportCategory.OTHER, website: 'http://spam' }), {});
      await service.drainAlerts();
      expect(a).toEqual({ ok: true, id: expect.stringMatching(CUID) });
      expect(b.id).not.toBe(a.id);
      expect(prisma.contentReport.create).not.toHaveBeenCalled();
      expect(email.sendContentReportAlert).not.toHaveBeenCalled();
    });

    it('urgente: guarda como suspeita de robô e NÃO avisa por e-mail (nem no resumo)', async () => {
      const { service, email, created, updates, prisma } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
      const out = await service.create(dto({ category: ContentReportCategory.MINOR, website: 'https://bot.example' }), {});
      await service.drainAlerts();
      expect(out).toEqual({ ok: true, id: 'rep-1' });
      expect(created[0]).toMatchObject({ urgent: true, suspectedBot: true, alertError: null });
      expect(prisma.contentReport.create.mock.calls[0][0].data).not.toHaveProperty('alertError');
      expect(email.sendContentReportAlert).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
      expect(await service.retryPendingAlerts(CREATED_AT.getTime() + 3 * MIN)).toEqual(sweep());
      expect(email.sendRawEmail).not.toHaveBeenCalled();
    });

    it('website só com espaços não é isca', async () => {
      const { service, created } = setup({});
      await service.create(dto({ category: ContentReportCategory.COPYRIGHT, website: '   ' }), {});
      expect(created[0]).toMatchObject({ suspectedBot: false });
    });

    it('fakeReportId tem o formato do cuid do Prisma e começa pelo instante', () => {
      const id = fakeReportId();
      expect(id).toMatch(CUID);
      expect(Math.abs(parseInt(id.slice(1, 9), 36) - Date.now())).toBeLessThan(60_000);
      expect(new Set(Array.from({ length: 50 }, () => fakeReportId())).size).toBe(50);
    });
  });

  describe('hash do IP', () => {
    it('HMAC-SHA256 com a chave secreta, 32 hex, nunca o IP puro', async () => {
      const { service, created } = setup({ env: { REPORTS_IP_SALT: 'segredo-longo' } });
      await service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '203.0.113.9' });
      const expected = createHmac('sha256', 'segredo-longo').update('203.0.113.9').digest('hex').slice(0, 32);
      expect(created[0].ipHash).toBe(expected);
      expect(JSON.stringify(created[0])).not.toContain('203.0.113.9');
    });

    it('sem REPORTS_IP_SALT: grava sem hash (nada de chave padrão) e avisa uma vez no boot', async () => {
      const { service, created } = setup({ env: { REPORTS_IP_SALT: undefined } });
      service.onModuleInit();
      await service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '203.0.113.9' });
      await service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '203.0.113.10' });
      expect(created.map((row) => row.ipHash)).toEqual([null, null]);
      expect(logError.mock.calls.filter(([msg]) => String(msg).includes('REPORTS_IP_SALT'))).toHaveLength(1);
    });
  });

  describe('boot', () => {
    it('produção sem REPORTS_ALERT_EMAIL: erro no log', () => {
      setup({ env: { NODE_ENV: 'production' } }).service.onModuleInit();
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('REPORTS_ALERT_EMAIL ausente em produção'));
    });

    it('fora de produção, ou com o e-mail definido, não reclama do e-mail', () => {
      setup({ env: { NODE_ENV: 'development' } }).service.onModuleInit();
      setup({ env: { NODE_ENV: 'production', REPORTS_ALERT_EMAIL: 'x@y.com' } }).service.onModuleInit();
      expect(logError).not.toHaveBeenCalled();
    });
  });

  describe('limite', () => {
    it('faixa: isca = robô; urgente = faixa de menor/íntima; resto = comum', () => {
      expect(reportLane({ urgent: true, suspectedBot: true })).toBe('bot');
      expect(reportLane({ urgent: false, suspectedBot: true })).toBe('bot');
      expect(reportLane({ urgent: true, suspectedBot: false })).toBe('priority');
      expect(reportLane({ urgent: false, suspectedBot: false })).toBe('standard');
    });

    it('a 6ª denúncia comum do mesmo IP em 10 min é 429 e não grava', async () => {
      const { service, created } = setup({});
      for (let i = 0; i < 5; i++) await service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '203.0.113.9' });
      const sixth = service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '203.0.113.9' });
      await expect(sixth).rejects.toBeInstanceOf(ReportsRateLimitedException);
      await expect(sixth).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS, response: { code: 'REPORTS_RATE_LIMITED' } });
      expect(created).toHaveLength(5);
      await expect(service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '198.51.100.1' })).resolves.toMatchObject({ ok: true });
    });

    it('a 6ª denúncia URGENTE do mesmo IP em 10 min é gravada (nunca 429) e vai no resumo, sem aviso avulso', async () => {
      const { service, created, email } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
      for (let i = 0; i < 7; i++) await service.create(dto({ category: ContentReportCategory.MINOR }), { ip: '203.0.113.9' });
      await service.drainAlerts();
      expect(created).toHaveLength(7);
      expect(created.map((row) => row.alertError ?? null)).toEqual([null, null, null, null, null, ALERT_DIGEST_QUEUED, ALERT_DIGEST_QUEUED]);
      expect(email.sendContentReportAlert).toHaveBeenCalledTimes(5);
      // a comum do mesmo IP segue recusada (o limite por cliente soma urgentes e comuns)
      await expect(service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '203.0.113.9' })).rejects.toBeInstanceOf(
        ReportsRateLimitedException,
      );
    });

    it('a isca é vista antes do limite: robô no mesmo IP não tira a vez de quem denuncia de verdade', async () => {
      const { service, created } = setup({});
      for (let i = 0; i < 5; i++) await service.create(dto({ category: ContentReportCategory.OTHER, website: 'bot' }), { ip: '203.0.113.9' });
      // o robô bate no limite dele, com o mesmo 429 que um humano receberia
      await expect(
        service.create(dto({ category: ContentReportCategory.OTHER, website: 'bot' }), { ip: '203.0.113.9' }),
      ).rejects.toBeInstanceOf(ReportsRateLimitedException);
      for (let i = 0; i < 5; i++) await service.create(dto({ category: ContentReportCategory.MINOR }), { ip: '203.0.113.9' });
      expect(created).toHaveLength(5);
      expect(created.every((row) => row.suspectedBot === false)).toBe(true);
    });

    // as enxurradas fazem centenas de chamadas: com a suíte inteira rodando, 5 s (padrão do jest) não bastam
    const FLOOD_TIMEOUT_MS = 30_000;

    it('enxurrada de isca com X-Forwarded-For inventado não bloqueia denúncia de menor nem a comum', async () => {
      const { service, created } = setup({});
      for (let i = 0; i < 120; i++) {
        const category = i % 2 ? ContentReportCategory.MINOR : ContentReportCategory.COPYRIGHT;
        await service.create(dto({ category, website: 'http://spam' }), { ip: forged(i) });
      }
      await expect(
        service.create(dto({ category: ContentReportCategory.OTHER, website: 'x' }), { ip: '192.0.2.1' }),
      ).rejects.toBeInstanceOf(ReportsRateLimitedException);
      const before = created.length;
      await expect(service.create(dto({ category: ContentReportCategory.MINOR }), { ip: '192.0.2.2' })).resolves.toMatchObject({ ok: true });
      await expect(service.create(dto({ category: ContentReportCategory.NON_CONSENSUAL }), { ip: '192.0.2.3' })).resolves.toMatchObject({ ok: true });
      await expect(service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: '192.0.2.4' })).resolves.toMatchObject({ ok: true });
      expect(created.slice(before).map((row) => row.suspectedBot)).toEqual([false, false, false]);
    }, FLOOD_TIMEOUT_MS);

    it('enxurrada de denúncia comum esgota o teto dela (120/h), mas MINOR e NON_CONSENSUAL seguem entrando', async () => {
      const { service, created } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
      for (let i = 0; i < 120; i++) await service.create(dto({ category: ContentReportCategory.COPYRIGHT }), { ip: forged(i) });
      await expect(service.create(dto({ category: ContentReportCategory.OTHER }), { ip: '192.0.2.1' })).rejects.toBeInstanceOf(
        ReportsRateLimitedException,
      );
      await service.create(dto({ category: ContentReportCategory.MINOR }), { ip: '192.0.2.2' });
      await service.create(dto({ category: ContentReportCategory.NON_CONSENSUAL }), { ip: '192.0.2.3' });
      // texto que cita menor numa categoria comum também é urgente: entra pela faixa urgente
      await service.create(dto({ category: ContentReportCategory.OTHER, description: 'A foto mostra uma menina de 13 anos.' }), {
        ip: '192.0.2.4',
      });
      await service.drainAlerts();
      expect(created.slice(120).map((row) => [row.category, row.urgent])).toEqual([
        ['MINOR', true],
        ['NON_CONSENSUAL', true],
        ['OTHER', true],
      ]);
    }, FLOOD_TIMEOUT_MS);

    it('700 urgentes com X-Forwarded-For inventado (antes calavam a faixa) não recusam a denúncia de menor de verdade; e-mail avulso só 30', async () => {
      const { service, created, email } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
      for (let i = 0; i < 700; i++) await service.create(dto({ category: ContentReportCategory.MINOR }), { ip: forged(i) });
      await expect(service.create(dto({ category: ContentReportCategory.MINOR }), { ip: '192.0.2.50' })).resolves.toMatchObject({ ok: true });
      await service.drainAlerts();
      expect(created).toHaveLength(701);
      expect(email.sendContentReportAlert).toHaveBeenCalledTimes(30);
      expect(created.filter((row) => row.alertError === ALERT_DIGEST_QUEUED)).toHaveLength(671);
      expect(created[700]).toMatchObject({ alertError: ALERT_DIGEST_QUEUED, urgent: true });
    }, FLOOD_TIMEOUT_MS);

    it('acima do teto que protege o banco: 429 com a alternativa por e-mail', async () => {
      const limits: ReportsLimits = { ...REPORTS_LIMITS, global: { ...REPORTS_LIMITS.global, priority: { limit: 3, windowMs: 60 * MIN } } };
      const { service, created } = setup({ limits });
      for (let i = 0; i < 3; i++) await service.create(dto({ category: ContentReportCategory.MINOR }), { ip: forged(i) });
      const refused = service.create(dto({ category: ContentReportCategory.MINOR }), { ip: '192.0.2.9' });
      await expect(refused).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: { code: 'REPORTS_RATE_LIMITED', message: expect.stringContaining(REPORTS_CONTACT_EMAIL) },
      });
      expect(created).toHaveLength(3);
    });
  });

  describe('aviso por e-mail: reserva atômica, nova tentativa e resumo', () => {
    /** denúncia urgente gravada antes de a API reiniciar (o setImmediate do aviso se perdeu) */
    const lost = (over: Row = {}): Row => ({
      id: 'perdida',
      category: 'MINOR',
      status: 'OPEN',
      target: base.target,
      description: 'Conteúdo com menor de idade.',
      reporterEmail: null,
      isDepictedPerson: false,
      urgent: true,
      suspectedBot: false,
      alertSentAt: null,
      alertError: null,
      alertAttempts: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ...over,
    });
    const at = (ms: number) => CREATED_AT.getTime() + ms;
    const sentIds = (email: { sendContentReportAlert: jest.Mock }) =>
      email.sendContentReportAlert.mock.calls.map((call: unknown[]) => (call[1] as { id: string }).id);

    it('o aviso logo depois da resposta reserva a denúncia (alertError "sending", +1 tentativa) antes de mandar', async () => {
      const { service, email, claims, rows, release } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, alert: 'pendente' });
      await service.create(dto({ category: ContentReportCategory.MINOR }), {});
      for (let i = 0; i < 3 && !email.sendContentReportAlert.mock.calls.length; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(claims).toEqual([
        {
          where: { id: 'rep-1', alertSentAt: null, alertError: null },
          data: { alertError: ALERT_SENDING, alertAttempts: { increment: 1 }, updatedAt: expect.any(Date) },
          count: 1,
        },
      ]);
      expect(email.sendContentReportAlert).toHaveBeenCalledTimes(1);
      expect(rows[0]).toMatchObject({ alertError: ALERT_SENDING, alertSentAt: null, alertAttempts: 1 });
      release(true);
      await service.drainAlerts();
      expect(rows[0]).toMatchObject({ alertError: null, alertSentAt: expect.any(Date) });
    });

    it('reserva perdida (outro processo já pegou): não manda o e-mail de novo', async () => {
      const { service, prisma, email } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
      prisma.contentReport.updateMany.mockResolvedValueOnce({ count: 0 });
      await service.create(dto({ category: ContentReportCategory.MINOR }), {});
      await service.drainAlerts();
      expect(email.sendContentReportAlert).not.toHaveBeenCalled();
    });

    it('a API reiniciou antes do aviso: a varredura manda e grava alertSentAt', async () => {
      const { service, email, rows, updates, prisma } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [lost()] });
      const now = at(3 * MIN);
      expect(await service.retryPendingAlerts(now)).toEqual(sweep({ sent: 1 }));
      expect(prisma.contentReport.findMany).toHaveBeenCalledWith({
        where: {
          urgent: true,
          suspectedBot: false,
          alertSentAt: null,
          status: { in: ['OPEN', 'IN_REVIEW'] },
          createdAt: { gte: new Date(now - ALERT_RETRY_MAX_AGE_MS) },
          OR: [
            { alertError: null, createdAt: { lte: new Date(now - ALERT_RETRY_MIN_AGE_MS) } },
            { alertError: ALERT_DIGEST_QUEUED },
            { alertError: ALERT_NO_RECIPIENT },
            { alertError: ALERT_SENDING, alertAttempts: { lt: ALERT_MAX_ATTEMPTS }, updatedAt: { lt: new Date(now - ALERT_CLAIM_STALE_MS) } },
            ...ALERT_RETRY_BACKOFF_MS.map((wait, index) => ({
              alertError: { notIn: [ALERT_SENDING, ALERT_DIGEST_QUEUED, ALERT_NO_RECIPIENT] },
              alertAttempts: index === 0 ? { lte: 1 } : index + 1,
              updatedAt: { lte: new Date(now - wait) },
            })),
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 1_000,
      });
      expect(email.sendContentReportAlert).toHaveBeenCalledWith('x@y.com', expect.objectContaining({ id: 'perdida', urgent: true }));
      expect(updates).toEqual([{ id: 'perdida', data: { alertSentAt: expect.any(Date), alertError: null } }]);
      expect(rows[0]).toMatchObject({ alertSentAt: expect.any(Date), alertError: null, alertAttempts: 1 });
      // já avisada: a próxima varredura não pega de novo
      expect(await service.retryPendingAlerts(at(8 * MIN))).toEqual(sweep());
      expect(email.sendContentReportAlert).toHaveBeenCalledTimes(1);
    });

    it('só pega denúncia urgente, de humano, aberta, com menos de 48 h e com tentativa sobrando', async () => {
      const { service, email } = setup({
        env: { REPORTS_ALERT_EMAIL: 'x@y.com' },
        rows: [
          lost({ id: 'nova-demais', createdAt: new Date(at(9 * MIN)) }),
          lost({ id: 'velha-demais', createdAt: new Date(at(-49 * 60 * MIN)) }),
          lost({ id: 'velha-com-falha', createdAt: new Date(at(-49 * 60 * MIN)), alertError: 'resend fora do ar', alertAttempts: 1 }),
          lost({ id: 'comum', urgent: false }),
          lost({ id: 'robo', suspectedBot: true }),
          lost({ id: 'resolvida', status: 'ACTIONED' }),
          lost({ id: 'ja-avisada', alertSentAt: CREATED_AT }),
          lost({ id: 'falhou', alertError: 'resend fora do ar', alertAttempts: 1 }),
          lost({ id: 'falhou-5-vezes', alertError: 'resend fora do ar', alertAttempts: ALERT_MAX_ATTEMPTS }),
          lost({ id: 'sem-email', alertError: ALERT_NO_RECIPIENT }),
          lost({ id: 'reservada-agora', alertError: ALERT_SENDING, updatedAt: new Date(at(5 * MIN)) }),
          lost({ id: 'em-analise', status: 'IN_REVIEW' }),
        ],
      });
      expect(await service.retryPendingAlerts(at(10 * MIN))).toEqual(sweep({ sent: 3 }));
      expect(sentIds(email).sort()).toEqual(['em-analise', 'falhou', 'sem-email']);
    });

    it('falha passageira: nova tentativa com espera crescente (5, 15, 45, 120 min) até 5 tentativas', async () => {
      const { service, email, rows } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, alert: false, rows: [lost()] });
      // 1ª tentativa (a varredura pegou a perdida)
      let clock = at(3 * MIN);
      expect(await service.retryPendingAlerts(clock)).toEqual(sweep({ failed: 1 }));
      expect(rows[0]).toMatchObject({ alertAttempts: 1, alertSentAt: null, alertError: expect.stringContaining('falhou') });
      for (const [attempt, waitMin] of [[1, 5], [2, 15], [3, 45], [4, 120]] as const) {
        // antes da espera: nada
        expect(await service.retryPendingAlerts(clock + (waitMin - 1) * MIN)).toEqual(sweep());
        clock += waitMin * MIN;
        expect(await service.retryPendingAlerts(clock)).toEqual(sweep({ failed: 1 }));
        expect(rows[0]).toMatchObject({ alertAttempts: attempt + 1 });
      }
      expect(rows[0]).toMatchObject({ alertAttempts: ALERT_MAX_ATTEMPTS });
      // acabaram as tentativas: fica no admin e no cockpit
      expect(await service.retryPendingAlerts(clock + 10 * 60 * MIN)).toEqual(sweep());
      expect(email.sendContentReportAlert).toHaveBeenCalledTimes(ALERT_MAX_ATTEMPTS);
      expect(alertRetryDelayMs(0)).toBe(5 * MIN);
      expect(alertRetryDelayMs(4)).toBe(120 * MIN);
      expect(alertRetryDelayMs(5)).toBeNull();
    });

    it('a falha passageira que passa na nova tentativa grava alertSentAt', async () => {
      const { service, email, rows } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [lost({ alertError: 'timeout', alertAttempts: 2, updatedAt: new Date(at(0)) })] });
      expect(await service.retryPendingAlerts(at(14 * MIN))).toEqual(sweep());
      expect(await service.retryPendingAlerts(at(15 * MIN))).toEqual(sweep({ sent: 1 }));
      expect(rows[0]).toMatchObject({ alertSentAt: expect.any(Date), alertError: null, alertAttempts: 3 });
      expect(email.sendContentReportAlert).toHaveBeenCalledTimes(1);
    });

    it('REPORTS_ALERT_EMAIL ausente: a varredura não mexe em nada (loga 1 vez por hora) e manda tudo quando a variável existe', async () => {
      const { service, email, env, rows } = setup({ rows: [lost({ id: 'a' }), lost({ id: 'b', alertError: ALERT_NO_RECIPIENT })] });
      expect(await service.retryPendingAlerts(at(3 * MIN))).toEqual(sweep());
      expect(await service.retryPendingAlerts(at(8 * MIN))).toEqual(sweep());
      expect(logError.mock.calls.filter(([msg]) => String(msg).includes('REPORTS_ALERT_EMAIL ausente'))).toHaveLength(1);
      expect(rows.map((row) => row.alertAttempts)).toEqual([0, 0]);
      env.REPORTS_ALERT_EMAIL = 'x@y.com';
      expect(await service.retryPendingAlerts(at(40 * 60 * MIN))).toEqual(sweep({ sent: 2 }));
      expect(sentIds(email).sort()).toEqual(['a', 'b']);
    });

    it('reserva vencida (processo caiu no meio do envio há mais de 10 min) volta a ser mandada', async () => {
      const stale = lost({ alertError: ALERT_SENDING, alertAttempts: 1, updatedAt: new Date(at(2 * MIN)) });
      const { service, email, claims } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [stale] });
      const now = at(13 * MIN);
      expect(await service.retryPendingAlerts(now)).toEqual(sweep({ sent: 1 }));
      expect(claims[0]).toEqual({
        where: { id: 'perdida', alertSentAt: null, alertError: ALERT_SENDING, updatedAt: { lt: new Date(now - ALERT_CLAIM_STALE_MS) } },
        data: { alertError: ALERT_SENDING, alertAttempts: { increment: 1 }, updatedAt: new Date(now) },
        count: 1,
      });
      expect(email.sendContentReportAlert).toHaveBeenCalledTimes(1);
    });

    it('dois processos leem a mesma linha: só o que reservou primeiro manda', async () => {
      const row = lost();
      const { service, email, prisma } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [row] });
      // o outro processo leu a mesma linha e reservou primeiro
      prisma.contentReport.findMany.mockImplementationOnce(async () => {
        const snapshot = { ...row };
        Object.assign(row, { alertError: ALERT_SENDING, alertAttempts: 1, updatedAt: new Date(at(3 * MIN)) });
        return [snapshot];
      });
      expect(await service.retryPendingAlerts(at(3 * MIN))).toEqual(sweep({ skipped: 1 }));
      expect(email.sendContentReportAlert).not.toHaveBeenCalled();
    });

    it('falha lida pelos dois: o outro tentou de novo (tentativas mudaram) e a 2ª reserva já não casa', async () => {
      const row = lost({ alertError: 'timeout', alertAttempts: 1 });
      const { service, email, prisma } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [row] });
      prisma.contentReport.findMany.mockImplementationOnce(async () => {
        const snapshot = { ...row };
        Object.assign(row, { alertError: 'timeout de novo', alertAttempts: 2, updatedAt: new Date(at(6 * MIN)) });
        return [snapshot];
      });
      expect(await service.retryPendingAlerts(at(6 * MIN))).toEqual(sweep({ skipped: 1 }));
      expect(email.sendContentReportAlert).not.toHaveBeenCalled();
    });

    it('reserva vencida lida pelos dois: a 2ª reserva da mesma linha já não casa', async () => {
      const row = lost({ alertError: ALERT_SENDING, alertAttempts: 1, updatedAt: new Date(at(2 * MIN)) });
      const { service, email, prisma } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [row] });
      prisma.contentReport.findMany.mockImplementationOnce(async () => {
        const snapshot = { ...row };
        Object.assign(row, { updatedAt: new Date(at(13 * MIN)) }); // o outro processo reservou de novo agora
        return [snapshot];
      });
      expect(await service.retryPendingAlerts(at(13 * MIN))).toEqual(sweep({ skipped: 1 }));
      expect(email.sendContentReportAlert).not.toHaveBeenCalled();
    });

    it('banco fora na varredura: só log, nada lança (o agendador segue)', async () => {
      const { service, prisma } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' } });
      prisma.contentReport.findMany.mockRejectedValueOnce(new Error('banco fora'));
      await expect(service.handleAlertRetry()).resolves.toBeUndefined();
      expect(logError).toHaveBeenCalledWith(expect.stringContaining('banco fora'));
    });

    it('o agendador chama sem argumento: a varredura usa o relógio de agora', async () => {
      const { service } = setup({});
      const spy = jest.spyOn(service, 'retryPendingAlerts');
      await service.handleAlertRetry();
      expect(spy).toHaveBeenCalledWith();
    });

    it('varredura em andamento: a seguinte não começa por cima', async () => {
      const { service, prisma, release } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, alert: 'pendente', rows: [lost()] });
      const first = service.retryPendingAlerts(at(3 * MIN));
      expect(await service.retryPendingAlerts(at(3 * MIN))).toEqual(sweep());
      expect(prisma.contentReport.findMany).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      release(true);
      expect(await first).toEqual(sweep({ sent: 1 }));
    });

    describe('resumo', () => {
      const queued = (id: string, over: Row = {}) => lost({ id, alertError: ALERT_DIGEST_QUEUED, ...over });

      it('as que esperam o resumo vão juntas num e-mail só ("N novas denúncias urgentes"), com id, categoria e link', async () => {
        const { service, email, rows, digests } = setup({
          env: { REPORTS_ALERT_EMAIL: 'equipe@x.com', REPORTS_ADMIN_URL: 'https://cockpit.exemplo.com/denuncias' },
          rows: [
            queued('r-copy', { category: 'COPYRIGHT', description: 'cópia de uma menina de 14 anos', createdAt: new Date(at(-5 * MIN)) }),
            queued('r-intima', { category: 'NON_CONSENSUAL', description: 'sou eu nessa foto íntima', createdAt: new Date(at(-4 * MIN)) }),
            queued('r-menor', { category: 'MINOR', createdAt: new Date(at(1 * MIN)) }),
          ],
        });
        // o resumo não espera os 2 min: quem está na fila do resumo já não tem aviso avulso saindo
        expect(await service.retryPendingAlerts(at(1 * MIN))).toEqual(sweep({ digested: 3 }));
        expect(email.sendContentReportAlert).not.toHaveBeenCalled();
        expect(digests).toHaveLength(1);
        expect(digests[0].to).toBe('equipe@x.com');
        expect(digests[0].subject).toBe('[DENÚNCIAS URGENTES] 3 novas denúncias urgentes (2 com menor de idade) — The AI Model Lab');
        for (const id of ['r-copy', 'r-intima', 'r-menor']) {
          expect(digests[0].html).toContain(`https://cockpit.exemplo.com/denuncias?report=${id}`);
        }
        expect(digests[0].html).toContain('menor de idade');
        expect(digests[0].html).toContain('imagem íntima sem consentimento');
        expect(digests[0].html).toContain('o texto cita menor');
        // menor primeiro (pela categoria ou pelo texto), depois as mais antigas
        const order = ['r-copy', 'r-menor', 'r-intima'].map((id) => digests[0].html.indexOf(`report=${id}`));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(rows.every((row) => row.alertSentAt instanceof Date && row.alertError === null && row.alertAttempts === 1)).toBe(true);
      });

      it('no máximo um resumo a cada 10 min: as que chegam no meio esperam o próximo', async () => {
        const { service, rows, digests } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [queued('q1')] });
        expect(await service.retryPendingAlerts(at(5 * MIN))).toEqual(sweep({ digested: 1 }));
        rows.push(queued('q2'), queued('q3'));
        expect(await service.retryPendingAlerts(at(10 * MIN))).toEqual(sweep({ waiting: 2 }));
        expect(digests).toHaveLength(1);
        expect(await service.retryPendingAlerts(at(15 * MIN))).toEqual(sweep({ digested: 2 }));
        expect(digests).toHaveLength(2);
        expect(digests[1].subject).toContain('2 novas denúncias urgentes');
      });

      it('teto de avisos avulsos da hora esgotado na varredura: o que passa vai no resumo', async () => {
        const lostRows = Array.from({ length: 33 }, (_, i) => lost({ id: `l${i}`, createdAt: new Date(at(i * 1_000)) }));
        const { service, email, digests } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: lostRows });
        expect(await service.retryPendingAlerts(at(10 * MIN))).toEqual(sweep({ sent: 30, digested: 3 }));
        expect(email.sendContentReportAlert).toHaveBeenCalledTimes(30);
        expect(digests).toHaveLength(1);
        for (const id of ['l30', 'l31', 'l32']) expect(digests[0].html).toContain(id);
      });

      it('resumo que falha: cada denúncia guarda o motivo e volta pela espera de falha', async () => {
        const { service, rows, digests, email } = setup({
          env: { REPORTS_ALERT_EMAIL: 'x@y.com' },
          digest: new Error('Resend error: 503'),
          rows: [queued('q1'), queued('q2')],
        });
        expect(await service.retryPendingAlerts(at(1 * MIN))).toEqual(sweep({ failed: 2 }));
        expect(rows.map((row) => [row.alertError, row.alertAttempts, row.alertSentAt])).toEqual([
          ['Resend error: 503', 1, null],
          ['Resend error: 503', 1, null],
        ]);
        expect(digests).toHaveLength(0);
        // passou a espera (5 min) e o teto de avisos avulsos está livre: vão avulsas
        expect(await service.retryPendingAlerts(at(6 * MIN))).toEqual(sweep({ sent: 2 }));
        expect(email.sendContentReportAlert).toHaveBeenCalledTimes(2);
      });

      it('serviço de e-mail sem credenciais (sem id do Resend) conta como falha do resumo', async () => {
        const { service, rows } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, digest: 'sem-id', rows: [queued('q1')] });
        expect(await service.retryPendingAlerts(at(1 * MIN))).toEqual(sweep({ failed: 1 }));
        expect(rows[0]).toMatchObject({ alertSentAt: null, alertError: expect.stringContaining('não está configurado'), alertAttempts: 1 });
      });

      it('reserva atômica também no resumo: a que outro processo pegou fica de fora', async () => {
        const row = queued('q1');
        const { service, prisma, digests } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: [row, queued('q2')] });
        prisma.contentReport.findMany.mockImplementationOnce(async () => {
          const snapshot = [{ ...row }, { ...queued('q2') }];
          Object.assign(row, { alertError: ALERT_SENDING, alertAttempts: 1, updatedAt: new Date(at(1 * MIN)) });
          return snapshot;
        });
        expect(await service.retryPendingAlerts(at(1 * MIN))).toEqual(sweep({ digested: 1, skipped: 1 }));
        expect(digests[0].subject).toContain('1 nova denúncia urgente');
        expect(digests[0].html).not.toContain('q1');
      });

      it('fila maior que a leitura: o resumo leva as 1.000 lidas e diz quantas ainda esperam', async () => {
        const flood = Array.from({ length: 1_000 }, (_, i) => queued(`f${i}`, { createdAt: new Date(at(i)) }));
        const { service, prisma, digests } = setup({ env: { REPORTS_ALERT_EMAIL: 'x@y.com' }, rows: flood });
        prisma.contentReport.count.mockResolvedValueOnce(1_250);
        expect(await service.retryPendingAlerts(at(1 * MIN))).toEqual(sweep({ digested: 1_000 }));
        expect(digests).toHaveLength(1);
        expect(digests[0].subject).toContain('1000 novas denúncias urgentes');
        expect(digests[0].html).toContain('Mais 900 denúncia(s) urgente(s)');
        expect(digests[0].html).toContain('Outras 250 seguem na fila para o próximo resumo.');
      });
    });
  });

  describe('resumo (montagem)', () => {
    const report = (i: number, over: Partial<DigestReport> = {}): DigestReport => ({
      id: `r${i}`,
      category: ContentReportCategory.NON_CONSENSUAL,
      target: 'https://x.com/p/1',
      description: 'relato',
      createdAt: new Date(CREATED_AT.getTime() + i * 1_000),
      reasons: ['category'],
      ...over,
    });

    it('uma denúncia: assunto no singular; o texto de quem denunciou é escapado e nunca vira link', () => {
      const { subject, html } = buildUrgentDigest(
        [report(1, { target: '<script>alert(1)</script> https://evil.example', description: 'linha 1\n<b>linha 2</b>' })],
        { adminUrl: null },
      );
      expect(subject).toBe('[DENÚNCIAS URGENTES] 1 nova denúncia urgente — The AI Model Lab');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('href="https://evil.example');
      expect(html).toContain('linha 1<br>&lt;b&gt;linha 2&lt;/b&gt;');
      // sem REPORTS_ADMIN_URL: diz onde está a fila, sem link
      expect(html).toContain('/api/v1/admin/reports');
    });

    it(`lista no máximo ${DIGEST_LIST_MAX} e conta o resto; endereço do admin que não é http(s) não vira link`, () => {
      const many = Array.from({ length: DIGEST_LIST_MAX + 20 }, (_, i) => report(i));
      const { html, subject } = buildUrgentDigest(many, { adminUrl: 'javascript:alert(1)' });
      expect(subject).toContain(`${DIGEST_LIST_MAX + 20} novas denúncias urgentes`);
      expect(html).toContain('Mais 20 denúncia(s) urgente(s)');
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain(`>r${DIGEST_LIST_MAX + 19}<`);
    });
  });

  describe('admin', () => {
    const stored = (over: Row = {}): Row => ({
      id: 'a1',
      category: 'IMPERSONATION',
      status: 'OPEN',
      target: base.target,
      description: base.description,
      reporterEmail: null,
      reporterUserId: null,
      isDepictedPerson: true,
      urgent: true,
      suspectedBot: false,
      alertSentAt: null,
      alertError: null,
      alertAttempts: 0,
      ipHash: null,
      adminNote: null,
      handledBy: null,
      handledAt: null,
      evidenceReleasedAt: null,
      evidenceReleasedBy: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ...over,
    });
    const admin = { id: 'admin-7', email: 'admin@taml.com' };

    it('padrão newest: abertas primeiro e mais novas primeiro; traz open, total e urgentOpen', async () => {
      const { service, prisma } = setup({});
      prisma.contentReport.count.mockResolvedValueOnce(7).mockResolvedValueOnce(3).mockResolvedValueOnce(2);
      const out = await service.listForAdmin(1, 50);
      expect(prisma.contentReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], skip: 0, take: 50 }),
      );
      expect(prisma.contentReport.count).toHaveBeenCalledWith({ where: { urgent: true, status: { in: ['OPEN', 'IN_REVIEW'] } } });
      expect(out).toMatchObject({ total: 7, open: 3, urgentOpen: 2, page: 1, limit: 50 });
    });

    it('sort=oldest: mais antigas primeiro dentro de cada status', async () => {
      const { service, prisma } = setup({});
      await service.listForAdmin(2, 10, 'OPEN', 'oldest');
      expect(prisma.contentReport.findMany).toHaveBeenCalledWith({
        where: { status: 'OPEN' },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        skip: 10,
        take: 10,
      });
    });

    it('lista e detalhe trazem citesMinor, urgentReasons e evidenceReleasedAt', async () => {
      const released = new Date('2026-10-16T10:00:00Z');
      const rowsInDb = [
        stored({ id: 'propria' }),
        stored({ id: 'propria-cita-menor', description: 'Sou eu nessa foto, eu tinha 16 anos.' }),
        stored({ id: 'menor', category: 'MINOR', isDepictedPerson: false, status: 'ACTIONED', evidenceReleasedAt: released, evidenceReleasedBy: 'admin-1' }),
      ];
      const { service, prisma } = setup({ rows: rowsInDb });
      prisma.contentReport.findMany.mockResolvedValueOnce(rowsInDb.map((row) => ({ ...row })));
      const { data } = await service.listForAdmin(1, 50);
      expect(data.map((r) => [r.id, r.citesMinor, r.urgentReasons, r.evidenceReleasedAt])).toEqual([
        ['propria', false, ['depicted_person'], null],
        ['propria-cita-menor', true, ['depicted_person', 'cites_minor'], null],
        ['menor', false, ['category'], released],
      ]);
      await expect(service.getForAdmin('propria-cita-menor')).resolves.toMatchObject({ citesMinor: true, urgentReasons: ['depicted_person', 'cites_minor'] });
      await expect(service.getForAdmin('nao-existe')).rejects.toBeInstanceOf(NotFoundException);
      expect(toAdminReport(rowsInDb[0] as never)).toMatchObject({ id: 'propria', citesMinor: false });
    });

    it('andamento: status e nota como antes (quem mexeu e quando encerrou)', async () => {
      const { service, rows } = setup({ rows: [stored()] });
      const out = await service.update('a1', { status: 'ACTIONED', adminNote: 'removido' }, admin);
      expect(out).toMatchObject({ status: 'ACTIONED', adminNote: 'removido', handledBy: 'admin@taml.com', handledAt: expect.any(Date), citesMinor: false });
      expect(rows[0]).toMatchObject({ evidenceReleasedAt: null });
    });

    it('evidenceReleased: só com a denúncia confirmada (ACTIONED); grava quando e quem (id do admin); repetir não muda nada', async () => {
      const { service, rows, prisma } = setup({ rows: [stored()] });
      await expect(service.update('a1', { evidenceReleased: true }, admin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update('a1', { status: 'IN_REVIEW', evidenceReleased: true }, admin)).rejects.toBeInstanceOf(BadRequestException);
      // descartada também não: a liberação ficava gravada e valia quando a denúncia fosse confirmada depois
      await expect(service.update('a1', { status: 'DISMISSED', evidenceReleased: true }, admin)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.contentReport.update).not.toHaveBeenCalled();

      // encerra e libera no mesmo pedido
      const first = await service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin);
      expect(first).toMatchObject({ status: 'ACTIONED', evidenceReleasedAt: expect.any(Date), evidenceReleasedBy: 'admin-7' });
      const releasedAt = rows[0].evidenceReleasedAt;

      // idempotente: outro admin repetindo não muda a data nem quem liberou, e não mexe no andamento
      const again = await service.update('a1', { evidenceReleased: true }, { id: 'admin-9', email: 'outro@taml.com' });
      expect(again).toMatchObject({ evidenceReleasedAt: releasedAt, evidenceReleasedBy: 'admin-7', handledBy: 'admin@taml.com' });
    });

    it('descartada não libera (400, nada gravado); confirmada e liberada que é reaberta perde a liberação', async () => {
      const { service, rows, prisma } = setup({ rows: [stored({ status: 'DISMISSED' })] });
      await expect(service.update('a1', { evidenceReleased: true }, admin)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.contentReport.update).not.toHaveBeenCalled();
      expect(rows[0]).toMatchObject({ status: 'DISMISSED', evidenceReleasedAt: null, evidenceReleasedBy: null });

      await service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin);
      expect(rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedAt: expect.any(Date), evidenceReleasedBy: 'admin-7' });
      await service.update('a1', { status: 'IN_REVIEW' }, admin);
      expect(rows[0]).toMatchObject({ status: 'IN_REVIEW', evidenceReleasedAt: null, evidenceReleasedBy: null });
    });

    it('denúncia de menor confirmada, liberada, descartada e confirmada de novo volta a segurar a conta (liberação desfeita)', async () => {
      const { service, rows } = setup({ rows: [stored({ category: 'MINOR', isDepictedPerson: false })] });
      await service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin);
      expect(rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedAt: expect.any(Date) });

      await service.update('a1', { status: 'DISMISSED' }, admin);
      expect(rows[0]).toMatchObject({ status: 'DISMISSED', evidenceReleasedAt: null, evidenceReleasedBy: null });

      // confirmada de novo sem liberar: ACTIONED sem evidenceReleasedAt = segura a exclusão LGPD da conta denunciada
      const out = await service.update('a1', { status: 'ACTIONED' }, admin);
      expect(out).toMatchObject({ status: 'ACTIONED', evidenceReleasedAt: null, evidenceReleasedBy: null });
      expect(rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedAt: null, evidenceReleasedBy: null });
    });

    it('liberação antiga gravada numa descartada não sobrevive à confirmação; confirmar e liberar junto grava data e admin novos', async () => {
      const old = new Date('2026-10-15T13:00:00Z');
      const legacy = () => stored({ category: 'MINOR', isDepictedPerson: false, status: 'DISMISSED', evidenceReleasedAt: old, evidenceReleasedBy: 'admin-antigo' });

      const confirmOnly = setup({ rows: [legacy()] });
      await confirmOnly.service.update('a1', { status: 'ACTIONED' }, admin);
      expect(confirmOnly.rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedAt: null, evidenceReleasedBy: null });

      const confirmAndRelease = setup({ rows: [legacy()] });
      await confirmAndRelease.service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin);
      expect(confirmAndRelease.rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedBy: 'admin-7' });
      expect((confirmAndRelease.rows[0].evidenceReleasedAt as Date).getTime()).toBeGreaterThan(old.getTime());
    });

    it('sem troca de status a liberação fica: nota, o mesmo status de novo e liberar de novo não mexem nela', async () => {
      const released = new Date('2026-10-15T13:00:00Z');
      const { service, rows } = setup({
        rows: [stored({ category: 'MINOR', isDepictedPerson: false, status: 'ACTIONED', evidenceReleasedAt: released, evidenceReleasedBy: 'admin-1' })],
      });
      await service.update('a1', { adminNote: 'evidência entregue à polícia' }, admin);
      await service.update('a1', { status: 'ACTIONED' }, admin);
      await service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin);
      expect(rows[0]).toMatchObject({ status: 'ACTIONED', adminNote: 'evidência entregue à polícia', evidenceReleasedAt: released, evidenceReleasedBy: 'admin-1' });
    });

    it('outro admin mudou o status no meio: 409 e nada é gravado (a liberação não sobrevive à troca do outro)', async () => {
      const { service, rows, prisma } = setup({ rows: [stored({ category: 'MINOR', isDepictedPerson: false, status: 'IN_REVIEW' })] });
      // leitura velha: a denúncia estava confirmada, mas outro admin já a reabriu
      prisma.contentReport.findUnique.mockResolvedValueOnce({ ...rows[0], status: 'ACTIONED' });
      await expect(service.update('a1', { evidenceReleased: true }, admin)).rejects.toBeInstanceOf(ConflictException);
      expect(rows[0]).toMatchObject({ status: 'IN_REVIEW', evidenceReleasedAt: null, evidenceReleasedBy: null });
      // a gravação leva o status e a liberação lidos no where
      expect(prisma.contentReport.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1', status: 'ACTIONED', evidenceReleasedAt: null } }),
      );

      // erro que não é "linha não encontrada" sobe como veio
      prisma.contentReport.update.mockRejectedValueOnce(new Error('banco fora'));
      await expect(service.update('a1', { adminNote: 'x' }, admin)).rejects.toThrow('banco fora');
    });

    it('corpo vazio é 400; denúncia que não existe é 404', async () => {
      const { service } = setup({ rows: [stored()] });
      await expect(service.update('a1', {}, admin)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update('nao-existe', { status: 'ACTIONED' }, admin)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('o DTO só aceita evidenceReleased: true (false ou texto é 400 na validação)', async () => {
      const errorsOf = async (body: Record<string, unknown>) => validate(plainToInstance(UpdateReportDto, body));
      expect(await errorsOf({ evidenceReleased: true })).toEqual([]);
      expect(await errorsOf({ status: 'ACTIONED' })).toEqual([]);
      expect(await errorsOf({ evidenceReleased: false })).toHaveLength(1);
      expect(await errorsOf({ evidenceReleased: 'true' })).toHaveLength(1);
      expect(await errorsOf({ status: 'APAGADO' })).toHaveLength(1);
    });

    describe('trava do revisor (camada 7): tirar a guarda da evidência', () => {
      const GATE: SafetyGate = { imageMode: 'off', textMode: 'off', reviewerIds: new Set(['rev-1']) };
      const reviewer = { id: 'rev-1', email: 'revisor@taml.com', ip: '203.0.113.9' };
      const minor = () => stored({ category: 'MINOR', isDepictedPerson: false });

      it('admin fora da lista: descartar denúncia de menor é 403, nada muda e a tentativa vai para a trilha', async () => {
        const { service, rows, prisma } = setup({ rows: [minor()], safety: GATE });
        await expect(service.update('a1', { status: 'DISMISSED' }, admin)).rejects.toBeInstanceOf(ForbiddenException);
        expect(rows[0]).toMatchObject({ status: 'OPEN' });
        expect(prisma.contentReport.update).not.toHaveBeenCalled();
        expect(prisma.contentSafetyAccessLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ actorId: 'admin-7', action: 'report_update_denied', targetId: 'a1' }),
        });
      });

      it('admin fora da lista: confirmar e liberar a evidência é 403; nota, em análise e confirmar sem liberar passam', async () => {
        const { service, rows } = setup({ rows: [minor()], safety: GATE });
        await expect(service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await service.update('a1', { adminNote: 'conferido' }, admin);
        await service.update('a1', { status: 'IN_REVIEW' }, admin);
        await service.update('a1', { status: 'ACTIONED' }, admin);
        expect(rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedAt: null, adminNote: 'conferido' });
      });

      it('o revisor descarta e libera; a trilha entra na mesma transação, com o IP', async () => {
        const { service, rows, prisma } = setup({ rows: [minor()], safety: GATE });
        await service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, reviewer);
        expect(rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedBy: 'rev-1' });
        expect((prisma as unknown as { $transaction: jest.Mock }).$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.contentSafetyAccessLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ actorId: 'rev-1', action: 'report_update', ip: '203.0.113.9' }),
        });
      });

      it('denúncia que não segura evidência (direito autoral): o admin comum descarta como antes', async () => {
        const { service, rows } = setup({ rows: [stored({ category: 'COPYRIGHT', isDepictedPerson: false, urgent: false })], safety: GATE });
        await service.update('a1', { status: 'DISMISSED' }, admin);
        expect(rows[0]).toMatchObject({ status: 'DISMISSED' });
      });

      it('sem a revisão em uso (checagens off e lista vazia): o cockpit segue descartando e liberando como hoje', async () => {
        const { service, rows } = setup({
          rows: [minor()],
          safety: { imageMode: 'off', textMode: 'off', reviewerIds: new Set() },
        });
        await service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin);
        expect(rows[0]).toMatchObject({ status: 'ACTIONED', evidenceReleasedBy: 'admin-7' });
      });

      it('liberar a evidência sem conseguir gravar a trilha: 503', async () => {
        const { service, prisma } = setup({ rows: [minor()] });
        prisma.contentSafetyAccessLog.create.mockRejectedValueOnce(new Error('banco fora'));
        await expect(service.update('a1', { status: 'ACTIONED', evidenceReleased: true }, admin)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      });
    });
  });
});
