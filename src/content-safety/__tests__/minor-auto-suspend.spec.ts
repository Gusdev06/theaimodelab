import { Logger } from '@nestjs/common';
import { ContentSafetyEventKind } from '@prisma/client';
import {
  ContentSafetyService,
  minorAutoSuspendEnabled,
  minorHoldReached,
} from '../content-safety.service';

type Row = Record<string, any>;

const USER_ID = 'user-1';
const MINUTE = 60_000;

interface FakeOptions {
  role?: 'USER' | 'ADMIN';
  isActive?: boolean;
  /** gerações com foto enviada pela conta (generation_input_images) */
  generationsWithUpload?: string[];
  failTransaction?: boolean;
}

/** Só o que a trilha de segurança e a contagem da guarda legal leem e escrevem. */
function createFake(options: FakeOptions = {}) {
  const events: Row[] = [];
  const user = {
    id: USER_ID,
    role: options.role ?? 'USER',
    isActive: options.isActive ?? true,
    termsVersion: '2026-10-15',
  };
  const refreshTokens = [
    { userId: USER_ID, revoked: false },
    { userId: USER_ID, revoked: false },
  ];
  const uploads = new Set(options.generationsWithUpload ?? []);
  // cada evento nasce 5 min depois do anterior (tentativas distintas), salvo quando o teste fixa o horário
  let clock = Date.now() - 2 * 86_400_000;
  let sequence = 0;

  const tx = {
    user: {
      updateMany: jest.fn(async (args: Row) => {
        const { where, data } = args;
        const matches =
          where.id === user.id &&
          where.isActive === user.isActive &&
          (where.role?.not === undefined || user.role !== where.role.not);
        if (!matches) return { count: 0 };
        Object.assign(user, data);
        return { count: 1 };
      }),
    },
    refreshToken: {
      updateMany: jest.fn(async (args: Row) => {
        const found = refreshTokens.filter(
          (token) => token.userId === args.where.userId && token.revoked === args.where.revoked,
        );
        found.forEach((token) => Object.assign(token, args.data));
        return { count: found.length };
      }),
    },
  };

  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ termsVersion: user.termsVersion })),
    },
    contentSafetyEvent: {
      create: jest.fn(async (args: Row) => {
        sequence += 1;
        const row = {
          id: `evt-${sequence}`,
          releasedAt: null,
          createdAt: new Date(clock),
          ...args.data,
        };
        events.push(row);
        return { id: row.id };
      }),
      findMany: jest.fn(async (args: Row) => {
        const { where } = args;
        if (where.kind === ContentSafetyEventKind.CONSENT_ATTESTED) {
          return events
            .filter((row) => row.kind === where.kind && where.generationId.in.includes(row.generationId))
            .map((row) => ({ generationId: row.generationId }));
        }
        const since: Date = where.OR[0].createdAt.gte;
        const prefix: string = where.OR[1].route.startsWith;
        return events
          .filter(
            (row) =>
              row.userId === where.userId &&
              row.kind === where.kind &&
              row.releasedAt === null &&
              (row.createdAt >= since || String(row.route).startsWith(prefix)),
          )
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
          .map((row) => ({ ...row }));
      }),
    },
    generationInputImage: {
      findMany: jest.fn(async (args: Row) =>
        (args.where.generationId.in as string[])
          .filter((id) => uploads.has(id))
          .map((generationId) => ({ generationId })),
      ),
    },
    generation: {
      findMany: jest.fn(async (args: Row) =>
        (args.where.id.in as string[]).map((id) => ({ id, userAvatarId: null, parameters: {} })),
      ),
    },
    $transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => {
      if (options.failTransaction) throw new Error('banco fora do ar');
      return run(tx);
    }),
  };

  const service = new ContentSafetyService(prisma as never);
  const tick = (ms = 5 * MINUTE) => {
    clock += ms;
  };
  const textBlock = (excerpt: string) =>
    service.record({
      userId: USER_ID,
      kind: ContentSafetyEventKind.MINOR_BLOCKED,
      route: 'POST /api/v1/generations/generate-image-auto',
      match: 'termo',
      excerpt,
    });

  return { service, prisma, tx, user, refreshTokens, events, tick, textBlock };
}

describe('ContentSafetyService: suspensão automática da conta na guarda legal por menor', () => {
  const previousFlag = process.env.MINOR_AUTO_SUSPEND_ENABLED;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    // os casos abaixo testam a suspensão LIGADA (só com o env explícito); o padrão desligado tem teste próprio
    process.env.MINOR_AUTO_SUSPEND_ENABLED = 'true';
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousFlag === undefined) delete process.env.MINOR_AUTO_SUSPEND_ENABLED;
    else process.env.MINOR_AUTO_SUSPEND_ENABLED = previousFlag;
  });

  it('2 tentativas não suspendem; a 3ª tentativa distinta desativa a conta e revoga as sessões', async () => {
    const fake = createFake();

    await fake.textBlock('pedido um');
    fake.tick();
    await fake.textBlock('pedido dois');
    expect(fake.user.isActive).toBe(true);
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();

    fake.tick();
    const eventId = await fake.textBlock('pedido três');

    expect(eventId).toBe('evt-3');
    expect(fake.user.isActive).toBe(false);
    expect(fake.refreshTokens.every((token) => token.revoked)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`conta ${USER_ID} suspensa automaticamente`));
  });

  it('cliques em paralelo do mesmo pedido contam como 1 tentativa', async () => {
    const fake = createFake();

    for (let index = 0; index < 4; index += 1) {
      await fake.textBlock('mesmo pedido');
      fake.tick(10_000);
    }

    expect(fake.user.isActive).toBe(true);
  });

  it('bloqueio liberado pelo jurídico não conta', async () => {
    const fake = createFake();

    await fake.textBlock('pedido um');
    fake.events[0].releasedAt = new Date();
    fake.tick();
    await fake.textBlock('pedido dois');
    fake.tick();
    await fake.textBlock('pedido três');

    expect(fake.user.isActive).toBe(true);
  });

  it('1 recusa do provedor por menor em pedido com foto da conta já suspende', async () => {
    const fake = createFake({ generationsWithUpload: ['gen-foto'] });

    await fake.service.record({
      userId: USER_ID,
      kind: ContentSafetyEventKind.MINOR_BLOCKED,
      route: 'provider:veo3_fast',
      match: 'provider',
      excerpt: null,
      generationId: 'gen-foto',
    });

    expect(fake.user.isActive).toBe(false);
  });

  it('recusa do provedor sem mídia da conta conta como tentativa comum (1 só não suspende)', async () => {
    const fake = createFake();

    await fake.service.record({
      userId: USER_ID,
      kind: ContentSafetyEventKind.MINOR_BLOCKED,
      route: 'provider:veo3_fast',
      match: 'provider',
      excerpt: null,
      generationId: 'gen-texto',
    });

    expect(fake.user.isActive).toBe(true);
  });

  it('admin nunca é suspenso', async () => {
    const fake = createFake({ role: 'ADMIN' });

    for (const excerpt of ['um', 'dois', 'três']) {
      await fake.textBlock(excerpt);
      fake.tick();
    }

    expect(fake.user.isActive).toBe(true);
    expect(fake.refreshTokens.some((token) => token.revoked)).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('suspensa automaticamente'));
  });

  it('conta já desativada: não revoga de novo nem registra outra suspensão', async () => {
    const fake = createFake({ isActive: false });

    for (const excerpt of ['um', 'dois', 'três']) {
      await fake.textBlock(excerpt);
      fake.tick();
    }

    expect(fake.tx.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('suspensa automaticamente'));
  });

  it('MINOR_AUTO_SUSPEND_ENABLED=false desliga a suspensão (o bloqueio continua gravado)', async () => {
    process.env.MINOR_AUTO_SUSPEND_ENABLED = 'false';
    const fake = createFake();

    for (const excerpt of ['um', 'dois', 'três']) {
      await fake.textBlock(excerpt);
      fake.tick();
    }

    expect(fake.events).toHaveLength(3);
    expect(fake.user.isActive).toBe(true);
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
    // a conta chegou à guarda: não é suspensa, mas o caso fica no log para o dono decidir
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('decisão do dono'));
  });

  it('sem o env (padrão): 3 tentativas não suspendem a conta', async () => {
    delete process.env.MINOR_AUTO_SUSPEND_ENABLED;
    const fake = createFake();

    for (const excerpt of ['um', 'dois', 'três']) {
      await fake.textBlock(excerpt);
      fake.tick();
    }

    expect(fake.user.isActive).toBe(true);
    expect(fake.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('falha ao suspender vira log e não derruba o registro do bloqueio', async () => {
    const fake = createFake({ failTransaction: true });

    await fake.textBlock('um');
    fake.tick();
    await fake.textBlock('dois');
    fake.tick();
    const eventId = await fake.textBlock('três');

    expect(eventId).toBe('evt-3');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('suspensão automática da conta user-1 falhou'));
  });

  it('atestado de consentimento e evento sem conta não passam pela suspensão', async () => {
    const fake = createFake();

    await fake.service.record({
      userId: USER_ID,
      kind: ContentSafetyEventKind.CONSENT_ATTESTED,
      route: 'POST /api/v1/generations/generate-image-auto',
    });
    await fake.service.record({
      userId: null,
      kind: ContentSafetyEventKind.MINOR_BLOCKED,
      route: 'POST /api/v1/generations/generate-image-auto',
      excerpt: 'sem conta',
    });

    expect(fake.prisma.contentSafetyEvent.findMany).not.toHaveBeenCalled();
  });
});

describe('regras puras da suspensão automática', () => {
  it('minorHoldReached: 3 tentativas ou 1 recusa do provedor com mídia', () => {
    expect(minorHoldReached({ recent: 9, recentAttempts: 2, provider: 0 })).toBe(false);
    expect(minorHoldReached({ recent: 3, recentAttempts: 3, provider: 0 })).toBe(true);
    expect(minorHoldReached({ recent: 0, recentAttempts: 0, provider: 1 })).toBe(true);
  });

  it('minorAutoSuspendEnabled: desligado por padrão, só "true" liga (regra do dono: nunca suspender sozinho)', () => {
    expect(minorAutoSuspendEnabled({})).toBe(false);
    expect(minorAutoSuspendEnabled({ MINOR_AUTO_SUSPEND_ENABLED: '' })).toBe(false);
    expect(minorAutoSuspendEnabled({ MINOR_AUTO_SUSPEND_ENABLED: ' TRUE ' })).toBe(true);
    expect(minorAutoSuspendEnabled({ MINOR_AUTO_SUSPEND_ENABLED: 'false' })).toBe(false);
    expect(minorAutoSuspendEnabled({ MINOR_AUTO_SUSPEND_ENABLED: '1' })).toBe(false);
  });
});
