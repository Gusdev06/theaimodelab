import {
  BadRequestException,
  INestApplication,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { ContentSafetyAdminController } from '../content-safety-admin.controller';
import { ContentSafetyService } from '../content-safety.service';

type Row = Record<string, any>;

const CREATED = new Date('2026-10-15T12:00:00.000Z');
const ADMIN = { id: 'admin-1', email: 'juridico@theaimodelab.com' };
const NOTE =
  'Falso positivo do provedor: foto de adulta, conferido pelo jurídico.';

/** Só o que a trilha de segurança usa no admin (listagem e liberação). */
function createPrisma(rows: Row[]) {
  const events = rows.map((row) => ({ ...row }));
  const matches = (event: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, condition]) =>
      condition === null
        ? event[key] === null || event[key] === undefined
        : event[key] === condition,
    );
  const prisma = {
    contentSafetyEvent: {
      findUnique: jest.fn(async (args: Row) => {
        const event = events.find((row) => row.id === args.where.id);
        return event ? { ...event } : null;
      }),
      updateMany: jest.fn(async (args: Row) => {
        const found = events.filter((row) => matches(row, args.where));
        found.forEach((row) => Object.assign(row, args.data));
        return { count: found.length };
      }),
      findMany: jest.fn(async (args: Row) =>
        events
          .filter((row) => matches(row, args.where))
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime(),
          )
          .slice(
            args.skip ?? 0,
            (args.skip ?? 0) + (args.take ?? events.length),
          )
          .map((row) => ({ ...row })),
      ),
      count: jest.fn(
        async (args: Row) =>
          events.filter((row) => matches(row, args.where)).length,
      ),
    },
    // trilha da liberação (gravada antes de liberar)
    contentSafetyAccessLog: {
      create: jest.fn(async (args: Row) => ({ id: 'log-1', ...args.data })),
    },
  };
  return { prisma, events };
}

const minorBlock = (extra: Row = {}): Row => ({
  id: 'evt-minor',
  userId: 'user-1',
  kind: 'MINOR_BLOCKED',
  route: 'provider:veo3-fast',
  match: 'provider',
  excerpt: 'mulher adulta na praia',
  termsVersion: '2026-10-15',
  generationId: 'gen-1',
  releasedAt: null,
  releasedBy: null,
  releaseNote: null,
  createdAt: CREATED,
  ...extra,
});

describe('ContentSafetyService.releaseMinorBlock: liberação pelo jurídico', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('grava quando, quem e a nota; o evento fica na trilha e passa a constar como liberado', async () => {
    const { prisma, events } = createPrisma([minorBlock()]);
    const service = new ContentSafetyService(prisma as never);

    const released = await service.releaseMinorBlock(
      'evt-minor',
      `  ${NOTE}  `,
      ADMIN,
    );

    expect(released).toMatchObject({
      id: 'evt-minor',
      kind: 'MINOR_BLOCKED',
      released: true,
      alreadyReleased: false,
      releasedBy: 'admin-1',
      releaseNote: NOTE,
    });
    expect(released.releasedAt).toBeInstanceOf(Date);
    expect(events).toHaveLength(1);
    expect(prisma.contentSafetyEvent.updateMany).toHaveBeenCalledWith({
      where: { id: 'evt-minor', kind: 'MINOR_BLOCKED', releasedAt: null },
      data: {
        releasedAt: expect.any(Date),
        releasedBy: 'admin-1',
        releaseNote: NOTE,
      },
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('liberado por juridico@theaimodelab.com'),
    );
  });

  it('idempotente: liberar de novo não muda data, autor nem nota', async () => {
    const { prisma } = createPrisma([minorBlock()]);
    const service = new ContentSafetyService(prisma as never);
    const first = await service.releaseMinorBlock('evt-minor', NOTE, ADMIN);

    const again = await service.releaseMinorBlock(
      'evt-minor',
      'Outra nota de outro admin, depois.',
      {
        id: 'admin-2',
        email: 'outro@theaimodelab.com',
      },
    );

    expect(again).toMatchObject({
      released: true,
      alreadyReleased: true,
      releasedBy: 'admin-1',
      releaseNote: NOTE,
    });
    expect(again.releasedAt).toEqual(first.releasedAt);
    expect(prisma.contentSafetyEvent.updateMany).toHaveBeenCalledTimes(1);
  });

  it('dois admins ao mesmo tempo: a condição grava uma vez; o 2º recebe a 1ª liberação', async () => {
    const { prisma, events } = createPrisma([minorBlock()]);
    const service = new ContentSafetyService(prisma as never);
    // o outro admin grava entre a leitura e a escrita deste
    prisma.contentSafetyEvent.updateMany.mockImplementationOnce(async () => {
      Object.assign(events[0], {
        releasedAt: CREATED,
        releasedBy: 'admin-2',
        releaseNote: 'Liberado pelo outro admin antes.',
      });
      return { count: 0 };
    });

    const result = await service.releaseMinorBlock('evt-minor', NOTE, ADMIN);

    expect(result).toMatchObject({
      alreadyReleased: true,
      releasedBy: 'admin-2',
      releaseNote: 'Liberado pelo outro admin antes.',
    });
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('a liberação vai para a trilha antes de agir; sem a trilha, 503 e nada é liberado', async () => {
    const { prisma, events } = createPrisma([minorBlock()]);
    const service = new ContentSafetyService(prisma as never);
    await service.releaseMinorBlock('evt-minor', NOTE, { ...ADMIN, ip: '198.51.100.7' });
    expect(prisma.contentSafetyAccessLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 'admin-1',
        action: 'release',
        targetType: 'event',
        targetId: 'evt-minor',
        reason: NOTE,
        ip: '198.51.100.7',
      },
    });

    const failing = createPrisma([minorBlock()]);
    failing.prisma.contentSafetyAccessLog.create.mockRejectedValueOnce(new Error('banco fora'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      new ContentSafetyService(failing.prisma as never).releaseMinorBlock('evt-minor', NOTE, ADMIN),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(failing.prisma.contentSafetyEvent.updateMany).not.toHaveBeenCalled();
    expect(failing.events[0].releasedAt).toBeNull();
    expect(events).toHaveLength(1);
  });

  it('só MINOR_BLOCKED; evento inexistente é 404; nota fora de 10 a 1000 caracteres é 400 (nada muda)', async () => {
    const { prisma } = createPrisma([
      minorBlock(),
      minorBlock({
        id: 'evt-consent',
        kind: 'CONSENT_ATTESTED',
        route: '/api/v1/generations/face-swap',
      }),
    ]);
    const service = new ContentSafetyService(prisma as never);

    await expect(
      service.releaseMinorBlock('evt-consent', NOTE, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.releaseMinorBlock('nao-existe', NOTE, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    for (const note of [
      '',
      '   curta   ',
      'x'.repeat(1001),
      undefined as unknown as string,
    ]) {
      await expect(
        service.releaseMinorBlock('evt-minor', note, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(prisma.contentSafetyEvent.updateMany).not.toHaveBeenCalled();
  });

  it('a listagem do admin traz releasedAt, releasedBy, releaseNote e released', async () => {
    const { prisma } = createPrisma([
      minorBlock(),
      minorBlock({
        id: 'evt-released',
        createdAt: new Date('2026-10-14T12:00:00.000Z'),
        releasedAt: new Date('2026-10-16T09:00:00.000Z'),
        releasedBy: 'admin-1',
        releaseNote: NOTE,
      }),
    ]);
    const service = new ContentSafetyService(prisma as never);

    const page = await service.listForAdmin(1, 50, 'MINOR_BLOCKED' as never);

    expect(page.total).toBe(2);
    expect(page.data).toEqual([
      expect.objectContaining({
        id: 'evt-minor',
        released: false,
        releasedAt: null,
        releasedBy: null,
        releaseNote: null,
      }),
      expect.objectContaining({
        id: 'evt-released',
        released: true,
        releasedAt: new Date('2026-10-16T09:00:00.000Z'),
        releasedBy: 'admin-1',
        releaseNote: NOTE,
      }),
    ]);
  });
});

/**
 * PATCH /api/v1/admin/content-safety/events/:id/release no pipeline do Nest, com o mesmo ValidationPipe global do
 * main.ts e o RolesGuard de verdade (o mesmo da listagem).
 */
describe('PATCH /api/v1/admin/content-safety/events/:id/release (HTTP)', () => {
  let app: INestApplication;
  let currentUser: { sub: string; email: string; role: string } | undefined;
  const releaseMinorBlock = jest.fn(async (id: string, note: string) => ({
    id,
    releaseNote: note,
    released: true,
    alreadyReleased: false,
  }));
  const listForAdmin = jest.fn(async () => ({
    data: [],
    total: 0,
    page: 1,
    limit: 50,
  }));

  const patch = (body: unknown, id = 'evt-minor') =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/content-safety/events/${id}/release`)
      .send(body as object);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ContentSafetyAdminController],
      providers: [
        {
          provide: ContentSafetyService,
          useValue: { releaseMinorBlock, listForAdmin },
        },
      ],
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
    releaseMinorBlock.mockClear();
    listForAdmin.mockClear();
    currentUser = {
      sub: 'admin-1',
      email: 'juridico@theaimodelab.com',
      role: 'ADMIN',
    };
  });

  it('admin com nota: 200; o serviço recebe a nota sem espaços nas pontas e quem liberou', async () => {
    const res = await patch({ note: `  ${NOTE}  ` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'evt-minor', released: true });
    expect(releaseMinorBlock).toHaveBeenCalledWith('evt-minor', NOTE, {
      id: 'admin-1',
      email: 'juridico@theaimodelab.com',
      ip: expect.anything(),
      // sem a configuração da segurança de imagem montada, ninguém é revisor
      reviewer: false,
    });
  });

  it.each([
    ['sem nota', {}],
    ['nota curta', { note: '   curta   ' }],
    ['nota longa', { note: 'x'.repeat(1001) }],
    ['nota que não é texto', { note: 12345678901 }],
    ['campo a mais', { note: NOTE, releasedBy: 'outra-pessoa' }],
  ])('%s: 400 e nada é liberado', async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(releaseMinorBlock).not.toHaveBeenCalled();
  });

  it('quem não é admin (ou sem login) recebe 403, na liberação e na listagem', async () => {
    for (const user of [
      { sub: 'user-1', email: 'cliente@exemplo.com', role: 'USER' },
      undefined,
    ]) {
      currentUser = user;
      expect((await patch({ note: NOTE })).status).toBe(403);
      expect(
        (
          await request(app.getHttpServer()).get(
            '/api/v1/admin/content-safety/events',
          )
        ).status,
      ).toBe(403);
    }
    expect(releaseMinorBlock).not.toHaveBeenCalled();
    expect(listForAdmin).not.toHaveBeenCalled();
  });

  it('listagem: kind só aceita os tipos do enum (nada herdado do objeto)', async () => {
    const ok = await request(app.getHttpServer()).get(
      '/api/v1/admin/content-safety/events?kind=MINOR_BLOCKED&page=2&limit=20',
    );
    expect(ok.status).toBe(200);
    expect(listForAdmin).toHaveBeenCalledWith(2, 20, 'MINOR_BLOCKED');
    for (const kind of ['toString', 'constructor', 'QUALQUER']) {
      const res = await request(app.getHttpServer()).get(
        `/api/v1/admin/content-safety/events?kind=${kind}`,
      );
      expect([kind, res.status]).toEqual([kind, 400]);
    }
  });
});
