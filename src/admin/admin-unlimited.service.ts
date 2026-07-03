import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, JobType, Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { GENERATION_UNLIMITED_QUEUE } from '../generations/queue/generation-queue.constants';
import { UnlimitedService } from '../unlimited/unlimited.service';

const VALID_STATUS: JobType[] = [
  'waiting',
  'active',
  'delayed',
  'completed',
  'failed',
  'paused',
];

export type UnlimitedJobStatusFilter = (typeof VALID_STATUS)[number];

@Injectable()
export class AdminUnlimitedService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(GENERATION_UNLIMITED_QUEUE)
    private readonly queue: Queue,
    private readonly unlimitedService: UnlimitedService,
  ) {}

  // ── Manual delay por usuário ───────────────────────────────────

  async setManualDelay(userId: string, delaySeconds: number, ttlMinutes: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
    if (!user) {
      throw new Error('Usuário não encontrado');
    }
    const delayMs = Math.max(0, Math.floor(delaySeconds * 1000));
    const ttlSeconds = Math.max(1, Math.floor(ttlMinutes * 60));
    await this.unlimitedService.setManualDelay(userId, delayMs, ttlSeconds);
    return { ok: true, userId, delayMs, ttlSeconds };
  }

  async clearManualDelay(userId: string) {
    await this.unlimitedService.clearManualDelay(userId);
    return { ok: true, userId };
  }

  async getManualDelay(userId: string) {
    const info = await this.unlimitedService.getManualDelayInfo(userId);
    return info ?? { delayMs: 0, ttlSeconds: 0 };
  }

  // ── Queue counts ───────────────────────────────────────────────

  async getQueueStats() {
    const counts = await this.queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
      'paused',
    );
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    const isPaused = await this.queue.isPaused();
    return {
      queueName: GENERATION_UNLIMITED_QUEUE,
      isPaused,
      counts,
      total,
    };
  }

  // ── Jobs listing ───────────────────────────────────────────────

  async listJobs(input: { status: UnlimitedJobStatusFilter; limit: number }) {
    const limit = Math.min(Math.max(input.limit || 50, 1), 200);
    const jobs = await this.queue.getJobs([input.status], 0, limit - 1, false);

    const userIds = [
      ...new Set(
        jobs
          .map((j) => (j.data as { userId?: string } | undefined)?.userId)
          .filter((u): u is string => !!u),
      ),
    ];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            email: true,
            name: true,
            subscriptions: {
              where: { status: 'ACTIVE' },
              orderBy: { currentPeriodEnd: 'desc' },
              take: 1,
              select: { plan: { select: { slug: true, name: true } } },
            },
          },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    const generationIds = [
      ...new Set(
        jobs
          .map((j) => (j.data as { generationId?: string } | undefined)?.generationId)
          .filter((g): g is string => !!g),
      ),
    ];
    const generations = generationIds.length
      ? await this.prisma.generation.findMany({
          where: { id: { in: generationIds } },
          select: {
            id: true,
            status: true,
            type: true,
            modelUsed: true,
            resolution: true,
            createdAt: true,
            completedAt: true,
          },
        })
      : [];
    const genMap = new Map(generations.map((g) => [g.id, g]));

    return jobs.map((job: Job) => {
      const data = job.data as {
        userId?: string;
        generationId?: string;
        model?: string;
        resolution?: string;
        prompt?: string;
      } | undefined;
      const user = data?.userId ? userMap.get(data.userId) : undefined;
      const generation = data?.generationId ? genMap.get(data.generationId) : undefined;
      return {
        jobId: job.id,
        jobName: job.name,
        priority: job.opts.priority ?? null,
        delayUntil: job.delay ? new Date(job.timestamp + job.delay) : null,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
        timestamp: new Date(job.timestamp),
        processedOn: job.processedOn ? new Date(job.processedOn) : null,
        finishedOn: job.finishedOn ? new Date(job.finishedOn) : null,
        failedReason: job.failedReason ?? null,
        user: user
          ? {
              id: user.id,
              email: user.email,
              name: user.name,
              planSlug: user.subscriptions[0]?.plan.slug ?? null,
              planName: user.subscriptions[0]?.plan.name ?? null,
            }
          : null,
        generation: generation
          ? {
              id: generation.id,
              status: generation.status,
              type: generation.type,
              modelUsed: generation.modelUsed,
              resolution: generation.resolution,
              createdAt: generation.createdAt,
              completedAt: generation.completedAt,
            }
          : null,
        payload: {
          model: data?.model ?? null,
          resolution: data?.resolution ?? null,
          promptPreview: data?.prompt ? data.prompt.slice(0, 200) : null,
        },
      };
    });
  }

  // ── Usage analytics (sliding window) ───────────────────────────

  async getUsageOverview() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const total = await this.prisma.unlimitedUsage.count({
      where: { createdAt: { gte: since } },
    });

    const byModel = await this.prisma.unlimitedUsage.groupBy({
      by: ['modelVariant', 'resolution'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { modelVariant: 'desc' } },
    });

    const topUsersRaw = await this.prisma.unlimitedUsage.groupBy({
      by: ['userId'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 20,
    });

    const userIds = topUsersRaw.map((u) => u.userId);
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            email: true,
            name: true,
            subscriptions: {
              where: { status: 'ACTIVE' },
              orderBy: { currentPeriodEnd: 'desc' },
              take: 1,
              select: { plan: { select: { slug: true } } },
            },
          },
        })
      : [];
    const userMap = new Map(users.map((u) => [u.id, u]));

    // Busca o delay manual de cada usuário em paralelo
    const manualDelays = await Promise.all(
      topUsersRaw.map((row) =>
        this.unlimitedService.getManualDelayInfo(row.userId).catch(() => null),
      ),
    );

    const topUsers = topUsersRaw.map((row, idx) => {
      const u = userMap.get(row.userId);
      const manualDelay = manualDelays[idx];
      return {
        userId: row.userId,
        email: u?.email ?? null,
        name: u?.name ?? null,
        planSlug: u?.subscriptions[0]?.plan.slug ?? null,
        count: row._count._all,
        manualDelay: manualDelay ?? null,
      };
    });

    return {
      windowHours: 24,
      total,
      byModel: byModel.map((row) => ({
        modelVariant: row.modelVariant,
        resolution: row.resolution,
        count: row._count._all,
      })),
      topUsers,
    };
  }
}
