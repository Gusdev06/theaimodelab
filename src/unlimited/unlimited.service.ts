import { Inject, Injectable, Logger } from '@nestjs/common';
import { Resolution, SubscriptionStatus } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import {
  UNLIMITED_COOLDOWN_TIERS,
  UNLIMITED_HARD_CAP,
  UNLIMITED_LOCK_KEY_PREFIX,
  UNLIMITED_LOCK_TTL_SECONDS,
  UNLIMITED_MANUAL_DELAY_KEY_PREFIX,
  UNLIMITED_REDIS,
  UNLIMITED_WINDOW_HOURS,
} from './unlimited.constants';
import {
  PlanUnlimitedModel,
  UnlimitedEligibility,
  UnlimitedPlanContext,
} from './unlimited.types';

@Injectable()
export class UnlimitedService {
  private readonly logger = new Logger(UnlimitedService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(UNLIMITED_REDIS) private readonly redis: Redis,
  ) {}

  // ── Plan resolution ───────────────────────────────────────────────────

  async getPlanContext(userId: string): Promise<UnlimitedPlanContext | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { currentPeriodEnd: 'desc' },
      include: { plan: true },
    });

    if (!subscription) return null;
    const { plan } = subscription;
    if (plan.unlimitedPriority == null || plan.unlimitedModels == null) return null;

    const models = this.parseModels(plan.unlimitedModels);
    if (models.length === 0) return null;

    return {
      planId: plan.id,
      planSlug: plan.slug,
      unlimitedPriority: plan.unlimitedPriority,
      models,
    };
  }

  isModelAllowed(
    planContext: UnlimitedPlanContext,
    modelVariant: string,
    resolution: Resolution,
  ): boolean {
    const entry = planContext.models.find((m) => m.modelVariant === modelVariant);
    return entry?.resolutions.includes(resolution) ?? false;
  }

  // ── Cooldown + sliding window ─────────────────────────────────────────

  async countUsageWindow(userId: string): Promise<number> {
    const since = new Date(Date.now() - UNLIMITED_WINDOW_HOURS * 60 * 60 * 1000);
    return this.prisma.unlimitedUsage.count({
      where: { userId, createdAt: { gte: since } },
    });
  }

  computeDelayMs(usageCount: number): { delayMs: number; hardCapHit: boolean } {
    if (usageCount >= UNLIMITED_HARD_CAP) return { delayMs: 0, hardCapHit: true };
    for (const tier of UNLIMITED_COOLDOWN_TIERS) {
      if (usageCount < tier.maxCount) return { delayMs: tier.delayMs, hardCapHit: false };
    }
    return { delayMs: 0, hardCapHit: true };
  }

  // ── High-level eligibility check ──────────────────────────────────────

  async checkEligibility(
    userId: string,
    modelVariant: string,
    resolution: Resolution,
  ): Promise<UnlimitedEligibility> {
    const planContext = await this.getPlanContext(userId);
    if (!planContext) {
      return { allowed: false, reason: 'plan_not_unlimited', delayMs: 0, usageCount: 0 };
    }

    if (!this.isModelAllowed(planContext, modelVariant, resolution)) {
      return {
        allowed: false,
        reason: 'model_not_allowed',
        planContext,
        delayMs: 0,
        usageCount: 0,
      };
    }

    const usageCount = await this.countUsageWindow(userId);
    const { delayMs: curveDelay, hardCapHit } = this.computeDelayMs(usageCount);

    if (hardCapHit) {
      return {
        allowed: false,
        reason: 'hard_cap_reached',
        planContext,
        delayMs: 0,
        usageCount,
      };
    }

    // Soma com delay manual definido por admin (se houver).
    const manualDelay = await this.getManualDelay(userId);
    const delayMs = curveDelay + manualDelay;

    return { allowed: true, planContext, delayMs, usageCount };
  }

  // ── Lock por usuário (1 ilimitada em andamento) ───────────────────────

  async acquireLock(userId: string): Promise<boolean> {
    const key = this.lockKey(userId);
    const result = await this.redis.set(key, '1', 'EX', UNLIMITED_LOCK_TTL_SECONDS, 'NX');
    return result === 'OK';
  }

  async releaseLock(userId: string): Promise<void> {
    await this.redis.del(this.lockKey(userId));
  }

  async isLocked(userId: string): Promise<boolean> {
    return (await this.redis.exists(this.lockKey(userId))) === 1;
  }

  // ── Manual delay (definido por admin pra throttle individual) ────────

  /**
   * Define um delay manual em ms pro userId. O delay é somado ao delay da
   * curva no próximo enqueue. TTL configurável — depois disso volta ao normal.
   */
  async setManualDelay(userId: string, delayMs: number, ttlSeconds: number): Promise<void> {
    if (delayMs <= 0 || ttlSeconds <= 0) {
      await this.clearManualDelay(userId);
      return;
    }
    const key = this.manualDelayKey(userId);
    await this.redis.set(key, String(delayMs), 'EX', ttlSeconds);
  }

  async getManualDelay(userId: string): Promise<number> {
    const raw = await this.redis.get(this.manualDelayKey(userId));
    if (!raw) return 0;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async getManualDelayInfo(
    userId: string,
  ): Promise<{ delayMs: number; ttlSeconds: number } | null> {
    const key = this.manualDelayKey(userId);
    const [raw, ttl] = await Promise.all([
      this.redis.get(key),
      this.redis.ttl(key),
    ]);
    if (!raw || ttl <= 0) return null;
    const delayMs = parseInt(raw, 10);
    if (!Number.isFinite(delayMs) || delayMs <= 0) return null;
    return { delayMs, ttlSeconds: ttl };
  }

  async clearManualDelay(userId: string): Promise<void> {
    await this.redis.del(this.manualDelayKey(userId));
  }

  private manualDelayKey(userId: string): string {
    return `${UNLIMITED_MANUAL_DELAY_KEY_PREFIX}${userId}`;
  }

  // ── Registro de uso (alimenta o sliding window) ───────────────────────

  async recordUsage(input: {
    userId: string;
    generationId: string;
    modelVariant: string;
    resolution: Resolution;
  }): Promise<void> {
    await this.prisma.unlimitedUsage.create({
      data: {
        userId: input.userId,
        generationId: input.generationId,
        modelVariant: input.modelVariant,
        resolution: input.resolution,
      },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private lockKey(userId: string): string {
    return `${UNLIMITED_LOCK_KEY_PREFIX}${userId}`;
  }

  private parseModels(raw: unknown): PlanUnlimitedModel[] {
    if (!Array.isArray(raw)) return [];
    const valid: PlanUnlimitedModel[] = [];
    for (const item of raw) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as PlanUnlimitedModel).modelVariant === 'string' &&
        Array.isArray((item as PlanUnlimitedModel).resolutions)
      ) {
        valid.push({
          modelVariant: (item as PlanUnlimitedModel).modelVariant,
          resolutions: (item as PlanUnlimitedModel).resolutions as Resolution[],
        });
      }
    }
    return valid;
  }
}
