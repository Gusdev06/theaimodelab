import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminService } from '../admin.service';
import {
  createTable,
  type Row,
} from '../../content-safety/reviewer/__tests__/fake-prisma';

/**
 * Reativação pelo admin (PATCH /admin/users/:id/status) e a suspensão da camada 6: a conta suspensa por sinal de
 * menor só volta pelo revisor designado (POST /admin/content-safety/users/:id/reactivate); a desativada à mão volta
 * aqui como antes. Prisma simulado.
 */

const SUSPENDED_AT = new Date('2026-10-22T09:00:00.000Z');

function createService(users: Row[], trail: Row[] = []) {
  const user = createTable('user', users);
  const refreshToken = createTable('token');
  const contentSafetyAccessLog = createTable('log', trail);
  const prisma = {
    user,
    refreshToken,
    contentSafetyAccessLog,
    $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run(prisma),
    ),
  };
  const service = new AdminService(
    prisma as never,
    {} as never,
    {} as never,
    null,
  );
  return { service, prisma, user };
}

const suspend = (targetId: string): Row => ({
  actorId: 'system:strikes',
  action: 'suspend',
  targetType: 'user',
  targetId,
  createdAt: SUSPENDED_AT,
});

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('AdminService.toggleUserStatus e a suspensão de segurança', () => {
  it('conta suspensa pela camada 6: o admin comum não reativa (409) e nada muda', async () => {
    const { service, user } = createService(
      [{ id: 'u1', isActive: false }],
      [suspend('u1')],
    );
    await expect(service.toggleUserStatus('u1', true)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(user.rows[0].isActive).toBe(false);
  });

  it('depois da reativação pelo revisor, a conta segue a regra comum', async () => {
    const { service, user } = createService(
      [{ id: 'u1', isActive: false }],
      [
        suspend('u1'),
        {
          actorId: 'rev-1',
          action: 'reactivate',
          targetType: 'user',
          targetId: 'u1',
          createdAt: new Date(SUSPENDED_AT.getTime() + 60_000),
        },
      ],
    );
    await service.toggleUserStatus('u1', true);
    expect(user.rows[0].isActive).toBe(true);
  });

  it('conta desativada à mão (sem linha suspend): reativa como antes; desativar nunca consulta a trilha', async () => {
    const { service, user, prisma } = createService([
      { id: 'u2', isActive: false },
      { id: 'u3', isActive: true },
    ]);
    await service.toggleUserStatus('u2', true);
    expect(user.rows[0].isActive).toBe(true);
    prisma.contentSafetyAccessLog.findFirst.mockClear();
    await service.toggleUserStatus('u3', false);
    expect(user.rows[1].isActive).toBe(false);
    expect(prisma.contentSafetyAccessLog.findFirst).not.toHaveBeenCalled();
  });

  it('trilha fora do ar: não reativa (503)', async () => {
    const { service, user, prisma } = createService([
      { id: 'u1', isActive: false },
    ]);
    prisma.contentSafetyAccessLog.findFirst.mockRejectedValueOnce(
      new Error('banco fora'),
    );
    await expect(service.toggleUserStatus('u1', true)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(user.rows[0].isActive).toBe(false);
  });
});
