import {
  Controller,
  Get,
  Global,
  Injectable,
  Logger,
  Module,
  Post,
  Req,
  UnprocessableEntityException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessLogRetentionCron } from '../access-log-retention.cron';
import { configureTrustProxy } from '../access-log.config';
import { AccessLogModule } from '../access-log.module';
import { AccessLogService } from '../access-log.service';

/**
 * Pipeline real do Nest com Express (supertest): o interceptor entra pelo módulo (APP_INTERCEPTOR) sem decorar nada,
 * casa a rota declarada do Express, lê o socket de verdade e só confia no x-forwarded-for com proxy declarado; o
 * req.ip do Express (o do throttler) sai igual ao gravado. IPs de documentação (RFC 5737).
 */

const USER_ID = 'cmusr0000000000000000001a';
const GENERATION_ID = 'cmgen0000000000000000001a';
const CLIENT = '203.0.113.7';
const FORGED = '192.0.2.66';

interface RequestLike {
  ip?: string;
  path?: string;
  user?: unknown;
}

@Controller('api/v1/auth')
class FakeAuthController {
  @Post('login')
  login(@Req() req: RequestLike) {
    return {
      accessToken: 'a',
      refreshToken: 'r',
      user: { id: USER_ID },
      seenIp: req.ip,
    };
  }
}

@Controller('api/v1/generations')
class FakeGenerationsController {
  @Post('generate-image')
  generate() {
    return { id: GENERATION_ID, status: 'PENDING' };
  }

  @Post('face-swap')
  faceSwap(): never {
    throw new UnprocessableEntityException('bloqueado');
  }

  @Get()
  list() {
    return [];
  }
}

/** Faz o papel do JwtAuthGuard global: põe a conta do token no pedido antes dos interceptors. */
@Injectable()
class FakeJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequestLike>();
    if (req.path?.startsWith('/api/v1/generations'))
      req.user = { sub: USER_ID };
    return true;
  }
}

async function boot(env: Record<string, string>) {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    accessLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return { id: `log-${rows.length}` };
      }),
      createMany: jest.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          rows.push(...data);
          return { count: data.length };
        },
      ),
    },
  };

  @Global()
  @Module({
    providers: [{ provide: PrismaService, useValue: prisma }],
    exports: [PrismaService],
  })
  class FakePrismaModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => env],
      }),
      FakePrismaModule,
      AccessLogModule,
    ],
    controllers: [FakeAuthController, FakeGenerationsController],
    providers: [{ provide: APP_GUARD, useClass: FakeJwtGuard }],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  // o mesmo passo do main.ts
  const trusted = configureTrustProxy(app, (key) => env[key]);
  await app.init();
  const service = moduleRef.get(AccessLogService);
  return { app, moduleRef, rows, service, trusted };
}

describe('AccessLogModule no pipeline do Nest', () => {
  let current: Awaited<ReturnType<typeof boot>> | null = null;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await current?.app.close();
    current = null;
    jest.restoreAllMocks();
  });

  it('proxy declarado (loopback, 1 salto): grava o cliente do x-forwarded-for, a porta do proxy e a conta da resposta', async () => {
    current = await boot({
      TRUSTED_PROXY_IPS: 'loopback',
      TRUSTED_PROXY_HOPS: '1',
    });
    expect(current.trusted).toBe(true);

    const response = await request(current.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', `${FORGED}, ${CLIENT}`)
      .set('X-Real-Port', '51234')
      .set('User-Agent', 'agente-de-teste')
      .send({})
      .expect(201);
    await current.service.flush();

    // o throttler (req.ip) e o registro enxergam o mesmo cliente
    expect(response.body.seenIp).toBe(CLIENT);
    expect(current.rows).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        route: 'POST /api/v1/auth/login',
        generationId: null,
        ip: CLIENT,
        port: 51234,
        userAgent: 'agente-de-teste',
        createdAt: expect.any(Date),
      }),
    ]);
  });

  it('sem proxy declarado: o Express não muda e os cabeçalhos forjados não valem (fica o socket)', async () => {
    current = await boot({});
    expect(current.trusted).toBe(false);

    const response = await request(current.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', CLIENT)
      .set('X-Real-IP', CLIENT)
      .set('X-Real-Port', '1')
      .send({})
      .expect(201);
    await current.service.flush();

    expect(response.body.seenIp).not.toBe(CLIENT);
    const [row] = current.rows;
    expect(['127.0.0.1', '::1']).toContain(row.ip);
    expect(row.port).toEqual(expect.any(Number));
    expect(row.port).not.toBe(1);
  });

  it('geração criada: conta do token e id da geração; pedido barrado: a tentativa fica gravada', async () => {
    current = await boot({ TRUSTED_PROXY_IPS: 'loopback' });
    const server = current.app.getHttpServer();

    await request(server)
      .post('/api/v1/generations/generate-image')
      .set('X-Forwarded-For', CLIENT)
      .send({})
      .expect(201);
    await request(server)
      .post('/api/v1/generations/face-swap')
      .set('X-Forwarded-For', CLIENT)
      .send({})
      .expect(422);
    await request(server).get('/api/v1/generations').expect(200);
    await current.service.flush();

    expect(current.rows).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        generationId: GENERATION_ID,
        route: 'POST /api/v1/generations/generate-image',
        ip: CLIENT,
      }),
      expect.objectContaining({
        userId: USER_ID,
        generationId: null,
        route: 'POST /api/v1/generations/face-swap',
        ip: CLIENT,
      }),
    ]);
  });

  it('o cron de apagamento resolve pelo módulo', async () => {
    current = await boot({});
    expect(current.moduleRef.get(AccessLogRetentionCron)).toBeInstanceOf(
      AccessLogRetentionCron,
    );
  });
});
