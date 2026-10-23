import {
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of, throwError, toArray } from 'rxjs';
import {
  loadAccessLogConfig,
  type AccessLogConfig,
} from '../access-log.config';
import {
  AccessLogInterceptor,
  type AccessLogRequest,
} from '../access-log.interceptor';
import { matchAccessRoute } from '../access-log.routes';
import type { AccessLogEntry, AccessLogService } from '../access-log.service';

/**
 * Registro de acesso no pedido: rotas certas, conta certa, IP só de cabeçalho confiável e nunca derruba o pedido.
 * IPs de documentação (RFC 5737); ids no formato cuid inventados.
 */

const CLIENT = '203.0.113.7';
const ATTACKER = '192.0.2.66';
const USER_ID = 'cmusr0000000000000000001a';
const GENERATION_ID = 'cmgen0000000000000000001a';
const UA = 'Mozilla/5.0 (teste)';

function configWith(values: Record<string, string>): AccessLogConfig {
  return loadAccessLogConfig((key) => values[key]).config;
}

const behindOneProxy = configWith({
  TRUSTED_PROXY_IPS: 'loopback',
  TRUSTED_PROXY_HOPS: '1',
});
const noProxy = configWith({});

function httpContext(req: AccessLogRequest, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function handlerOf(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

function failingHandler(error: unknown): CallHandler {
  return { handle: () => throwError(() => error) };
}

function viaProxy(overrides: Partial<AccessLogRequest> = {}): AccessLogRequest {
  return {
    method: 'POST',
    headers: {
      'x-forwarded-for': `${ATTACKER}, ${CLIENT}`,
      'x-real-port': '51234',
      'user-agent': UA,
    },
    socket: { remoteAddress: '::ffff:127.0.0.1', remotePort: 40000 },
    ...overrides,
  };
}

function setup(config: AccessLogConfig = behindOneProxy) {
  const record = jest.fn<void, [AccessLogEntry | readonly AccessLogEntry[]]>();
  const service = { record } as unknown as AccessLogService;
  const interceptor = new AccessLogInterceptor(service, config);
  const recorded = (): AccessLogEntry[] =>
    record.mock.calls.flatMap(([entries]) =>
      Array.isArray(entries) ? entries : [entries],
    );
  return { interceptor, record, recorded };
}

describe('matchAccessRoute', () => {
  it.each([
    ['POST', '/api/v1/auth/login', 'login'],
    ['POST', '/api/v1/auth/register', 'register'],
    ['POST', '/api/v1/auth/refresh', 'refresh'],
    ['POST', '/api/v1/auth/google', 'google'],
    ['GET', '/api/v1/auth/google/callback', 'google'],
    ['POST', '/api/v1/generations/generate-image', 'generation'],
    ['POST', '/api/v1/generations/minimax-h3-image-to-video', 'generation'],
    ['POST', '/api/v1/avatars/:id/generate-video', 'generation'],
    ['POST', '/api/v1/avatars', 'generation'],
    ['POST', '/api/v1/agent/chat', 'generation'],
  ])('%s %s entra como %s', (method, path, kind) => {
    expect(matchAccessRoute(method, path)?.kind).toBe(kind);
  });

  it.each([
    ['GET', '/api/v1/generations'],
    ['GET', '/api/v1/generations/:id'],
    ['POST', '/api/v1/generations/:id/favorite'],
    ['DELETE', '/api/v1/generations/:id'],
    ['POST', '/api/v1/auth/logout'],
    ['POST', '/api/v1/auth/forgot-password'],
    ['GET', '/api/v1/auth/google'],
    ['GET', '/api/v1/auth/login'],
    ['POST', '/api/v1/reports'],
  ])('%s %s fica fora', (method, path) => {
    expect(matchAccessRoute(method, path)).toBeNull();
  });
});

describe('AccessLogInterceptor', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('login certo: grava a conta da resposta, o IP do cabeçalho do proxy confiável, a porta e o horário do pedido', async () => {
    const { interceptor, recorded } = setup();
    const response = {
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: USER_ID },
    };
    const before = Date.now();
    const result = await lastValueFrom(
      interceptor.intercept(
        httpContext(viaProxy({ route: { path: '/api/v1/auth/login' } })),
        handlerOf(response),
      ),
    );
    expect(result).toBe(response);
    const [entry] = recorded();
    expect(entry).toEqual({
      userId: USER_ID,
      route: 'POST /api/v1/auth/login',
      generationId: null,
      ip: CLIENT,
      port: 51234,
      userAgent: UA,
      at: expect.any(Date),
    });
    expect(entry.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(recorded()).toHaveLength(1);
  });

  it('login errado: o erro passa intacto e a tentativa fica gravada sem conta', async () => {
    const { interceptor, recorded } = setup();
    const failure = new Error('Email ou senha inválidos');
    await expect(
      lastValueFrom(
        interceptor.intercept(
          httpContext(viaProxy({ route: { path: '/api/v1/auth/login' } })),
          failingHandler(failure),
        ),
      ),
    ).rejects.toBe(failure);
    expect(recorded()).toEqual([
      expect.objectContaining({
        userId: null,
        ip: CLIENT,
        route: 'POST /api/v1/auth/login',
      }),
    ]);
  });

  it('sem proxy declarado: x-forwarded-for, x-real-ip e porta do cabeçalho são ignorados (vale o socket)', async () => {
    const { interceptor, recorded } = setup(noProxy);
    const req = viaProxy({
      route: { path: '/api/v1/auth/refresh' },
      headers: {
        'x-forwarded-for': CLIENT,
        'x-real-ip': CLIENT,
        'x-real-port': '1',
        'user-agent': UA,
      },
      socket: { remoteAddress: ATTACKER, remotePort: 5555 },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({ user: { id: USER_ID } }),
      ),
    );
    expect(recorded()).toEqual([
      expect.objectContaining({ ip: ATTACKER, port: 5555, userId: USER_ID }),
    ]);
  });

  it('socket que não é o proxy declarado: o cabeçalho forjado não vale', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({
      route: { path: '/api/v1/auth/login' },
      socket: { remoteAddress: ATTACKER, remotePort: 5555 },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({ user: { id: USER_ID } }),
      ),
    );
    expect(recorded()[0]).toEqual(
      expect.objectContaining({ ip: ATTACKER, port: 5555 }),
    );
  });

  it('geração: conta do token e id da geração criada', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({
      route: { path: '/api/v1/generations/generate-image' },
      user: { sub: USER_ID },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({ id: GENERATION_ID, status: 'PENDING' }),
      ),
    );
    expect(recorded()).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        generationId: GENERATION_ID,
        route: 'POST /api/v1/generations/generate-image',
      }),
    ]);
  });

  it('pedido de geração barrado (trava de menor no interceptor do controller): a tentativa fica com a conta do token', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({
      route: { path: '/api/v1/generations/face-swap' },
      user: { sub: USER_ID },
    });
    const blocked = Object.assign(new Error('blocked'), { status: 422 });
    await expect(
      lastValueFrom(
        interceptor.intercept(httpContext(req), failingHandler(blocked)),
      ),
    ).rejects.toBe(blocked);
    expect(recorded()).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        generationId: null,
        ip: CLIENT,
      }),
    ]);
  });

  it('agente: uma linha por geração criada, sem repetição', async () => {
    const { interceptor, recorded } = setup();
    const second = 'cmgen0000000000000000002b';
    const req = viaProxy({
      route: { path: '/api/v1/agent/chat' },
      user: { sub: USER_ID },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({
          reply: 'ok',
          generationIds: [
            GENERATION_ID,
            second,
            GENERATION_ID,
            42,
            'id com espaço',
          ],
        }),
      ),
    );
    expect(recorded().map((entry) => entry.generationId)).toEqual([
      GENERATION_ID,
      second,
    ]);
  });

  it('agente sem geração: uma linha só, sem geração', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({
      route: { path: '/api/v1/agent/chat' },
      user: { sub: USER_ID },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({ reply: 'oi', generationIds: [] }),
      ),
    );
    expect(recorded()).toEqual([
      expect.objectContaining({ generationId: null, userId: USER_ID }),
    ]);
  });

  it('avatar falante: rota com :id (sem o id do avatar) e a geração de { generationId }', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({
      route: { path: '/api/v1/avatars/:id/generate-video' },
      originalUrl: '/api/v1/avatars/cmava0000000000000000001a/generate-video',
      user: { sub: USER_ID },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({
          generationId: GENERATION_ID,
          status: 'PENDING',
          creditsConsumed: 1,
        }),
      ),
    );
    expect(recorded()[0]).toEqual(
      expect.objectContaining({
        route: 'POST /api/v1/avatars/:id/generate-video',
        generationId: GENERATION_ID,
      }),
    );
  });

  it('criação de avatar: o id da resposta é do avatar, não vira geração', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({
      route: { path: '/api/v1/avatars' },
      user: { sub: USER_ID },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({ id: 'cmava0000000000000000001a' }),
      ),
    );
    expect(recorded()[0]).toEqual(
      expect.objectContaining({ generationId: null, userId: USER_ID }),
    );
  });

  it('callback do Google: a conta vem da resposta; o perfil do Google em req.user nunca vira conta', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({
      method: 'GET',
      route: { path: '/api/v1/auth/google/callback' },
      user: { sub: 'google-profile-sub-123', email: 'pessoa@example.com' },
    });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({ user: { id: USER_ID } }),
      ),
    );
    await expect(
      lastValueFrom(
        interceptor.intercept(httpContext(req), failingHandler(new Error('x'))),
      ),
    ).rejects.toThrow('x');
    expect(recorded().map((entry) => entry.userId)).toEqual([USER_ID, null]);
  });

  it('sem a rota declarada: casa pela URL normalizada', async () => {
    const { interceptor, recorded } = setup();
    const req = viaProxy({ originalUrl: '/API/v1//Auth/Login/?next=1' });
    await lastValueFrom(
      interceptor.intercept(
        httpContext(req),
        handlerOf({ user: { id: USER_ID } }),
      ),
    );
    expect(recorded()[0].route).toBe('POST /api/v1/auth/login');
  });

  it.each([
    ['GET', '/api/v1/generations'],
    ['POST', '/api/v1/generations/:id/favorite'],
    ['POST', '/api/v1/auth/logout'],
  ])(
    'rota fora do registro (%s %s): passa sem gravar',
    async (method, path) => {
      const { interceptor, record } = setup();
      const value = { ok: true };
      const result = await lastValueFrom(
        interceptor.intercept(
          httpContext(
            viaProxy({ method, route: { path }, user: { sub: USER_ID } }),
          ),
          handlerOf(value),
        ),
      );
      expect(result).toBe(value);
      expect(record).not.toHaveBeenCalled();
    },
  );

  it('contexto que não é HTTP: passa sem gravar', async () => {
    const { interceptor, record } = setup();
    await lastValueFrom(
      interceptor.intercept(httpContext(viaProxy(), 'rpc'), handlerOf(1)),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('falha ao gravar nunca derruba o pedido', async () => {
    const { interceptor, record } = setup();
    record.mockImplementation(() => {
      throw new Error('banco fora');
    });
    const response = { user: { id: USER_ID } };
    await expect(
      lastValueFrom(
        interceptor.intercept(
          httpContext(viaProxy({ route: { path: '/api/v1/auth/login' } })),
          handlerOf(response),
        ),
      ),
    ).resolves.toBe(response);
  });

  it('falha ao ler o pedido nunca derruba o pedido', async () => {
    const { interceptor, record } = setup();
    const req = viaProxy({ route: { path: '/api/v1/auth/login' } });
    Object.defineProperty(req, 'headers', {
      get() {
        throw new Error('cabeçalho quebrado');
      },
    });
    await expect(
      lastValueFrom(interceptor.intercept(httpContext(req), handlerOf('ok'))),
    ).resolves.toBe('ok');
    expect(record).not.toHaveBeenCalled();
  });

  it('grava uma vez só, mesmo que o handler emita mais de um valor', async () => {
    const { interceptor, record } = setup();
    const req = viaProxy({ route: { path: '/api/v1/auth/login' } });
    const handler: CallHandler = {
      handle: () => of({ user: { id: USER_ID } }, { user: { id: 'outro' } }),
    };
    await lastValueFrom(
      interceptor.intercept(httpContext(req), handler).pipe(toArray()),
    );
    expect(record).toHaveBeenCalledTimes(1);
  });
});
