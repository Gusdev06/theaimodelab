import {
  ExecutionContext,
  ForbiddenException,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ContentSafetyAdminController } from '../../content-safety-admin.controller';
import { ContentSafetyService } from '../../content-safety.service';
import { IMAGE_SAFETY_CONFIG } from '../../image-safety/image-safety.config';
import { SafetyReviewService } from '../safety-review.service';
import {
  SAFETY_REVIEWER_FORBIDDEN,
  SafetyReviewerGuard,
} from '../safety-reviewer.guard';

/**
 * Rotas do revisor no pipeline do Nest: RolesGuard e SafetyReviewerGuard de verdade, o mesmo ValidationPipe global do
 * main.ts e o serviço simulado. O que importa: ADMIN fora de SAFETY_REVIEWER_IDS não entra em nenhuma rota.
 */

const REASON = 'Conferência do caso para decidir a retenção.';
type User = { sub: string; email: string; role: string } | undefined;

const REVIEWER: User = { sub: 'rev-1', email: 'revisor@theaimodelab.com', role: 'ADMIN' };
const OTHER_ADMIN: User = { sub: 'adm-9', email: 'admin@theaimodelab.com', role: 'ADMIN' };

function reviewMock() {
  return {
    listScans: jest.fn(async () => ({ data: [], total: 0, page: 1, limit: 50 })),
    mediaUrl: jest.fn(async () => ({ url: 'https://signed.test/x', expiresInSeconds: 120 })),
    decide: jest.fn(async () => ({ action: 'confirm' })),
    accessLog: jest.fn(async () => ({ data: [], total: 0, page: 1, limit: 50 })),
    metrics: jest.fn(async () => ({ windowDays: 7 })),
    reactivateAccount: jest.fn(async () => ({ userId: 'user-1', reactivated: true, alreadyActive: false })),
  };
}

async function createApp(options: {
  review: ReturnType<typeof reviewMock> | null;
  reviewerIds?: string[];
  user: () => User;
}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ContentSafetyAdminController],
    providers: [
      {
        provide: ContentSafetyService,
        useValue: {
          listForAdmin: jest.fn(async () => ({ data: [], total: 0, page: 1, limit: 50 })),
          releaseMinorBlock: jest.fn(),
        },
      },
      { provide: IMAGE_SAFETY_CONFIG, useValue: { reviewerIds: new Set(options.reviewerIds ?? ['rev-1']) } },
      ...(options.review ? [{ provide: SafetyReviewService, useValue: options.review }] : []),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = options.user();
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  await app.init();
  return app;
}

const BASE = '/api/v1/admin/content-safety';

describe('Rotas do revisor de segurança (HTTP)', () => {
  let app: INestApplication;
  let currentUser: User;
  const review = reviewMock();

  beforeAll(async () => {
    app = await createApp({ review, user: () => currentUser });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    Object.values(review).forEach((fn) => fn.mockClear());
    currentUser = REVIEWER;
  });
  afterEach(() => jest.restoreAllMocks());

  const routes: Array<[string, () => request.Test]> = [
    ['GET scans', () => request(app.getHttpServer()).get(`${BASE}/scans`)],
    [
      'GET scans/:id/media',
      () => request(app.getHttpServer()).get(`${BASE}/scans/scan-1/media`).query({ reason: REASON }),
    ],
    [
      'POST scans/:id/decision',
      () =>
        request(app.getHttpServer())
          .post(`${BASE}/scans/scan-1/decision`)
          .send({ action: 'confirm', reason: REASON }),
    ],
    ['GET access-log', () => request(app.getHttpServer()).get(`${BASE}/access-log`)],
    ['GET metrics', () => request(app.getHttpServer()).get(`${BASE}/metrics`)],
    [
      'POST users/:id/reactivate',
      () => request(app.getHttpServer()).post(`${BASE}/users/user-1/reactivate`).send({ reason: REASON }),
    ],
  ];

  it.each(routes)('%s: ADMIN fora de SAFETY_REVIEWER_IDS recebe 403 e nada é chamado', async (_name, call) => {
    currentUser = OTHER_ADMIN;
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(SAFETY_REVIEWER_FORBIDDEN);
    Object.values(review).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it.each(routes)('%s: id na lista sem o papel ADMIN recebe 403', async (_name, call) => {
    currentUser = { sub: 'rev-1', email: 'revisor@theaimodelab.com', role: 'USER' };
    const res = await call();
    expect(res.status).toBe(403);
    Object.values(review).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  it.each(routes)('%s: revisor designado entra (sem cache na resposta)', async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('PATCH events/:id/release: o serviço recebe se quem libera está na lista de revisores e o IP', async () => {
    const safety = app.get(ContentSafetyService) as unknown as { releaseMinorBlock: jest.Mock };
    safety.releaseMinorBlock.mockResolvedValue({ id: 'evt-1', released: true });
    for (const [user, reviewer] of [
      [REVIEWER, true],
      [OTHER_ADMIN, false],
    ] as const) {
      currentUser = user;
      safety.releaseMinorBlock.mockClear();
      const res = await request(app.getHttpServer())
        .patch(`${BASE}/events/evt-1/release`)
        .set('x-forwarded-for', '198.51.100.20')
        .send({ note: REASON });
      expect(res.status).toBe(200);
      expect(safety.releaseMinorBlock).toHaveBeenCalledWith('evt-1', REASON, {
        id: user!.sub,
        email: user!.email,
        ip: '198.51.100.20',
        reviewer,
      });
    }
  });

  it('a trilha antiga (GET events) continua só ADMIN, sem exigir a lista de revisores', async () => {
    currentUser = OTHER_ADMIN;
    const res = await request(app.getHttpServer()).get(`${BASE}/events`);
    expect(res.status).toBe(200);
  });

  it('GET scans: filtros convertidos (página, inReview) e campo desconhecido recusado', async () => {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/scans`)
      .query({ verdict: 'HOLD', stage: 'OUTPUT', rule: 'S3', inReview: 'true', page: '2', limit: '10' });
    expect(res.status).toBe(200);
    expect(review.listScans).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'HOLD', stage: 'OUTPUT', rule: 'S3', inReview: true, page: 2, limit: 10 }),
    );
    const bad = await request(app.getHttpServer()).get(`${BASE}/scans`).query({ verdict: 'TALVEZ' });
    expect(bad.status).toBe(400);
    const extra = await request(app.getHttpServer()).get(`${BASE}/scans`).query({ url: '1' });
    expect(extra.status).toBe(400);
  });

  it('GET media: motivo obrigatório; o serviço recebe o motivo sem espaços, quem e o IP do 1º salto', async () => {
    const none = await request(app.getHttpServer()).get(`${BASE}/scans/scan-1/media`);
    expect(none.status).toBe(400);
    const short = await request(app.getHttpServer())
      .get(`${BASE}/scans/scan-1/media`)
      .query({ reason: 'curto' });
    expect(short.status).toBe(400);
    expect(review.mediaUrl).not.toHaveBeenCalled();

    const res = await request(app.getHttpServer())
      .get(`${BASE}/scans/scan-1/media`)
      .set('x-forwarded-for', '198.51.100.4, 10.0.0.1')
      .query({ reason: `  ${REASON}  ` });
    expect(res.status).toBe(200);
    expect(review.mediaUrl).toHaveBeenCalledWith('scan-1', REASON, {
      id: 'rev-1',
      email: 'revisor@theaimodelab.com',
      ip: '198.51.100.4',
    });
  });

  it.each([
    ['ação desconhecida', { action: 'apagar', reason: REASON }],
    ['sem motivo', { action: 'confirm' }],
    ['report sem canal', { action: 'report', reason: REASON }],
    ['canal desconhecido', { action: 'report', reason: REASON, channel: 'email' }],
    ['protocolo com caractere fora do formato', { action: 'report', reason: REASON, channel: 'cnca', protocol: 'a b<c>' }],
    ['campo a mais', { action: 'confirm', reason: REASON, actorId: 'outra-pessoa' }],
  ])('POST decision: %s = 400', async (_name, body) => {
    const res = await request(app.getHttpServer()).post(`${BASE}/scans/scan-1/decision`).send(body);
    expect(res.status).toBe(400);
    expect(review.decide).not.toHaveBeenCalled();
  });

  it('POST decision report: canal e protocolo chegam ao serviço', async () => {
    const res = await request(app.getHttpServer())
      .post(`${BASE}/scans/scan-1/decision`)
      .send({ action: 'report', reason: REASON, channel: 'ncmec', protocol: 'CT-123/2026' });
    expect(res.status).toBe(200);
    expect(review.decide).toHaveBeenCalledWith(
      'scan-1',
      { action: 'report', reason: REASON, channel: 'ncmec', protocol: 'CT-123/2026' },
      expect.objectContaining({ id: 'rev-1' }),
    );
  });

  it('GET metrics: janela padrão de 7 dias, máximo 30', async () => {
    await request(app.getHttpServer()).get(`${BASE}/metrics`);
    expect(review.metrics).toHaveBeenCalledWith(7);
    const bad = await request(app.getHttpServer()).get(`${BASE}/metrics`).query({ days: '31' });
    expect(bad.status).toBe(400);
  });
});

describe('Rotas do revisor sem o SafetyReviewModule montado', () => {
  it('respondem 503 (nunca caem para outro caminho)', async () => {
    const app = await createApp({ review: null, user: () => REVIEWER });
    const res = await request(app.getHttpServer()).get(`${BASE}/scans`);
    expect(res.status).toBe(503);
    await app.close();
  });
});

describe('SafetyReviewerGuard', () => {
  const contextOf = (user: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sem configuração ou com a lista vazia ninguém entra', () => {
    expect(() => new SafetyReviewerGuard(null).canActivate(contextOf(REVIEWER))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      new SafetyReviewerGuard({ reviewerIds: new Set() }).canActivate(contextOf(REVIEWER)),
    ).toThrow(ForbiddenException);
  });

  it('sem usuário: 403; revisor ADMIN na lista: entra', () => {
    const guard = new SafetyReviewerGuard({ reviewerIds: new Set(['rev-1']) });
    expect(() => guard.canActivate(contextOf(undefined))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextOf(REVIEWER))).toBe(true);
  });

  it('ADMIN fora da lista: 403 e aviso no log (sem dizer quem pode)', () => {
    const guard = new SafetyReviewerGuard({ reviewerIds: new Set(['rev-1']) });
    expect(() => guard.canActivate(contextOf(OTHER_ADMIN))).toThrow(SAFETY_REVIEWER_FORBIDDEN);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining('adm-9'));
  });
});
