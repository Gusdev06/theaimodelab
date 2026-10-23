import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { UsersController } from '../users.controller';
import { UsersService } from '../users.service';

/**
 * POST /users/me/terms com o mesmo ValidationPipe global do main.ts (whitelist + forbidNonWhitelisted):
 * o site antigo manda o POST sem corpo e não pode quebrar; o site novo manda a versão que mostrou.
 */
describe('POST /api/v1/users/me/terms', () => {
  let app: INestApplication;
  const acceptTerms = jest.fn(async (_userId: string, version?: string) => ({ termsVersion: version ?? 'legacy' }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: { acceptTerms } }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { sub: 'user-1', email: 'a@b.c', role: 'USER' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => acceptTerms.mockClear());

  it('site antigo (sem corpo) continua funcionando', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/users/me/terms');
    expect(res.status).toBe(200);
    expect(acceptTerms).toHaveBeenCalledWith('user-1', undefined);
  });

  it('site novo manda a versão que mostrou', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/users/me/terms').send({ version: '2026-10-15' });
    expect(res.status).toBe(200);
    expect(acceptTerms).toHaveBeenCalledWith('user-1', '2026-10-15');
  });

  it.each([[{ version: 'ontem' }], [{ version: 20261015 }], [{ version: '2026-10-15', extra: true }]])(
    'corpo inválido %j → 400 sem gravar nada',
    async (body) => {
      const res = await request(app.getHttpServer()).post('/api/v1/users/me/terms').send(body);
      expect(res.status).toBe(400);
      expect(acceptTerms).not.toHaveBeenCalled();
    },
  );
});
