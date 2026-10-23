import {
  ConflictException,
  ForbiddenException,
  INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AccountErasureAdminController } from '../account-erasure.controller';
import { AccountErasureService } from '../account-erasure.service';

/**
 * POST /api/v1/admin/users/:id/erase no pipeline do Nest, com o mesmo ValidationPipe global do main.ts
 * (whitelist + forbidNonWhitelisted) e o RolesGuard de verdade. O botão do admin no site chama esta rota.
 */
describe('POST /api/v1/admin/users/:id/erase (HTTP)', () => {
  let app: INestApplication;
  let currentUser: { sub: string; email: string; role: string } = {
    sub: 'admin-1',
    email: 'admin@theaimodelab.com',
    role: 'ADMIN',
  };
  const erase = jest.fn((userId: string, options: { confirm: boolean }) =>
    Promise.resolve({ userId, anonymized: options.confirm }),
  );

  const post = (body: unknown, id = 'cuser00000000000000000000') =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/users/${id}/erase`)
      .send(body as object);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountErasureAdminController],
      providers: [{ provide: AccountErasureService, useValue: { erase } }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = currentUser;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    erase.mockClear();
    currentUser = {
      sub: 'admin-1',
      email: 'admin@theaimodelab.com',
      role: 'ADMIN',
    };
  });

  it('admin com { confirm: true, reason }: 200 com o relatório; o serviço recebe quem pediu', async () => {
    const res = await post({
      confirm: true,
      reason: 'protocolo 2026-10-16-01',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userId: 'cuser00000000000000000000',
      anonymized: true,
    });
    expect(erase).toHaveBeenCalledWith('cuser00000000000000000000', {
      confirm: true,
      reason: 'protocolo 2026-10-16-01',
      requestedBy: 'admin@theaimodelab.com',
    });
  });

  it('sem motivo também vale (reason vai null)', async () => {
    const res = await post({ confirm: true });
    expect(res.status).toBe(200);
    expect(erase).toHaveBeenCalledWith('cuser00000000000000000000', {
      confirm: true,
      reason: null,
      requestedBy: 'admin@theaimodelab.com',
    });
  });

  it('ignoreSafetyEvents com motivo de 10+ caracteres: 200 e o serviço recebe o pedido', async () => {
    const res = await post({
      confirm: true,
      reason: 'falso positivo do filtro, conferido pela equipe',
      ignoreSafetyEvents: true,
    });
    expect(res.status).toBe(200);
    expect(erase).toHaveBeenCalledWith('cuser00000000000000000000', {
      confirm: true,
      reason: 'falso positivo do filtro, conferido pela equipe',
      requestedBy: 'admin@theaimodelab.com',
      ignoreSafetyEvents: true,
    });
  });

  it('ignoreSafetyEvents false é aceito e não vai para o serviço', async () => {
    const res = await post({ confirm: true, ignoreSafetyEvents: false });
    expect(res.status).toBe(200);
    expect(erase).toHaveBeenCalledWith('cuser00000000000000000000', {
      confirm: true,
      reason: null,
      requestedBy: 'admin@theaimodelab.com',
    });
  });

  it.each([
    ['ignoreSafetyEvents sem motivo', { confirm: true, ignoreSafetyEvents: true }],
    [
      'ignoreSafetyEvents com motivo curto',
      { confirm: true, ignoreSafetyEvents: true, reason: 'engano' },
    ],
    [
      'ignoreSafetyEvents com motivo só de espaços',
      { confirm: true, ignoreSafetyEvents: true, reason: '            ' },
    ],
    [
      'ignoreSafetyEvents como texto',
      {
        confirm: true,
        ignoreSafetyEvents: 'true',
        reason: 'falso positivo conferido',
      },
    ],
  ])('%s: 400 e nada é apagado', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(erase).not.toHaveBeenCalled();
  });

  it('ignoreSafetyEvents sem motivo responde com o código do erro', async () => {
    const res = await post({ confirm: true, ignoreSafetyEvents: true });
    expect(res.body).toMatchObject({
      code: 'ACCOUNT_ERASURE_OVERRIDE_REASON_REQUIRED',
    });
  });

  it.each([
    ['corpo vazio', {}],
    ['confirm false', { confirm: false }],
    ['confirm como texto', { confirm: 'true' }],
    ['confirm como número', { confirm: 1 }],
    ['campo extra', { confirm: true, apagarTudo: true }],
    ['motivo longo demais', { confirm: true, reason: 'x'.repeat(501) }],
    ['motivo que não é texto', { confirm: true, reason: 42 }],
  ])('%s: 400 e nada é apagado', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(erase).not.toHaveBeenCalled();
  });

  it('quem não é admin: 403 e nada é apagado', async () => {
    currentUser = { sub: 'user-9', email: 'cliente@exemplo.com', role: 'USER' };
    const res = await post({ confirm: true });
    expect(res.status).toBe(403);
    expect(erase).not.toHaveBeenCalled();
  });

  it.each([
    [
      'conta alvo é admin',
      new ForbiddenException({
        code: 'ACCOUNT_ERASURE_ADMIN',
        message: 'Conta de administrador não é apagada por aqui.',
      }),
      403,
      'ACCOUNT_ERASURE_ADMIN',
    ],
    [
      'usuário inexistente',
      new NotFoundException('Usuário não encontrado'),
      404,
      undefined,
    ],
    [
      'exclusão em andamento',
      new ConflictException({
        code: 'ACCOUNT_ERASURE_IN_PROGRESS',
        message: 'Já em andamento.',
      }),
      409,
      'ACCOUNT_ERASURE_IN_PROGRESS',
    ],
  ])(
    '%s: o erro do serviço chega com o status certo',
    async (_label, error, status, code) => {
      erase.mockRejectedValueOnce(error);
      const res = await post({ confirm: true });
      expect(res.status).toBe(status);
      if (code) expect(res.body).toMatchObject({ code });
    },
  );
});
