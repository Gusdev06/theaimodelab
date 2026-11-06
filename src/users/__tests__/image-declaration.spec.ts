import { BadRequestException, INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CURRENT_IMAGE_DECLARATION_VERSION,
  IMAGE_DECLARATION_VERSIONS,
  isKnownImageDeclarationVersion,
} from '../image-declaration';
import { UsersController } from '../users.controller';
import { UsersService } from '../users.service';

interface UserRow {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  emailVerified: boolean;
  isActive: boolean;
  createdAt: Date;
  hasCompletedOnboarding: boolean;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
  imageDeclarationAt: Date | null;
  imageDeclarationVersion: string | null;
  country: string | null;
  locale: string;
  currency: string;
  timezone: string | null;
  taxId: string | null;
  subscriptions: unknown[];
  creditBalance: null;
  feedback: null;
}

const userRow = (extra: Partial<UserRow> = {}): UserRow => ({
  id: 'user-1',
  email: 'maria@exemplo.com',
  name: 'Maria',
  avatarUrl: null,
  role: 'USER',
  emailVerified: true,
  isActive: true,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  hasCompletedOnboarding: true,
  termsAcceptedAt: new Date('2026-10-16T00:00:00.000Z'),
  termsVersion: '2026-10-15',
  imageDeclarationAt: null,
  imageDeclarationVersion: null,
  country: null,
  locale: 'pt-BR',
  currency: 'BRL',
  timezone: null,
  taxId: null,
  subscriptions: [],
  creditBalance: null,
  feedback: null,
  ...extra,
});

interface UserWhere {
  id: string;
  isActive?: boolean;
  imageDeclarationAt?: null;
}

/** Banco em memória com os filtros que o UsersService usa (id, isActive e a trava imageDeclarationAt: null). */
function setup(rows: UserRow[]) {
  const find = (where: UserWhere) =>
    rows.find((row) => row.id === where.id && (where.isActive === undefined || row.isActive === where.isActive));
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: UserWhere }) => find(where) ?? null),
      updateMany: jest.fn(async ({ where, data }: { where: UserWhere; data: Partial<UserRow> }) => {
        const row = find(where);
        if (!row) return { count: 0 };
        if ('imageDeclarationAt' in where && row.imageDeclarationAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
  };
  return { prisma, service: new UsersService(prisma as unknown as PrismaService) };
}

describe('versões da declaração de imagens', () => {
  it('a vigente é 2026-11-06 e está na lista de aceitas', () => {
    expect(CURRENT_IMAGE_DECLARATION_VERSION).toBe('2026-11-06');
    expect(IMAGE_DECLARATION_VERSIONS).toEqual(['2026-11-06']);
    expect(isKnownImageDeclarationVersion('2026-11-06')).toBe(true);
  });

  it.each(['2026-10-15', '2099-01-01', '', 'ontem', null, undefined, 20261106])('versão fora da lista não vale: %p', (version) => {
    expect(isKnownImageDeclarationVersion(version)).toBe(false);
  });
});

describe('UsersService.declareImages', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('primeira vez: grava a data e a versão na conta e devolve o que ficou gravado', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-06T18:30:00.000Z') });
    const rows = [userRow()];
    const { service, prisma } = setup(rows);

    const result = await service.declareImages('user-1', '2026-11-06');

    expect(result).toEqual({ imageDeclarationAt: new Date('2026-11-06T18:30:00.000Z'), imageDeclarationVersion: '2026-11-06' });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', imageDeclarationAt: null },
      data: { imageDeclarationAt: new Date('2026-11-06T18:30:00.000Z'), imageDeclarationVersion: '2026-11-06' },
    });
    expect(rows[0].imageDeclarationAt).toEqual(new Date('2026-11-06T18:30:00.000Z'));
  });

  it('segunda vez (idempotente): a data e a versão da primeira declaração não mudam', async () => {
    const rows = [userRow()];
    const { service } = setup(rows);

    jest.useFakeTimers({ now: new Date('2026-11-06T18:30:00.000Z') });
    const first = await service.declareImages('user-1', '2026-11-06');
    jest.setSystemTime(new Date('2026-12-24T09:00:00.000Z'));
    const second = await service.declareImages('user-1', '2026-11-06');

    expect(second).toEqual(first);
    expect(second.imageDeclarationAt).toEqual(new Date('2026-11-06T18:30:00.000Z'));
    expect(rows[0].imageDeclarationAt).toEqual(new Date('2026-11-06T18:30:00.000Z'));
  });

  it.each(['2026-10-15', '2099-01-01', ''])('versão fora da lista (%p): 400 com mensagem clara, nada é gravado', async (version) => {
    const rows = [userRow()];
    const { service, prisma } = setup(rows);

    const error = await service.declareImages('user-1', version).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      code: 'IMAGE_DECLARATION_VERSION',
      message: expect.stringContaining('2026-11-06'),
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(rows[0].imageDeclarationAt).toBeNull();
  });

  it('conta inexistente ou desativada: 404, nada é gravado', async () => {
    const rows = [userRow({ isActive: false })];
    const { service, prisma } = setup(rows);
    await expect(service.declareImages('user-1', '2026-11-06')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.declareImages('fantasma', '2026-11-06')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(rows[0].imageDeclarationAt).toBeNull();
  });
});

describe('UsersService.getProfile: imageDeclarationAt', () => {
  it('conta que ainda não declarou: null', async () => {
    const { service } = setup([userRow()]);
    const profile = await service.getProfile('user-1');
    expect(profile.imageDeclarationAt).toBeNull();
  });

  it('conta que declarou: a data gravada', async () => {
    const declaredAt = new Date('2026-11-06T18:30:00.000Z');
    const { service } = setup([userRow({ imageDeclarationAt: declaredAt, imageDeclarationVersion: '2026-11-06' })]);
    const profile = await service.getProfile('user-1');
    expect(profile.imageDeclarationAt).toEqual(declaredAt);
    // o resto do perfil segue igual (quem não lê o campo novo não percebe diferença)
    expect(profile).toMatchObject({ id: 'user-1', termsVersion: '2026-10-15', plan: null, credits: null });
  });

  it('declarar e ler o perfil em seguida: o perfil já traz a data', async () => {
    const { service } = setup([userRow()]);
    const declared = await service.declareImages('user-1', '2026-11-06');
    const profile = await service.getProfile('user-1');
    expect(profile.imageDeclarationAt).toEqual(declared.imageDeclarationAt);
  });
});

/**
 * POST /users/me/image-declaration com o mesmo ValidationPipe global do main.ts (whitelist + forbidNonWhitelisted).
 */
describe('POST /api/v1/users/me/image-declaration', () => {
  let app: INestApplication;
  const declaredAt = new Date('2026-11-06T18:30:00.000Z');
  const declareImages = jest.fn(async (_userId: string, version: string) => ({
    imageDeclarationAt: declaredAt,
    imageDeclarationVersion: version,
  }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: { declareImages } }],
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

  beforeEach(() => declareImages.mockClear());

  it('versão vigente: 200 com a data em ISO e a versão gravada', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/users/me/image-declaration').send({ version: '2026-11-06' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imageDeclarationAt: '2026-11-06T18:30:00.000Z', imageDeclarationVersion: '2026-11-06' });
    expect(declareImages).toHaveBeenCalledWith('user-1', '2026-11-06');
  });

  it.each([
    [{ version: '2026-10-15' }],
    [{ version: '2099-01-01' }],
    [{ version: 20261106 }],
    [{}],
    [{ version: '2026-11-06', extra: true }],
  ])('corpo inválido %j: 400 sem gravar nada', async (body) => {
    const res = await request(app.getHttpServer()).post('/api/v1/users/me/image-declaration').send(body);
    expect(res.status).toBe(400);
    expect(declareImages).not.toHaveBeenCalled();
  });

  it('versão desconhecida: a mensagem diz quais versões valem', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/users/me/image-declaration').send({ version: '2026-10-15' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('Versões aceitas: 2026-11-06');
  });

  it('sem corpo: 400 (a versão é obrigatória)', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/users/me/image-declaration');
    expect(res.status).toBe(400);
    expect(declareImages).not.toHaveBeenCalled();
  });
});
