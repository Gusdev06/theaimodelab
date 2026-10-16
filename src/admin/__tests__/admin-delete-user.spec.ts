import {
  BadRequestException,
  ConflictException,
  INestApplication,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AdminController } from '../admin.controller';
import { AdminService } from '../admin.service';
import { UploadsService } from '../../uploads/uploads.service';
import {
  ACCOUNT_LEGAL_HOLD_CODE,
  erasedEmailFor,
} from '../../users/account-erasure.service';

type Row = Record<string, any>;

const cid = (tag: string): string => `c${tag}${'0'.repeat(24 - tag.length)}`;
const U = cid('user');
const G1 = cid('gena');
const P1 = cid('posta');
const CREATED = new Date('2026-10-01T12:00:00.000Z');

/** Só o que a exclusão definitiva e a guarda legal leem. */
function createPrisma(seed: {
  user?: Row | null;
  reports?: Row[];
  safetyEvents?: Row[];
  inputImages?: Row[];
}) {
  const user =
    seed.user === undefined
      ? { id: U, email: 'maria@exemplo.com', role: 'USER', isActive: true }
      : seed.user;
  const reports = seed.reports ?? [];
  const safetyEvents = seed.safetyEvents ?? [];
  const inputImages = seed.inputImages ?? [];
  const reportMatches = (report: Row, where: Row = {}): boolean => {
    if (where.status?.not && report.status === where.status.not) return false;
    if (where.id?.in && !where.id.in.includes(report.id)) return false;
    if (where.id?.gt && !(report.id > where.id.gt)) return false;
    if (where.OR) {
      const since = (where.OR as Row[]).map(
        (part) => (part.createdAt ?? part.updatedAt).gte as Date,
      )[0];
      if (!(report.createdAt >= since || report.updatedAt >= since))
        return false;
    }
    return true;
  };
  const eventMatches = (event: Row, where: Row): boolean => {
    if (where.userId !== undefined && event.userId !== where.userId) return false;
    if (where.kind !== undefined && event.kind !== where.kind) return false;
    if (where.releasedAt === null && event.releasedAt) return false;
    if (where.generationId?.in && !where.generationId.in.includes(event.generationId))
      return false;
    if (where.createdAt && !(event.createdAt >= where.createdAt.gte)) return false;
    if (where.route && !String(event.route).startsWith(where.route.startsWith))
      return false;
    if (where.OR && !(where.OR as Row[]).some((part) => eventMatches(event, part)))
      return false;
    return true;
  };

  const db = {
    user: {
      findUnique: jest.fn(async () => user),
      delete: jest.fn(async () => user),
    },
    generation: {
      findMany: jest.fn(async () => [
        { id: G1, userAvatarId: null, voiceProfileId: null },
      ]),
    },
    communityPost: {
      findMany: jest.fn(async () => [{ id: P1, generationId: G1 }]),
    },
    userAvatar: { findMany: jest.fn(async () => []) },
    voiceProfile: { findMany: jest.fn(async () => []) },
    contentReport: {
      findMany: jest.fn(async (args: Row) =>
        reports.filter((report) => reportMatches(report, args.where)),
      ),
    },
    generationInputImage: {
      findMany: jest.fn(async (args: Row) =>
        inputImages.filter((image) =>
          args.where.generationId.in.includes(image.generationId),
        ),
      ),
    },
    contentSafetyEvent: {
      count: jest.fn(
        async (args: Row) =>
          safetyEvents.filter((event) => eventMatches(event, args.where))
            .length,
      ),
      findMany: jest.fn(async (args: Row) =>
        safetyEvents
          .filter((event) => eventMatches(event, args.where))
          .map((event) => ({
            route: event.route,
            excerpt: event.excerpt ?? null,
            createdAt: event.createdAt,
            generationId: event.generationId ?? null,
          })),
      ),
    },
  };
  const prisma = {
    ...db,
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
      callback(db),
    ),
  };
  return { prisma, db };
}

function createService(seed: Parameters<typeof createPrisma>[0] = {}) {
  const fake = createPrisma(seed);
  const service = new AdminService(
    fake.prisma as never,
    {} as never,
    {} as never,
  );
  return { service, ...fake };
}

const minorReport = (extra: Row = {}): Row => ({
  id: 'rep-minor',
  category: 'MINOR',
  status: 'OPEN',
  target: `https://www.theaimodelab.com/comunidade/${P1}`,
  description: 'Parece uma menor de idade.',
  isDepictedPerson: false,
  urgent: true,
  reporterUserId: null,
  reporterEmail: 'denuncia@exemplo.com',
  evidenceReleasedAt: null,
  createdAt: CREATED,
  updatedAt: CREATED,
  ...extra,
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('era para recusar');
}

describe('AdminService.deleteUser: exclusão definitiva respeita a guarda legal', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sem guarda: apaga a conta (dentro da transação que conferiu a guarda)', async () => {
    const ctx = createService({
      reports: [
        // denúncia descartada e denúncia de outra conta não seguram
        minorReport({ id: 'rep-dismissed', status: 'DISMISSED' }),
        minorReport({ id: 'rep-other', target: cid('outra') }),
      ],
    });
    await expect(ctx.service.deleteUser(U)).resolves.toBeUndefined();
    expect(ctx.db.user.delete).toHaveBeenCalledWith({ where: { id: U } });
    expect(ctx.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['denúncia de menor citando um post da conta', { reports: [minorReport()] }],
    [
      'recusa do provedor por menor em pedido com foto enviada (antiga)',
      {
        safetyEvents: [
          {
            userId: U,
            kind: 'MINOR_BLOCKED',
            route: 'provider:veo3-fast',
            generationId: G1,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        ],
        inputImages: [{ id: 'in-1', generationId: G1 }],
      },
    ],
    [
      '3 tentativas distintas bloqueadas por menor nos últimos 90 dias',
      {
        safetyEvents: [1, 2, 3].map((hoursAgo) => ({
          userId: U,
          kind: 'MINOR_BLOCKED',
          route: '/api/v1/generations/text-to-image',
          createdAt: new Date(Date.now() - hoursAgo * 3_600_000),
        })),
      },
    ],
  ])(
    'com guarda (%s): 409 ACCOUNT_LEGAL_HOLD em português e nada apagado',
    async (_label, seed) => {
      const ctx = createService(seed);
      const error = await rejection(ctx.service.deleteUser(U));
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getStatus()).toBe(409);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: ACCOUNT_LEGAL_HOLD_CODE,
        message: expect.stringContaining('Excluir dados (LGPD)'),
      });
      expect(ctx.db.user.delete).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'recusa do provedor a pedido só com texto (sem foto, sem atestado)',
      {
        safetyEvents: [
          {
            userId: U,
            kind: 'MINOR_BLOCKED',
            route: 'provider:nano-banana',
            generationId: G1,
            excerpt: 'pedido de texto',
            createdAt: new Date(),
          },
        ],
      },
    ],
    [
      'recusa com foto liberada pelo jurídico',
      {
        safetyEvents: [
          {
            userId: U,
            kind: 'MINOR_BLOCKED',
            route: 'provider:veo3-fast',
            generationId: G1,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
            releasedAt: new Date('2026-10-10T00:00:00.000Z'),
          },
        ],
        inputImages: [{ id: 'in-1', generationId: G1 }],
      },
    ],
    [
      '4 bloqueios do mesmo clique (uma tentativa)',
      {
        safetyEvents: [1, 2, 3, 4].map(() => ({
          userId: U,
          kind: 'MINOR_BLOCKED',
          route: '/api/v1/generations/text-to-image',
          excerpt: 'mesmo pedido',
          createdAt: new Date(),
        })),
      },
    ],
  ])('sem guarda (%s): apaga a conta', async (_label, seed) => {
    const ctx = createService(seed);
    await expect(ctx.service.deleteUser(U)).resolves.toBeUndefined();
    expect(ctx.db.user.delete).toHaveBeenCalledTimes(1);
  });

  it('denúncia com a evidência liberada (confirmada) não segura mais', async () => {
    const ctx = createService({
      reports: [
        minorReport({
          status: 'ACTIONED',
          evidenceReleasedAt: new Date('2026-10-10T00:00:00.000Z'),
        }),
      ],
    });
    await ctx.service.deleteUser(U);
    expect(ctx.db.user.delete).toHaveBeenCalledTimes(1);
  });

  it('e-mail da conta citado numa denúncia segura; conta já anonimizada não tem mais o e-mail original', async () => {
    const byEmail = createService({
      reports: [minorReport({ target: 'Conta MARIA@exemplo.com' })],
    });
    await expect(byEmail.service.deleteUser(U)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const erased = createService({
      user: { id: U, email: erasedEmailFor(U), role: 'USER', isActive: false },
      reports: [minorReport({ target: 'Conta maria@exemplo.com' })],
    });
    await erased.service.deleteUser(U);
    expect(erased.db.user.delete).toHaveBeenCalledTimes(1);
  });

  it('o resto da rota não mudou: 404 para conta inexistente e 400 para admin', async () => {
    await expect(
      createService({ user: null }).service.deleteUser(U),
    ).rejects.toBeInstanceOf(NotFoundException);
    const admin = createService({
      user: { id: U, email: 'admin@x.com', role: 'ADMIN', isActive: true },
      reports: [minorReport()],
    });
    await expect(admin.service.deleteUser(U)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(admin.db.user.delete).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/admin/users/:id (HTTP)', () => {
  let app: INestApplication;
  const deleteUser = jest.fn(async (_id: string): Promise<void> => undefined);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: AdminService, useValue: { deleteUser } },
        { provide: UploadsService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { sub: 'admin-1', email: 'admin@x.com', role: 'ADMIN' };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('guarda legal: 409 com o código ACCOUNT_LEGAL_HOLD', async () => {
    const ctx = createService({ reports: [minorReport()] });
    deleteUser.mockImplementationOnce((id) => ctx.service.deleteUser(id));
    const res = await request(app.getHttpServer()).delete(
      `/api/v1/admin/users/${U}`,
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: ACCOUNT_LEGAL_HOLD_CODE });
  });

  it('sem guarda: 200 como antes', async () => {
    const res = await request(app.getHttpServer()).delete(
      `/api/v1/admin/users/${U}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Usuário excluído com sucesso',
    });
  });
});
