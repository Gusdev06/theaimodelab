import { BadRequestException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { AdminService } from '../admin.service';
import { AdminController } from '../admin.controller';
import { AdminPlansController } from '../admin-plans.controller';
import { AccountErasureAdminController } from '../../users/account-erasure.controller';
import { ListUserTransactionsQueryDto } from '../dto/list-user-transactions-query.dto';
import { ListUserPaymentsQueryDto } from '../dto/list-user-payments-query.dto';
import { ListGenerationsQueryDto } from '../dto/list-generations-query.dto';
import { UpdateFxDto } from '../dto/update-fx.dto';
import { buildCreatedAtRange } from '../admin-date-filter';

/** Rotas que o painel do dono pede: extrato e pagamentos por cliente, filtros de gerações, câmbio e limite. */
function setup(overrides: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    user: { findUnique: jest.fn(async () => ({ id: 'user-1' })) },
    creditTransaction: {
      findMany: jest.fn(async () => [{ id: 'tx-1', type: 'PURCHASE', amount: 5000 }]),
      count: jest.fn(async () => 41),
      aggregate: jest.fn(async (args: any) => ({
        _sum: { amount: args.where.AND[1].amount.lt !== undefined ? -1200 : 5000 },
      })),
    },
    payment: {
      findMany: jest.fn(async () => [{ id: 'pay-1', amountCents: 1190, currency: 'USD' }]),
      count: jest.fn(async () => 3),
    },
    generation: {
      findMany: jest.fn(async () => [
        { id: 'gen-1', errorCode: 'CONTENT_SAFETY_BLOCKED', errorMessage: 'bloqueado', outputs: [] },
      ]),
      count: jest.fn(async () => 1),
    },
    appSetting: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => ({ key: 'fx_usd_brl', value: '5.65', updatedAt: new Date('2026-11-06') })),
    },
    ...overrides,
  };
  const ServiceCtor = AdminService as unknown as new (...args: unknown[]) => AdminService;
  const service = new ServiceCtor(prisma, ...Array.from({ length: 12 }, () => ({})));
  return { service, prisma };
}

function query<T>(cls: new () => T, plain: Record<string, unknown>): T {
  return plainToInstance(cls, plain);
}

describe('GET admin/users/:id/transactions', () => {
  it('pagina no formato { data, meta } e soma o período filtrado inteiro no resumo', async () => {
    const { service, prisma } = setup();

    const result = await service.getUserTransactions(
      'user-1',
      query(ListUserTransactionsQueryDto, { page: '2', limit: '10', type: 'PURCHASE', startDate: '2026-11-01', endDate: '2026-11-06' }),
    );

    expect(prisma.creditTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          type: 'PURCHASE',
          createdAt: {
            gte: new Date('2026-11-01T00:00:00.000Z'),
            lte: new Date('2026-11-06T23:59:59.999Z'),
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: 10,
        take: 10,
      }),
    );
    expect(result.meta).toEqual({ page: 2, limit: 10, total: 41, totalPages: 5 });
    expect(result.data).toHaveLength(1);
    expect(result.summary).toEqual({ spent: 1200, received: 5000, net: 3800 });
  });

  it('sem filtro: só o usuário', async () => {
    const { service, prisma } = setup();
    await service.getUserTransactions('user-1', query(ListUserTransactionsQueryDto, {}));
    expect(prisma.creditTransaction.count).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('usuário inexistente = 404', async () => {
    const { service } = setup({ user: { findUnique: jest.fn(async () => null) } });
    await expect(
      service.getUserTransactions('nao-existe', query(ListUserTransactionsQueryDto, {})),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('DTO recusa tipo e data inválidos', async () => {
    const errors = await validate(
      query(ListUserTransactionsQueryDto, { type: 'QUALQUER', startDate: 'ontem' }),
    );
    expect(errors.map((e) => e.property).sort()).toEqual(['startDate', 'type']);
  });
});

describe('GET admin/users/:id/payments', () => {
  it('pagina e filtra por status', async () => {
    const { service, prisma } = setup();

    const result = await service.getUserPayments(
      'user-1',
      query(ListUserPaymentsQueryDto, { status: 'REFUNDED' }),
    );

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', status: 'REFUNDED' },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 20,
      }),
    );
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
  });

  it('usuário inexistente = 404', async () => {
    const { service } = setup({ user: { findUnique: jest.fn(async () => null) } });
    await expect(
      service.getUserPayments('nao-existe', query(ListUserPaymentsQueryDto, {})),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GET admin/generations · from, to e errorCode', () => {
  it('aplica período e código de erro e devolve errorCode em cada item', async () => {
    const { service, prisma } = setup();

    const result = await service.getGenerations(
      query(ListGenerationsQueryDto, {
        from: '2026-11-01T00:00:00Z',
        to: '2026-11-02T12:00:00Z',
        errorCode: 'CONTENT_SAFETY_BLOCKED',
      }),
    );

    expect(prisma.generation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          errorCode: 'CONTENT_SAFETY_BLOCKED',
          createdAt: {
            gte: new Date('2026-11-01T00:00:00Z'),
            lte: new Date('2026-11-02T12:00:00Z'),
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(result.data[0]).toEqual(expect.objectContaining({ errorCode: 'CONTENT_SAFETY_BLOCKED' }));
  });

  it('sem os parâmetros novos a consulta fica igual', async () => {
    const { service, prisma } = setup();
    await service.getGenerations(query(ListGenerationsQueryDto, {}));
    expect(prisma.generation.count).toHaveBeenCalledWith({ where: {} });
  });

  it('from depois de to = 400', async () => {
    const { service } = setup();
    await expect(
      service.getGenerations(query(ListGenerationsQueryDto, { from: '2026-11-05', to: '2026-11-01' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DTO recusa data fora do ISO 8601', async () => {
    const errors = await validate(query(ListGenerationsQueryDto, { from: '06/11/2026' }));
    expect(errors.map((e) => e.property)).toEqual(['from']);
  });
});

describe('admin/settings/fx', () => {
  it('GET sem valor salvo devolve o padrão', async () => {
    const { service } = setup();
    await expect(service.getFxSetting()).resolves.toEqual({ fxUsdBrl: 5.4, source: 'default', updatedAt: null });
  });

  it('GET com valor salvo', async () => {
    const updatedAt = new Date('2026-11-01');
    const { service } = setup({
      appSetting: { findUnique: jest.fn(async () => ({ key: 'fx_usd_brl', value: '5,72', updatedAt })) },
    });
    await expect(service.getFxSetting()).resolves.toEqual({ fxUsdBrl: 5.72, source: 'app_settings', updatedAt });
  });

  it('PATCH faz upsert na chave fx_usd_brl', async () => {
    const { service, prisma } = setup();
    const result = await service.updateFxSetting(5.65);
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'fx_usd_brl' },
      create: { key: 'fx_usd_brl', value: '5.65' },
      update: { value: '5.65' },
    });
    expect(result.fxUsdBrl).toBe(5.65);
  });

  it.each([0, -1, 100, 250])('PATCH recusa %p', async (fx) => {
    const { service, prisma } = setup();
    await expect(service.updateFxSetting(fx)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.appSetting.upsert).not.toHaveBeenCalled();
    expect(await validate(plainToInstance(UpdateFxDto, { fxUsdBrl: fx }))).not.toHaveLength(0);
  });

  it('DTO aceita 5.4', async () => {
    expect(await validate(plainToInstance(UpdateFxDto, { fxUsdBrl: 5.4 }))).toHaveLength(0);
  });
});

describe('buildCreatedAtRange', () => {
  it('sem datas = undefined', () => {
    expect(buildCreatedAtRange()).toBeUndefined();
  });

  it('só uma ponta', () => {
    expect(buildCreatedAtRange(undefined, '2026-11-06')).toEqual({ lte: new Date('2026-11-06T23:59:59.999Z') });
  });
});

describe('limite das rotas de admin', () => {
  it.each([
    ['AdminController', AdminController],
    ['AdminPlansController', AdminPlansController],
    ['AccountErasureAdminController', AccountErasureAdminController],
  ])('%s: 300 req/min no throttler default', (_name, controller) => {
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, controller)).toBe(300);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, controller)).toBe(60_000);
  });
});
