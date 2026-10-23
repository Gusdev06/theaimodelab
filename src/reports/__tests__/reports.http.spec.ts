import { BadRequestException, INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as request from 'supertest';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { EmailService } from '../../email/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReportsAdminController } from '../reports-admin.controller';
import { ReportsRateLimiter } from '../reports-rate-limiter';
import { ReportsController, reportClientIp } from '../reports.controller';
import { ReportsService } from '../reports.service';

/**
 * POST /api/v1/reports no pipeline real do Nest, com um throttler global mais apertado que o da API (2 por minuto
 * por req.ip): se a rota não estivesse fora dele, a 3ª denúncia do mesmo proxy já cairia. Quem limita é o
 * ReportsService, pelo IP real do x-forwarded-for. A estratégia JWT é a mesma da API: Bearer válido vira
 * reporterUserId; inválido, vencido ou de outra chave segue anônimo (nunca 401).
 */
describe('POST /api/v1/reports (HTTP)', () => {
  let app: INestApplication;
  let service: ReportsService;
  const created: Array<Record<string, unknown>> = [];
  let releaseAlert: (sent: boolean) => void = () => undefined;
  const email = {
    sendContentReportAlert: jest.fn(() => new Promise<boolean>((resolve) => (releaseAlert = resolve))),
  };
  const prisma = {
    contentReport: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `rep-${created.length + 1}`, createdAt: new Date(), ...data };
        created.push(row);
        return row;
      }),
      update: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    // a estratégia JWT confere se a conta existe e está ativa (conta desativada perde o acesso)
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === 'user-123' ? { isActive: true } : null)),
    },
  };
  const JWT_SECRET = 'segredo-jwt-de-teste';
  const env: Record<string, string> = {
    REPORTS_ALERT_EMAIL: 'support@help.theaimodelab.com',
    REPORTS_IP_SALT: 'chave-de-teste',
    JWT_ACCESS_SECRET: JWT_SECRET,
  };
  const config = {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      if (!(key in env)) throw new Error(`${key} ausente`);
      return env[key];
    },
  };
  const jwt = new JwtService({});
  const accessToken = (sub: string, opts: { secret?: string; expired?: boolean } = {}) => {
    const iat = Math.floor(Date.now() / 1000) - (opts.expired ? 3_600 : 0);
    return jwt.sign(
      { sub, email: `${sub}@exemplo.com`, role: 'USER', iat, exp: iat + (opts.expired ? 60 : 900) },
      { secret: opts.secret ?? JWT_SECRET },
    );
  };

  const valid = { category: 'COPYRIGHT', target: 'https://www.theaimodelab.com/p/abc', description: 'Esta imagem copia o meu trabalho autoral.' };
  const post = (ip: string, body: Record<string, unknown> = valid) =>
    request(app.getHttpServer()).post('/api/v1/reports').set('x-forwarded-for', `${ip}, 10.0.0.1`).send(body);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 2 }]), PassportModule],
      controllers: [ReportsController],
      providers: [
        ReportsService,
        JwtStrategy,
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: email },
        { provide: ConfigService, useValue: config },
        { provide: ReportsRateLimiter, useFactory: () => new ReportsRateLimiter() },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    service = moduleRef.get(ReportsService);
  });

  afterAll(async () => {
    releaseAlert(true);
    await app.close();
    jest.restoreAllMocks();
  });

  it('fora do throttler global; 5 por cliente (IP real do x-forwarded-for) e a 6ª é 429 REPORTS_RATE_LIMITED', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post('198.51.100.7');
      expect(res.status).toBe(201);
    }
    const sixth = await post('198.51.100.7');
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ code: 'REPORTS_RATE_LIMITED', message: expect.any(String) });
    // outro visitante atrás do mesmo proxy (mesmo req.ip) continua denunciando
    expect((await post('198.51.100.8')).status).toBe(201);
  });

  it('denúncia urgente responde na hora, mesmo com o e-mail pendurado; o aviso sai depois', async () => {
    email.sendContentReportAlert.mockClear();
    const started = Date.now();
    const res = await post('203.0.113.50', { ...valid, category: 'MINOR', description: 'Conteúdo com menor de idade, removam por favor.' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, id: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(email.sendContentReportAlert).toHaveBeenCalledTimes(1); // já disparado, ainda sem resposta do provedor
    releaseAlert(true);
    await service.drainAlerts();
    expect(prisma.contentReport.update).toHaveBeenCalledWith({
      where: { id: res.body.id },
      data: { alertSentAt: expect.any(Date), alertError: null },
    });
  });

  describe('quem denuncia logado (Bearer opcional)', () => {
    const postAs = (ip: string, authorization?: string) => {
      const req = request(app.getHttpServer()).post('/api/v1/reports').set('x-forwarded-for', ip);
      return (authorization ? req.set('authorization', authorization) : req).send(valid);
    };
    const last = () => created[created.length - 1];

    it('token válido: a denúncia leva a conta (reporterUserId)', async () => {
      const res = await postAs('192.0.2.10', `Bearer ${accessToken('user-123')}`);
      expect(res.status).toBe(201);
      expect(last()).toMatchObject({ reporterUserId: 'user-123' });
    });

    it.each([
      ['sem token', undefined],
      ['token vencido', () => `Bearer ${accessToken('user-123', { expired: true })}`],
      ['token assinado com outra chave', () => `Bearer ${accessToken('user-123', { secret: 'outra-chave' })}`],
      ['token quebrado', () => 'Bearer isso.nao.e.um.jwt'],
      ['esquema errado', () => `Basic ${Buffer.from('a:b').toString('base64')}`],
    ])('%s: segue anônima, nunca 401', async (_label, header) => {
      const res = await postAs(`192.0.2.${20 + created.length % 200}`, typeof header === 'function' ? header() : header);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ ok: true });
      expect(last()).toMatchObject({ reporterUserId: null });
    });
  });

  it('a isca preenchida responde igual a uma denúncia real', async () => {
    const before = created.length;
    const real = await post('203.0.113.60');
    const bot = await post('203.0.113.61', { ...valid, website: 'http://spam.example' });
    expect(bot.status).toBe(real.status);
    expect(Object.keys(bot.body).sort()).toEqual(Object.keys(real.body).sort());
    expect(bot.body).toMatchObject({ ok: true, id: expect.stringMatching(/^c[0-9a-z]{24}$/), message: real.body.message });
    expect(created.length).toBe(before + 1);
  });
});

describe('reportClientIp', () => {
  it.each([
    [{ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, ip: '10.0.0.2' }, '203.0.113.9'],
    [{ headers: { 'x-forwarded-for': ['198.51.100.1, 10.0.0.1', '10.0.0.3'] }, ip: '10.0.0.2' }, '198.51.100.1'],
    [{ headers: { 'x-forwarded-for': ' , 10.0.0.1' }, ip: '10.0.0.2' }, '10.0.0.2'],
    [{ headers: {}, ip: '10.0.0.2' }, '10.0.0.2'],
    [{}, null],
  ])('%j → %s', (req, expected) => {
    expect(reportClientIp(req)).toBe(expected);
  });
});

describe('ReportsAdminController', () => {
  const reports = {
    listForAdmin: jest.fn(async () => ({ data: [], total: 0, open: 0, urgentOpen: 0, page: 1, limit: 50 })),
    getForAdmin: jest.fn(async (id: string) => ({ id, citesMinor: false, urgentReasons: [] })),
    update: jest.fn(async (id: string) => ({ id })),
  };
  const controller = new ReportsAdminController(reports as unknown as ReportsService);

  beforeEach(() => {
    reports.listForAdmin.mockClear();
    reports.getForAdmin.mockClear();
    reports.update.mockClear();
  });

  it('detalhe repassa o id; andamento leva o id (evidenceReleasedBy) e o e-mail (handledBy) do admin', async () => {
    await expect(controller.detail('rep-9')).resolves.toMatchObject({ id: 'rep-9', citesMinor: false });
    expect(reports.getForAdmin).toHaveBeenCalledWith('rep-9');
    await controller.update('rep-9', { evidenceReleased: true }, { sub: 'admin-1', email: 'admin@taml.com', role: 'ADMIN' });
    expect(reports.update).toHaveBeenCalledWith('rep-9', { evidenceReleased: true }, { id: 'admin-1', email: 'admin@taml.com' });
  });

  it('sort padrão newest; oldest repassado', async () => {
    await controller.list(1, 50);
    expect(reports.listForAdmin).toHaveBeenLastCalledWith(1, 50, undefined, 'newest');
    await controller.list(2, 20, 'OPEN', 'oldest');
    expect(reports.listForAdmin).toHaveBeenLastCalledWith(2, 20, 'OPEN', 'oldest');
  });

  it('sort ou status fora da lista: 400', async () => {
    await expect(controller.list(1, 50, undefined, 'random')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.list(1, 50, 'toString')).rejects.toBeInstanceOf(BadRequestException);
    expect(reports.listForAdmin).not.toHaveBeenCalled();
  });
});
