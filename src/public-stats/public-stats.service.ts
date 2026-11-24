import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  isPublicStatsEnabled,
  PUBLIC_STATS_TTL_MS,
  toPublicStats,
  type PublicStats,
  type PublicStatsRaw,
} from './public-stats.math';

export type PublicStatsResponse = ({ enabled: true } & PublicStats) | { enabled: false };

/**
 * Contagens reais para a landing e o modal de planos (L14). Cache em memória de 1 h por instância: a rota é
 * pública e não pode virar 3 COUNT no banco a cada visita. Falha na contagem devolve o último valor bom (ou nada).
 * Desligada por padrão: PUBLIC_STATS_ENABLED=on liga.
 */
@Injectable()
export class PublicStatsService {
  private readonly logger = new Logger(PublicStatsService.name);
  private cached: { stats: PublicStats; expiresAt: number } | null = null;
  private inflight: Promise<PublicStats | null> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  isEnabled(): boolean {
    return isPublicStatsEnabled(this.config.get<string>('PUBLIC_STATS_ENABLED'));
  }

  async get(now: Date = new Date()): Promise<PublicStatsResponse> {
    if (!this.isEnabled()) return { enabled: false };
    if (this.cached && this.cached.expiresAt > now.getTime()) return { enabled: true, ...this.cached.stats };

    // uma contagem por vez: visitas simultâneas na virada do cache esperam a mesma
    this.inflight ??= this.refresh(now).finally(() => {
      this.inflight = null;
    });
    const fresh = await this.inflight;
    if (fresh) return { enabled: true, ...fresh };
    if (this.cached) return { enabled: true, ...this.cached.stats };
    return { enabled: false };
  }

  private async refresh(now: Date): Promise<PublicStats | null> {
    try {
      const raw = await this.count();
      const stats = toPublicStats(raw, now);
      this.cached = { stats, expiresAt: now.getTime() + PUBLIC_STATS_TTL_MS };
      return stats;
    } catch (error) {
      this.logger.warn(`contagem pública falhou: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async count(): Promise<PublicStatsRaw> {
    const [accounts, generations, payingRows] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.generation.count({ where: { status: 'COMPLETED' } }),
      this.prisma.payment.groupBy({ by: ['userId'], where: { status: 'COMPLETED' } }),
    ]);
    return { accounts, generations, payingCreators: payingRows.length };
  }
}
