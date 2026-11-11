import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { PrismaService } from './prisma/prisma.service';

/** Tempo máximo de cada checagem: o monitor precisa de resposta rápida mesmo com o banco travado. */
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

export type DependencyStatus = 'ok' | 'fail';

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: { database: DependencyStatus; redis: DependencyStatus };
  uptimeSeconds: number;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: sem resposta em ${HEALTH_CHECK_TIMEOUT_MS} ms`)), HEALTH_CHECK_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Injectable()
export class AppService implements OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);
  private redis: Redis | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  getHello(): string {
    return 'Hello World!';
  }

  /**
   * Saúde de verdade (GET /health): o "Hello World" da raiz responde 200 mesmo com o banco ou o Redis fora.
   * Postgres (SELECT 1) e Redis (PING), cada um com teto de 3 s. Nunca lança: quem chama decide o status HTTP.
   */
  async health(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([
      this.check('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.check('redis', () => this.redisClient().ping()),
    ]);
    return {
      status: database === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      checks: { database, redis },
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  private async check(label: string, probe: () => Promise<unknown>): Promise<DependencyStatus> {
    try {
      await withTimeout(probe(), label);
      return 'ok';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`health: ${label} falhou: ${message}`);
      return 'fail';
    }
  }

  /** Uma conexão só para o PING, aberta na primeira checagem (não pesa no boot nem nos testes). */
  private redisClient(): Redis {
    if (!this.redis) {
      const url = this.configService.get<string>('REDIS_URL');
      if (!url) throw new Error('REDIS_URL não configurado');
      this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      this.redis.on('error', () => undefined); // o erro aparece na checagem; sem isso o ioredis loga a cada tentativa
    }
    return this.redis;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) await this.redis.quit().catch(() => undefined);
  }
}
