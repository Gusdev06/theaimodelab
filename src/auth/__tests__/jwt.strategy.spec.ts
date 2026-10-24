import {
  Controller,
  Get,
  HttpStatus,
  INestApplication,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard, PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ACCOUNT_DISABLED_CODE,
  ACTIVE_USER_CACHE_TTL_MS,
  ActiveUserCache,
  JwtStrategy,
  activeUserCache,
  invalidateActiveUser,
} from '../strategies/jwt.strategy';

const SECRET = 'segredo-jwt-de-teste';

type UserRow = { id: string; isActive: boolean };

function createPrisma(rows: UserRow[]) {
  const users = new Map(rows.map((row) => [row.id, { ...row }]));
  const findUnique = jest.fn(
    async (args: { where: { id: string }; select?: unknown }) => {
      const row = users.get(args.where.id);
      return row ? { isActive: row.isActive } : null;
    },
  );
  return { users, prisma: { user: { findUnique } }, findUnique };
}

function createStrategy(rows: UserRow[], cache = new ActiveUserCache()) {
  const fake = createPrisma(rows);
  const config = {
    getOrThrow: (key: string) => {
      if (key !== 'JWT_ACCESS_SECRET') throw new Error(`${key} ausente`);
      return SECRET;
    },
  };
  // cache próprio por teste: o único do processo (activeUserCache) ficaria com respostas de outros testes
  const strategy = new JwtStrategy(
    config as never,
    fake.prisma as never,
    cache,
  );
  return { strategy, cache, ...fake };
}

const payload = (sub: string) => ({
  sub,
  email: `${sub}@exemplo.com`,
  role: 'USER',
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('era para recusar');
}

describe('JwtStrategy: conta precisa estar ativa', () => {
  let now = Date.parse('2026-10-16T12:00:00.000Z');

  beforeEach(() => {
    now = Date.parse('2026-10-16T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('conta ativa: devolve o usuário do token e só consulta o banco 1 vez por minuto', async () => {
    const ctx = createStrategy([{ id: 'user-ativa', isActive: true }]);

    await expect(ctx.strategy.validate(payload('user-ativa'))).resolves.toEqual(
      payload('user-ativa'),
    );
    now += 30_000;
    await ctx.strategy.validate(payload('user-ativa'));
    expect(ctx.findUnique).toHaveBeenCalledTimes(1);
    expect(ctx.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-ativa' },
      select: { isActive: true },
    });
  });

  it('conta desativada ou inexistente: 401 ACCOUNT_DISABLED com mensagem em português', async () => {
    const ctx = createStrategy([{ id: 'user-bloqueada', isActive: false }]);

    for (const sub of ['user-bloqueada', 'user-que-nao-existe']) {
      const error = await rejection(ctx.strategy.validate(payload(sub)));
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getResponse()).toEqual({
        code: ACCOUNT_DISABLED_CODE,
        message: expect.stringContaining('desativada'),
      });
    }
  });

  it('conta bloqueada depois do login perde o acesso quando o cache de 1 minuto vence', async () => {
    const ctx = createStrategy([{ id: 'user-x', isActive: true }]);
    await ctx.strategy.validate(payload('user-x'));

    // bloqueio (guarda legal, exclusão, admin) com o token de 15 min ainda válido
    ctx.users.get('user-x')!.isActive = false;
    now += ACTIVE_USER_CACHE_TTL_MS - 1;
    await expect(
      ctx.strategy.validate(payload('user-x')),
    ).resolves.toBeDefined();

    now += 2;
    await expect(
      ctx.strategy.validate(payload('user-x')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // o "não" também fica no cache: conta bloqueada tentando de novo não vira uma consulta por requisição
    await expect(
      ctx.strategy.validate(payload('user-x')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ctx.findUnique).toHaveBeenCalledTimes(2);
  });

  it('requisições simultâneas da mesma conta viram 1 consulta', async () => {
    const ctx = createStrategy([{ id: 'user-y', isActive: true }]);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx.strategy.validate(payload('user-y')),
      ),
    );
    expect(results).toHaveLength(10);
    expect(ctx.findUnique).toHaveBeenCalledTimes(1);
  });

  it('banco fora: 503 (não desloga ninguém, não deixa passar) e a falha não fica no cache', async () => {
    const ctx = createStrategy([{ id: 'user-z', isActive: true }]);
    ctx.findUnique.mockRejectedValueOnce(new Error('connection refused'));

    const error = await rejection(ctx.strategy.validate(payload('user-z')));
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'AUTH_CHECK_UNAVAILABLE',
    });

    await expect(ctx.strategy.validate(payload('user-z'))).resolves.toEqual(
      payload('user-z'),
    );
    expect(ctx.findUnique).toHaveBeenCalledTimes(2);
  });

  it('conta bloqueada e invalidada (exclusão, guarda legal): perde o acesso na hora, sem esperar o cache vencer', async () => {
    const ctx = createStrategy([{ id: 'user-w', isActive: true }]);
    await ctx.strategy.validate(payload('user-w'));

    ctx.users.get('user-w')!.isActive = false;
    ctx.cache.invalidate('user-w');
    await expect(
      ctx.strategy.validate(payload('user-w')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ctx.findUnique).toHaveBeenCalledTimes(2);
  });

  it('sem cache passado, usa o único do processo: invalidateActiveUser derruba a sessão aberta', async () => {
    const ctx = createStrategy([{ id: 'user-compartilhada', isActive: true }]);
    const shared = new JwtStrategy(
      { getOrThrow: () => SECRET } as never,
      ctx.prisma as never,
    );
    await shared.validate(payload('user-compartilhada'));
    await shared.validate(payload('user-compartilhada'));
    expect(ctx.findUnique).toHaveBeenCalledTimes(1);

    ctx.users.get('user-compartilhada')!.isActive = false;
    invalidateActiveUser('user-compartilhada');
    await expect(
      shared.validate(payload('user-compartilhada')),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ctx.findUnique).toHaveBeenCalledTimes(2);
    activeUserCache.invalidate('user-compartilhada');
  });

  it('token sem sub: 401 sem consultar o banco', async () => {
    const ctx = createStrategy([]);
    await expect(
      ctx.strategy.validate({ sub: '', email: 'x', role: 'USER' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      ctx.strategy.validate(undefined as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(ctx.findUnique).not.toHaveBeenCalled();
  });
});

describe('ActiveUserCache', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tamanho limitado: cheio, sai a conta mais antiga', async () => {
    const cache = new ActiveUserCache(60_000, 2);
    const lookup = jest.fn(async () => true);

    await cache.resolve('a', lookup);
    await cache.resolve('b', lookup);
    await cache.resolve('c', lookup);
    expect(cache.size).toBe(2);
    expect(lookup).toHaveBeenCalledTimes(3);

    // 'b' e 'c' seguem no cache; 'a' saiu e volta ao banco
    await cache.resolve('b', lookup);
    await cache.resolve('c', lookup);
    expect(lookup).toHaveBeenCalledTimes(3);
    await cache.resolve('a', lookup);
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(2);
  });

  it('invalidate: a consulta que já estava em andamento não grava a resposta de antes do bloqueio', async () => {
    const cache = new ActiveUserCache(60_000, 10);
    let finishOld: (active: boolean) => void = () => undefined;
    const lookup = jest
      .fn<Promise<boolean>, [string]>()
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (finishOld = resolve)),
      )
      .mockResolvedValueOnce(false);

    const old = cache.resolve('a', lookup);
    cache.invalidate('a');
    // requisição nova depois do bloqueio vai ao banco (não reaproveita a consulta antiga)
    await expect(cache.resolve('a', lookup)).resolves.toBe(false);
    finishOld(true);
    await expect(old).resolves.toBe(true);
    // a resposta antiga (true) não entrou no cache: vale a nova (false)
    await expect(cache.resolve('a', lookup)).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(1);
  });

  it('invalidate de conta fora do cache não faz nada', () => {
    const cache = new ActiveUserCache();
    expect(() => cache.invalidate('ninguem')).not.toThrow();
    expect(cache.size).toBe(0);
  });

  it('entrada vencida sai e a conta volta ao banco', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const cache = new ActiveUserCache(100, 10);
    const lookup = jest
      .fn<Promise<boolean>, [string]>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(cache.resolve('a', lookup)).resolves.toBe(true);
    now += 100;
    await expect(cache.resolve('a', lookup)).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

/** Pelo pipeline do Nest (AuthGuard('jwt') de verdade): o status e o código chegam ao cliente. */
describe('JwtStrategy no pipeline HTTP', () => {
  @Controller('protegida')
  class ProtectedController {
    @Get()
    @UseGuards(AuthGuard('jwt'))
    ok() {
      return { ok: true };
    }
  }

  let app: INestApplication;
  const users = new Map<string, boolean>([
    ['user-ativa', true],
    ['user-bloqueada', false],
  ]);
  const findUnique = jest.fn(async (args: { where: { id: string } }) => {
    if (args.where.id === 'user-banco-fora') throw new Error('timeout');
    const isActive = users.get(args.where.id);
    return isActive === undefined ? null : { isActive };
  });
  const jwt = new JwtService({});
  const bearer = (sub: string) =>
    `Bearer ${jwt.sign({ sub, email: `${sub}@exemplo.com`, role: 'USER' }, { secret: SECRET, expiresIn: '15m' })}`;
  const get = (sub: string) =>
    request(app.getHttpServer())
      .get('/protegida')
      .set('authorization', bearer(sub));

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [ProtectedController],
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: { user: { findUnique } } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => SECRET, get: () => SECRET },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('conta ativa: 200', async () => {
    const res = await get('user-ativa');
    expect(res.status).toBe(HttpStatus.OK);
    expect(res.body).toEqual({ ok: true });
  });

  it('conta bloqueada com token ainda válido: 401 ACCOUNT_DISABLED', async () => {
    const res = await get('user-bloqueada');
    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    expect(res.body).toMatchObject({ code: ACCOUNT_DISABLED_CODE });
  });

  it('banco fora: 503, não 401', async () => {
    const res = await get('user-banco-fora');
    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(res.body).toMatchObject({ code: 'AUTH_CHECK_UNAVAILABLE' });
  });
});
