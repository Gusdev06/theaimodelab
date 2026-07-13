import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreditTransactionType,
  FreeGenerationType,
  GenerationStatus,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { ListGenerationsQueryDto } from './dto/list-generations-query.dto';
import { ListPromptTemplatesQueryDto } from './dto/list-prompt-templates-query.dto';
import { AdminStatsResponseDto } from './dto/admin-stats-response.dto';
import { CreatePromptSectionDto } from './dto/create-prompt-section.dto';
import { UpdatePromptSectionDto } from './dto/update-prompt-section.dto';
import { CreatePromptCategoryDto } from './dto/create-prompt-category.dto';
import { UpdatePromptCategoryDto } from './dto/update-prompt-category.dto';
import { CreatePromptTemplateDto } from './dto/create-prompt-template.dto';
import { UpdatePromptTemplateDto } from './dto/update-prompt-template.dto';
import { ModelsService } from '../models/models.service';
import { UploadsService } from '../uploads/uploads.service';
import { Logger } from '@nestjs/common';

const PROMPT_THUMB_WIDTH = 400;
const PROMPT_THUMB_HEIGHT = 500;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly modelsService: ModelsService,
    private readonly uploadsService: UploadsService,
  ) {}

  /**
   * Generates an optimized WebP thumbnail for a prompt template image.
   * Returns null on failure; callers should fall back to the original imageUrl.
   */
  private async generatePromptThumbnail(
    imageUrl: string,
    promptId: string,
  ): Promise<string | null> {
    try {
      return await this.uploadsService.generateThumbnailDirect(
        imageUrl,
        `thumbnails/prompts/${promptId}`,
        'thumb.webp',
        PROMPT_THUMB_WIDTH,
        PROMPT_THUMB_HEIGHT,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to generate prompt thumbnail for ${promptId}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** Models that use the AI Model Lab provider (Google Gemini / Veo) */
  private static readonly THEAIMODELAB_MODEL_PREFIXES = ['gemini-', 'veo-'];

  /** API cost per generation in centavos BRL, keyed by model:resolution */
  private static readonly API_COST_MAP: Record<string, number> = {
    'nano-banana-2:RES_1K': 23,
    'nano-banana-2:RES_2K': 34,
    'nano-banana-2:RES_4K': 51,
    'nano-banana-pro:RES_1K': 51,
    'nano-banana-pro:RES_2K': 51,
    'nano-banana-pro:RES_4K': 68,
    'kling-2.6/motion-control:RES_720P': 17,
    'kling-2.6/motion-control:RES_1080P': 26,
    'gemini-3.1-flash-image-preview:RES_1K': 23,
    'gemini-3.1-flash-image-preview:RES_2K': 34,
    'gemini-3.1-flash-image-preview:RES_4K': 51,
    'gemini-3-pro-image-preview:RES_1K': 51,
    'gemini-3-pro-image-preview:RES_2K': 51,
    'gemini-3-pro-image-preview:RES_4K': 68,
    'veo-3.1-fast-generate-001:RES_720P': 13,
    'veo-3.1-fast-generate-001:RES_1080P': 13,
    'veo-3.1-fast-generate-001:RES_4K': 40,
    'veo-3.1-generate-001:RES_720P': 27,
    'veo-3.1-generate-001:RES_1080P': 27,
    'veo-3.1-generate-001:RES_4K': 53,
  };

  private isTheaimodelabModel(modelUsed: string | null): boolean {
    if (!modelUsed) return false;
    return AdminService.THEAIMODELAB_MODEL_PREFIXES.some((prefix) =>
      modelUsed.startsWith(prefix),
    );
  }

  async getStats(): Promise<AdminStatsResponseDto> {
    const [
      totalUsers,
      activeSubscriptions,
      revenueResult,
      totalGenerations,
      pendingCount,
      processingCount,
      completedCount,
      failedCount,
      modelGroups,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.subscription.count({
        where: { status: SubscriptionStatus.ACTIVE },
      }),
      this.prisma.payment.aggregate({
        _sum: { amountCents: true },
        where: { status: 'COMPLETED' },
      }),
      this.prisma.generation.count(),
      this.prisma.generation.count({ where: { status: GenerationStatus.PENDING } }),
      this.prisma.generation.count({ where: { status: GenerationStatus.PROCESSING } }),
      this.prisma.generation.count({ where: { status: GenerationStatus.COMPLETED } }),
      this.prisma.generation.count({ where: { status: GenerationStatus.FAILED } }),
      this.prisma.generation.groupBy({
        by: ['modelUsed'],
        _count: { _all: true },
      }),
    ]);

    let theaimodelabCount = 0;
    let kieCount = 0;
    let nanoBanana2Count = 0;
    let nanoBananaProCount = 0;
    let klingCount = 0;

    for (const group of modelGroups) {
      const model = group.modelUsed;
      const count = group._count._all;

      if (this.isTheaimodelabModel(model)) {
        theaimodelabCount += count;
      } else {
        kieCount += count;
        if (model === 'nano-banana-2') {
          nanoBanana2Count += count;
        } else if (model === 'nano-banana-pro') {
          nanoBananaProCount += count;
        } else if (model?.startsWith('kling')) {
          klingCount += count;
        }
      }
    }

    return {
      totalUsers,
      activeSubscriptions,
      totalRevenueCents: revenueResult._sum.amountCents ?? 0,
      totalGenerations,
      generationsByStatus: {
        pending: pendingCount,
        processing: processingCount,
        completed: completedCount,
        failed: failedCount,
      },
      generationsByProvider: {
        theaimodelab: theaimodelabCount,
        kie: kieCount,
        kieBreakdown: {
          nanoBanana2: nanoBanana2Count,
          nanoBananaPro: nanoBananaProCount,
          kling: klingCount,
        },
      },
    };
  }

  async getUsers(query: ListUsersQueryDto) {
    const search = query.search?.trim();
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : undefined;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: {
          subscriptions: {
            where: { status: SubscriptionStatus.ACTIVE },
            include: { plan: true },
            take: 1,
          },
          creditBalance: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const data = users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
      subscription: user.subscriptions[0]
        ? {
            planSlug: user.subscriptions[0].plan.slug,
            planName: user.subscriptions[0].plan.name,
            status: user.subscriptions[0].status,
          }
        : null,
      credits: user.creditBalance
        ? {
            planCreditsRemaining: user.creditBalance.planCreditsRemaining,
            bonusCreditsRemaining: user.creditBalance.bonusCreditsRemaining,
          }
        : null,
    }));

    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        subscriptions: {
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        creditBalance: true,
        freeGenerations: true,
        generations: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            outputs: { orderBy: { order: 'asc' as const } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const freeGenerations = Object.values(FreeGenerationType).reduce(
      (acc, t) => ({ ...acc, [t]: 0 }),
      {} as Record<FreeGenerationType, number>,
    );
    for (const fg of user.freeGenerations) {
      freeGenerations[fg.type] = fg.remaining;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      isActive: user.isActive,
      emailVerified: user.emailVerified,
      oauthProvider: user.oauthProvider,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      subscription: user.subscriptions[0]
        ? {
            id: user.subscriptions[0].id,
            planSlug: user.subscriptions[0].plan.slug,
            planName: user.subscriptions[0].plan.name,
            status: user.subscriptions[0].status,
            currentPeriodStart: user.subscriptions[0].currentPeriodStart,
            currentPeriodEnd: user.subscriptions[0].currentPeriodEnd,
            cancelAtPeriodEnd: user.subscriptions[0].cancelAtPeriodEnd,
          }
        : null,
      credits: user.creditBalance
        ? {
            planCreditsRemaining: user.creditBalance.planCreditsRemaining,
            bonusCreditsRemaining: user.creditBalance.bonusCreditsRemaining,
            planCreditsUsed: user.creditBalance.planCreditsUsed,
            freeGenerations,
            periodStart: user.creditBalance.periodStart,
            periodEnd: user.creditBalance.periodEnd,
          }
        : null,
      recentGenerations: user.generations.map((gen) => ({
        id: gen.id,
        type: gen.type,
        status: gen.status,
        prompt: gen.prompt,
        resolution: gen.resolution,
        creditsConsumed: gen.creditsConsumed,
        outputs: gen.outputs?.map((o) => ({
          url: o.url,
          thumbnailUrl: o.thumbnailUrl,
          mimeType: o.mimeType,
        })) ?? [],
        createdAt: gen.createdAt,
        completedAt: gen.completedAt,
      })),
    };
  }

  async adjustCredits(
    userId: string,
    amount: number,
    description: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    await this.prisma.$transaction(async (tx) => {
      const balance = await tx.creditBalance.findUnique({
        where: { userId },
      });

      if (!balance) {
        // Create balance if it doesn't exist
        await tx.creditBalance.create({
          data: {
            userId,
            bonusCreditsRemaining: Math.max(0, amount),
            planCreditsRemaining: 0,
            planCreditsUsed: 0,
          },
        });
      } else {
        const newBonus = balance.bonusCreditsRemaining + amount;
        await tx.creditBalance.update({
          where: { userId },
          data: {
            bonusCreditsRemaining: Math.max(0, newBonus),
          },
        });
      }

      await tx.creditTransaction.create({
        data: {
          userId,
          type: CreditTransactionType.ADMIN_ADJUSTMENT,
          amount,
          source: 'bonus',
          description,
        },
      });
    });
  }

  async adjustFreeGenerations(
    userId: string,
    type: FreeGenerationType,
    amount: number,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    await this.prisma.userFreeGeneration.upsert({
      where: { userId_type: { userId, type } },
      create: { userId, type, remaining: amount },
      update: { remaining: amount },
    });
  }

  async changeUserPlan(userId: string, planSlug: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan) {
      throw new NotFoundException(`Plano "${planSlug}" não encontrado`);
    }
    if (!plan.isActive) {
      throw new BadRequestException(`Plano "${planSlug}" não está ativo`);
    }

    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    await this.prisma.$transaction(async (tx) => {
      // Cancel existing active subscription
      await tx.subscription.updateMany({
        where: {
          userId,
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE, SubscriptionStatus.TRIALING] },
        },
        data: { status: SubscriptionStatus.CANCELED },
      });

      // Create new subscription
      await tx.subscription.create({
        data: {
          userId,
          planId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          paymentProvider: 'admin',
        },
      });

      // Reset credits to new plan's allocation
      await tx.creditBalance.upsert({
        where: { userId },
        create: {
          userId,
          planCreditsRemaining: plan.creditsPerMonth,
          bonusCreditsRemaining: 0,
          planCreditsUsed: 0,
          periodStart: now,
          periodEnd: periodEnd,
        },
        update: {
          planCreditsRemaining: plan.creditsPerMonth,
          planCreditsUsed: 0,
          periodStart: now,
          periodEnd: periodEnd,
        },
      });

      // Log the transaction
      await tx.creditTransaction.create({
        data: {
          userId,
          type: CreditTransactionType.ADMIN_ADJUSTMENT,
          amount: plan.creditsPerMonth,
          source: 'plan',
          description: `Admin: plano alterado para ${plan.name}`,
        },
      });
    });
  }

  async getGenerations(query: ListGenerationsQueryDto) {
    const where: Prisma.GenerationWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.status) where.status = query.status;
    if (query.model) where.modelUsed = query.model;
    const search = query.search?.trim();
    if (search) {
      where.user = {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [generations, total] = await Promise.all([
      this.prisma.generation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: {
          user: { select: { id: true, email: true, name: true } },
          outputs: { orderBy: { order: 'asc' as const } },
        },
      }),
      this.prisma.generation.count({ where }),
    ]);

    const data = generations.map((gen) => ({
      id: gen.id,
      user: gen.user,
      type: gen.type,
      status: gen.status,
      prompt: gen.prompt,
      resolution: gen.resolution,
      durationSeconds: gen.durationSeconds,
      hasAudio: gen.hasAudio,
      modelUsed: gen.modelUsed,
      creditsConsumed: gen.creditsConsumed,
      outputUrls: gen.outputs?.map((o) => o.url) ?? [],
      errorMessage: gen.errorMessage,
      processingTimeMs: gen.processingTimeMs,
      createdAt: gen.createdAt,
      completedAt: gen.completedAt,
    }));

    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  /** Lista os modelos distintos já usados em gerações (para filtros do admin). */
  async getGenerationModels(): Promise<string[]> {
    const rows = await this.prisma.generation.findMany({
      distinct: ['modelUsed'],
      select: { modelUsed: true },
      orderBy: { modelUsed: 'asc' },
    });
    return rows
      .map((r) => r.modelUsed)
      .filter((m): m is string => !!m && m.trim().length > 0);
  }

  async toggleUserStatus(userId: string, isActive: boolean): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { isActive },
      });

      // Revoke all refresh tokens when deactivating
      if (!isActive) {
        await tx.refreshToken.updateMany({
          where: { userId, revoked: false },
          data: { revoked: true },
        });
      }
    });
  }

  async deleteUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }
    if (user.role === 'ADMIN') {
      throw new BadRequestException('Não é possível excluir um administrador');
    }

    await this.prisma.user.delete({ where: { id: userId } });
  }

  async getProviderStats() {
    const [totalByProvider, completedByProvider, failedByProvider] = await Promise.all([
      this.prisma.generation.groupBy({
        by: ['modelUsed'],
        _count: { _all: true },
        _sum: { creditsConsumed: true },
      }),
      this.prisma.generation.groupBy({
        by: ['modelUsed'],
        where: { status: GenerationStatus.COMPLETED },
        _count: { _all: true },
      }),
      this.prisma.generation.groupBy({
        by: ['modelUsed'],
        where: { status: GenerationStatus.FAILED },
        _count: { _all: true },
      }),
    ]);

    const completedMap = new Map(
      completedByProvider.map((r) => [r.modelUsed, r._count._all]),
    );
    const failedMap = new Map(
      failedByProvider.map((r) => [r.modelUsed, r._count._all]),
    );

    const providers = totalByProvider.map((r) => ({
      provider: r.modelUsed ?? 'unknown',
      total: r._count._all,
      completed: completedMap.get(r.modelUsed) ?? 0,
      failed: failedMap.get(r.modelUsed) ?? 0,
      creditsConsumed: r._sum.creditsConsumed ?? 0,
    }));

    return { providers };
  }

  async getUserGenerations(userId: string, pagination: PaginationDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const where = { userId };

    const [generations, total] = await Promise.all([
      this.prisma.generation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          outputs: { orderBy: { order: 'asc' as const } },
        },
      }),
      this.prisma.generation.count({ where }),
    ]);

    const data = generations.map((gen) => ({
      id: gen.id,
      type: gen.type,
      status: gen.status,
      prompt: gen.prompt,
      negativePrompt: gen.negativePrompt,
      resolution: gen.resolution,
      durationSeconds: gen.durationSeconds,
      hasAudio: gen.hasAudio,
      modelUsed: gen.modelUsed,
      creditsConsumed: gen.creditsConsumed,
      outputs: gen.outputs.map((o) => ({
        id: o.id,
        url: o.url,
        thumbnailUrl: o.thumbnailUrl,
        mimeType: o.mimeType,
      })),
      inputImages: [],
      isFavorited: gen.isFavorited,
      isDeleted: gen.isDeleted,
      errorMessage: gen.errorMessage,
      processingTimeMs: gen.processingTimeMs,
      createdAt: gen.createdAt,
      completedAt: gen.completedAt,
    }));

    return new PaginatedResponseDto(data, total, pagination.page, pagination.limit);
  }

  // ============================================
  // DASHBOARD STATS ENDPOINTS
  // ============================================

  async getFinancialStats(days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [
      mrrResult,
      dailyRevenue,
      revenueByPlan,
      boostSales,
      totalUsers,
      totalRevenueResult,
      apiCostRows,
    ] = await Promise.all([
      // MRR: sum of active subscription plan prices
      this.prisma.$queryRaw<[{ mrr_cents: number }]>`
        SELECT COALESCE(SUM(p.price_cents), 0)::int AS mrr_cents
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.status = 'ACTIVE'
      `,

      // Daily revenue in period
      this.prisma.$queryRaw<{ date: string; revenue_cents: number }[]>`
        SELECT DATE_TRUNC('day', created_at)::date AS date,
               COALESCE(SUM(amount_cents), 0)::int AS revenue_cents
        FROM payments
        WHERE status = 'COMPLETED'
          AND created_at >= ${since}
        GROUP BY DATE_TRUNC('day', created_at)::date
        ORDER BY date ASC
      `,

      // Revenue by plan
      this.prisma.$queryRaw<
        { plan_name: string; plan_slug: string; revenue_cents: number; payment_count: number }[]
      >`
        SELECT pl.name AS plan_name,
               pl.slug AS plan_slug,
               COALESCE(SUM(pay.amount_cents), 0)::int AS revenue_cents,
               COUNT(pay.id)::int AS payment_count
        FROM payments pay
        JOIN subscriptions sub ON sub.id = pay.subscription_id
        JOIN plans pl ON pl.id = sub.plan_id
        WHERE pay.status = 'COMPLETED'
          AND pay.type = 'SUBSCRIPTION'
          AND pay.created_at >= ${since}
        GROUP BY pl.slug, pl.name
        ORDER BY revenue_cents DESC
      `,

      // Boost (credit package) sales
      this.prisma.$queryRaw<
        { name: string; credits: number; price_cents: number; sold_count: number; total_revenue_cents: number }[]
      >`
        SELECT cp.name,
               cp.credits,
               cp.price_cents,
               COUNT(pay.id)::int AS sold_count,
               COALESCE(SUM(pay.amount_cents), 0)::int AS total_revenue_cents
        FROM payments pay
        JOIN credit_packages cp ON cp.id = pay.credit_package_id
        WHERE pay.status = 'COMPLETED'
          AND pay.type = 'CREDIT_PURCHASE'
          AND pay.created_at >= ${since}
        GROUP BY cp.id, cp.name, cp.credits, cp.price_cents
        ORDER BY total_revenue_cents DESC
      `,

      // Total users (for ARPU)
      this.prisma.user.count(),

      // Total revenue in period
      this.prisma.$queryRaw<[{ total: number }]>`
        SELECT COALESCE(SUM(amount_cents), 0)::int AS total
        FROM payments
        WHERE status = 'COMPLETED'
          AND created_at >= ${since}
      `,

      // API cost estimation: group completed generations by model+resolution
      this.prisma.$queryRaw<
        { model_used: string; resolution: string; gen_count: number }[]
      >`
        SELECT model_used,
               resolution::text AS resolution,
               COUNT(*)::int AS gen_count
        FROM generations
        WHERE status = 'COMPLETED'
          AND created_at >= ${since}
        GROUP BY model_used, resolution
      `,
    ]);

    const mrrCents = mrrResult[0]?.mrr_cents ?? 0;
    const totalRevenueCents = totalRevenueResult[0]?.total ?? 0;

    // Calculate total API cost from the cost map
    let totalApiCostCents = 0;
    for (const row of apiCostRows) {
      const key = `${row.model_used}:${row.resolution}`;
      const unitCost = AdminService.API_COST_MAP[key] ?? 0;
      totalApiCostCents += unitCost * row.gen_count;
    }

    const arpuCents = totalUsers > 0 ? Math.round(totalRevenueCents / totalUsers) : 0;
    const marginPercent =
      totalRevenueCents > 0
        ? Math.round(((totalRevenueCents - totalApiCostCents) / totalRevenueCents) * 10000) / 100
        : 0;

    return {
      mrrCents,
      dailyRevenue: dailyRevenue.map((r) => ({
        date: String(r.date),
        revenueCents: r.revenue_cents,
      })),
      revenueByPlan: revenueByPlan.map((r) => ({
        planName: r.plan_name,
        planSlug: r.plan_slug,
        revenueCents: r.revenue_cents,
        paymentCount: r.payment_count,
      })),
      boostSales: boostSales.map((r) => ({
        name: r.name,
        credits: r.credits,
        priceCents: r.price_cents,
        soldCount: r.sold_count,
        totalRevenueCents: r.total_revenue_cents,
      })),
      arpuCents,
      totalRevenueCents,
      totalApiCostCents,
      marginPercent,
    };
  }

  async getUserStats(days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setMonth(monthStart.getMonth() - 1);

    const [
      newUsersToday,
      newUsersWeek,
      newUsersMonth,
      dailyNewUsers,
      planDistribution,
      paidUsers,
      canceledRecently,
      topConsumers,
      inactiveResult,
      totalUsers,
    ] = await Promise.all([
      // New users today
      this.prisma.user.count({ where: { createdAt: { gte: todayStart } } }),

      // New users this week
      this.prisma.user.count({ where: { createdAt: { gte: weekStart } } }),

      // New users this month
      this.prisma.user.count({ where: { createdAt: { gte: monthStart } } }),

      // Daily new users in period
      this.prisma.$queryRaw<{ date: string; count: number }[]>`
        SELECT DATE_TRUNC('day', created_at)::date AS date,
               COUNT(*)::int AS count
        FROM users
        WHERE created_at >= ${since}
        GROUP BY DATE_TRUNC('day', created_at)::date
        ORDER BY date ASC
      `,

      // Plan distribution (users without active sub = 'Free')
      this.prisma.$queryRaw<{ plan_name: string; plan_slug: string; user_count: number }[]>`
        SELECT COALESCE(p.name, 'Free') AS plan_name,
               COALESCE(p.slug, 'free') AS plan_slug,
               COUNT(DISTINCT u.id)::int AS user_count
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'ACTIVE'
        LEFT JOIN plans p ON p.id = s.plan_id
        GROUP BY p.name, p.slug
        ORDER BY user_count DESC
      `,

      // Paid users (active subscription, not free plan)
      this.prisma.$queryRaw<[{ count: number }]>`
        SELECT COUNT(DISTINCT s.user_id)::int AS count
        FROM subscriptions s
        JOIN plans p ON p.id = s.plan_id
        WHERE s.status = 'ACTIVE'
          AND p.slug != 'free'
      `,

      // Canceled recently
      this.prisma.subscription.count({
        where: {
          status: SubscriptionStatus.CANCELED,
          updatedAt: { gte: since },
        },
      }),

      // Top 10 consumers by credits
      this.prisma.$queryRaw<
        { user_id: string; email: string; name: string; total_credits: number }[]
      >`
        SELECT g.user_id,
               u.email,
               u.name,
               COALESCE(SUM(g.credits_consumed), 0)::int AS total_credits
        FROM generations g
        JOIN users u ON u.id = g.user_id
        WHERE g.created_at >= ${since}
        GROUP BY g.user_id, u.email, u.name
        ORDER BY total_credits DESC
        LIMIT 10
      `,

      // Inactive users (no generations in period)
      this.prisma.$queryRaw<[{ count: number }]>`
        SELECT COUNT(*)::int AS count
        FROM users u
        WHERE NOT EXISTS (
          SELECT 1 FROM generations g
          WHERE g.user_id = u.id
            AND g.created_at >= ${since}
        )
      `,

      // Total users
      this.prisma.user.count(),
    ]);

    const paidCount = paidUsers[0]?.count ?? 0;
    const inactiveCount = inactiveResult[0]?.count ?? 0;
    const conversionRate =
      totalUsers > 0 ? Math.round((paidCount / totalUsers) * 10000) / 100 : 0;
    const churnRate =
      paidCount > 0
        ? Math.round((canceledRecently / (paidCount + canceledRecently)) * 10000) / 100
        : 0;

    return {
      newUsersToday,
      newUsersWeek,
      newUsersMonth,
      dailyNewUsers: dailyNewUsers.map((r) => ({
        date: String(r.date),
        count: r.count,
      })),
      planDistribution: planDistribution.map((r) => ({
        planName: r.plan_name,
        planSlug: r.plan_slug,
        userCount: r.user_count,
      })),
      paidUsers: paidCount,
      canceledRecently,
      topConsumers: topConsumers.map((r) => ({
        userId: r.user_id,
        email: r.email,
        name: r.name,
        totalCredits: r.total_credits,
      })),
      inactiveUsers: inactiveCount,
      totalUsers,
      conversionRate,
      churnRate,
    };
  }

  async getUsageStats(days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const tenMinutesAgo = new Date();
    tenMinutesAgo.setMinutes(tenMinutesAgo.getMinutes() - 10);

    const [
      dailyGenerations,
      byType,
      avgProcessingByModel,
      errorRateByModel,
      peakHours,
      stuckGenerations,
    ] = await Promise.all([
      // Daily generations
      this.prisma.$queryRaw<{ date: string; count: number }[]>`
        SELECT DATE_TRUNC('day', created_at)::date AS date,
               COUNT(*)::int AS count
        FROM generations
        WHERE created_at >= ${since}
        GROUP BY DATE_TRUNC('day', created_at)::date
        ORDER BY date ASC
      `,

      // By type
      this.prisma.generation.groupBy({
        by: ['type'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),

      // Avg processing time + P95 by model
      this.prisma.$queryRaw<
        { model_used: string; avg_ms: number; p95_ms: number; count: number }[]
      >`
        SELECT model_used,
               COALESCE(AVG(processing_time_ms), 0)::int AS avg_ms,
               COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY processing_time_ms), 0)::int AS p95_ms,
               COUNT(*)::int AS count
        FROM generations
        WHERE status = 'COMPLETED'
          AND processing_time_ms IS NOT NULL
          AND created_at >= ${since}
        GROUP BY model_used
        ORDER BY count DESC
      `,

      // Error rate by model
      this.prisma.$queryRaw<
        { model_used: string; total: number; failed: number; error_rate: number }[]
      >`
        SELECT model_used,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
               CASE WHEN COUNT(*) > 0
                 THEN ROUND(COUNT(*) FILTER (WHERE status = 'FAILED')::numeric / COUNT(*)::numeric * 100, 2)::float
                 ELSE 0
               END AS error_rate
        FROM generations
        WHERE created_at >= ${since}
        GROUP BY model_used
        ORDER BY total DESC
      `,

      // Peak hours
      this.prisma.$queryRaw<{ hour: number; count: number }[]>`
        SELECT EXTRACT(HOUR FROM created_at)::int AS hour,
               COUNT(*)::int AS count
        FROM generations
        WHERE created_at >= ${since}
        GROUP BY EXTRACT(HOUR FROM created_at)
        ORDER BY hour ASC
      `,

      // Stuck generations (PROCESSING for more than 10 minutes)
      this.prisma.generation.findMany({
        where: {
          status: GenerationStatus.PROCESSING,
          createdAt: { lt: tenMinutesAgo },
        },
        select: {
          id: true,
          userId: true,
          type: true,
          modelUsed: true,
          createdAt: true,
          processingStartedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return {
      dailyGenerations: dailyGenerations.map((r) => ({
        date: String(r.date),
        count: r.count,
      })),
      byType: byType.map((r) => ({
        type: r.type,
        count: r._count._all,
      })),
      avgProcessingByModel: avgProcessingByModel.map((r) => ({
        modelUsed: r.model_used,
        avgMs: r.avg_ms,
        p95Ms: r.p95_ms,
        count: r.count,
      })),
      errorRateByModel: errorRateByModel.map((r) => ({
        modelUsed: r.model_used,
        total: r.total,
        failed: r.failed,
        errorRate: r.error_rate,
      })),
      peakHours: peakHours.map((r) => ({
        hour: r.hour,
        count: r.count,
      })),
      stuckGenerations: stuckGenerations.map((g) => ({
        id: g.id,
        userId: g.userId,
        type: g.type,
        modelUsed: g.modelUsed,
        createdAt: g.createdAt,
        processingStartedAt: g.processingStartedAt,
      })),
    };
  }

  async getCreditStats(days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setMonth(monthStart.getMonth() - 1);

    const [
      consumedToday,
      consumedWeek,
      consumedMonth,
      dailyConsumption,
      allocationVsUsage,
      nearLimitUsers,
      refunds,
    ] = await Promise.all([
      // Credits consumed today
      this.prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        where: {
          type: CreditTransactionType.GENERATION_DEBIT,
          createdAt: { gte: todayStart },
        },
      }),

      // Credits consumed this week
      this.prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        where: {
          type: CreditTransactionType.GENERATION_DEBIT,
          createdAt: { gte: weekStart },
        },
      }),

      // Credits consumed this month
      this.prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        where: {
          type: CreditTransactionType.GENERATION_DEBIT,
          createdAt: { gte: monthStart },
        },
      }),

      // Daily consumption
      this.prisma.$queryRaw<{ date: string; consumed: number }[]>`
        SELECT DATE_TRUNC('day', created_at)::date AS date,
               COALESCE(SUM(ABS(amount)), 0)::int AS consumed
        FROM credit_transactions
        WHERE type = 'GENERATION_DEBIT'
          AND created_at >= ${since}
        GROUP BY DATE_TRUNC('day', created_at)::date
        ORDER BY date ASC
      `,

      // Allocation vs usage: total plan_credits_used vs total credits_per_month
      this.prisma.$queryRaw<[{ total_used: number; total_allocated: number }]>`
        SELECT COALESCE(SUM(cb.plan_credits_used), 0)::int AS total_used,
               COALESCE(SUM(p.credits_per_month), 0)::int AS total_allocated
        FROM credit_balances cb
        JOIN users u ON u.id = cb.user_id
        JOIN subscriptions s ON s.user_id = u.id AND s.status = 'ACTIVE'
        JOIN plans p ON p.id = s.plan_id
      `,

      // Near limit users (less than 10% remaining)
      this.prisma.$queryRaw<
        { user_id: string; email: string; name: string; plan_credits_remaining: number; credits_per_month: number; usage_percent: number }[]
      >`
        SELECT cb.user_id,
               u.email,
               u.name,
               cb.plan_credits_remaining,
               p.credits_per_month,
               CASE WHEN p.credits_per_month > 0
                 THEN ROUND((1 - cb.plan_credits_remaining::numeric / p.credits_per_month::numeric) * 100, 1)::float
                 ELSE 0
               END AS usage_percent
        FROM credit_balances cb
        JOIN users u ON u.id = cb.user_id
        JOIN subscriptions s ON s.user_id = u.id AND s.status = 'ACTIVE'
        JOIN plans p ON p.id = s.plan_id
        WHERE p.credits_per_month > 0
          AND cb.plan_credits_remaining::numeric / p.credits_per_month::numeric < 0.1
        ORDER BY usage_percent DESC
      `,

      // Refunds in period
      this.prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        _count: { _all: true },
        where: {
          type: CreditTransactionType.GENERATION_REFUND,
          createdAt: { gte: since },
        },
      }),
    ]);

    const allocUsage = allocationVsUsage[0] ?? { total_used: 0, total_allocated: 0 };

    return {
      consumedToday: Math.abs(consumedToday._sum.amount ?? 0),
      consumedWeek: Math.abs(consumedWeek._sum.amount ?? 0),
      consumedMonth: Math.abs(consumedMonth._sum.amount ?? 0),
      dailyConsumption: dailyConsumption.map((r) => ({
        date: String(r.date),
        consumed: r.consumed,
      })),
      allocationVsUsage: {
        totalAllocated: allocUsage.total_allocated,
        totalUsed: allocUsage.total_used,
        usagePercent:
          allocUsage.total_allocated > 0
            ? Math.round((allocUsage.total_used / allocUsage.total_allocated) * 10000) / 100
            : 0,
      },
      nearLimitUsers: nearLimitUsers.map((r) => ({
        userId: r.user_id,
        email: r.email,
        name: r.name,
        planCreditsRemaining: r.plan_credits_remaining,
        creditsPerMonth: r.credits_per_month,
        usagePercent: r.usage_percent,
      })),
      refunds: {
        totalAmount: refunds._sum.amount ?? 0,
        count: refunds._count._all,
      },
    };
  }

  async getHealthStats() {
    const tenMinutesAgo = new Date();
    tenMinutesAgo.setMinutes(tenMinutesAgo.getMinutes() - 10);

    const oneHourAgo = new Date();
    oneHourAgo.setHours(oneHourAgo.getHours() - 1);

    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const [
      processingCount,
      pendingCount,
      stuckCount,
      recentFailuresByModel,
      failingPayments,
      recentErrors,
      recentSafetyFallbacks,
    ] = await Promise.all([
      // Queue: processing count
      this.prisma.generation.count({
        where: { status: GenerationStatus.PROCESSING },
      }),

      // Queue: pending count
      this.prisma.generation.count({
        where: { status: GenerationStatus.PENDING },
      }),

      // Stuck: processing older than 10 minutes
      this.prisma.generation.count({
        where: {
          status: GenerationStatus.PROCESSING,
          createdAt: { lt: tenMinutesAgo },
        },
      }),

      // Recent failures by model (last hour)
      this.prisma.$queryRaw<
        { model_used: string; failed_count: number; error_codes: string[] }[]
      >`
        SELECT model_used,
               COUNT(*)::int AS failed_count,
               ARRAY_AGG(DISTINCT error_code) FILTER (WHERE error_code IS NOT NULL) AS error_codes
        FROM generations
        WHERE status = 'FAILED'
          AND created_at >= ${oneHourAgo}
        GROUP BY model_used
        ORDER BY failed_count DESC
      `,

      // Failing payments (last 24h)
      this.prisma.payment.count({
        where: {
          status: 'FAILED',
          createdAt: { gte: twentyFourHoursAgo },
        },
      }),

      // Recent errors (last 10)
      this.prisma.generation.findMany({
        where: { status: GenerationStatus.FAILED },
        select: {
          id: true,
          userId: true,
          type: true,
          modelUsed: true,
          errorMessage: true,
          errorCode: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),

      // Recent Seedream safety fallbacks (last 10)
      this.prisma.generation.findMany({
        where: {
          status: GenerationStatus.COMPLETED,
          parameters: {
            path: ['seedreamSafetyFallback'],
            equals: true,
          },
        },
        select: {
          id: true,
          userId: true,
          type: true,
          modelUsed: true,
          parameters: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    // Build alerts based on thresholds
    const alerts: { level: 'warning' | 'critical'; message: string }[] = [];

    if (stuckCount > 0) {
      alerts.push({
        level: stuckCount >= 5 ? 'critical' : 'warning',
        message: `${stuckCount} generation(s) stuck in PROCESSING for more than 10 minutes`,
      });
    }

    if (pendingCount > 50) {
      alerts.push({
        level: pendingCount >= 100 ? 'critical' : 'warning',
        message: `${pendingCount} generation(s) pending in queue`,
      });
    }

    if (failingPayments > 5) {
      alerts.push({
        level: failingPayments >= 20 ? 'critical' : 'warning',
        message: `${failingPayments} failed payment(s) in the last 24 hours`,
      });
    }

    for (const failure of recentFailuresByModel) {
      if (failure.failed_count >= 10) {
        alerts.push({
          level: failure.failed_count >= 30 ? 'critical' : 'warning',
          message: `${failure.failed_count} failure(s) for model "${failure.model_used}" in the last hour`,
        });
      }
    }

    return {
      queue: {
        processing: processingCount,
        pending: pendingCount,
      },
      stuckCount,
      recentFailuresByModel: recentFailuresByModel.map((r) => ({
        modelUsed: r.model_used,
        failedCount: r.failed_count,
        errorCodes: r.error_codes ?? [],
      })),
      failingPayments,
      recentErrors: [
        ...recentErrors.map((e) => ({
          id: e.id,
          userId: e.userId,
          type: e.type,
          modelUsed: e.modelUsed,
          errorMessage: e.errorMessage,
          errorCode: e.errorCode,
          createdAt: e.createdAt,
          safetyFallback: false,
        })),
        ...recentSafetyFallbacks.map((e) => {
          const params =
            e.parameters && typeof e.parameters === 'object'
              ? (e.parameters as Record<string, unknown>)
              : {};
          const from =
            typeof params.seedreamFallbackFrom === 'string'
              ? params.seedreamFallbackFrom
              : 'unknown';
          return {
            id: e.id,
            userId: e.userId,
            type: e.type,
            modelUsed: e.modelUsed,
            errorMessage: `Bloqueio de diretriz — fallback Seedream acionado (origem: ${from})`,
            errorCode: 'SAFETY_FALLBACK',
            createdAt: e.createdAt,
            safetyFallback: true,
          };
        }),
      ]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 10),
      alerts,
    };
  }

  // ============================================
  // PROMPT MANAGEMENT
  // ============================================

  async getPromptSections() {
    return this.prisma.promptSection.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        categories: {
          orderBy: { sortOrder: 'asc' },
          include: {
            prompts: {
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
      },
    });
  }

  /** Seções + categorias com contagem de prompts (sem carregar os prompts).
   * Leve, para popular a árvore de gerenciamento e os filtros. */
  async getPromptSectionsLight() {
    const sections = await this.prisma.promptSection.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        categories: {
          orderBy: { sortOrder: 'asc' },
          include: { _count: { select: { prompts: true } } },
        },
      },
    });
    return sections.map((s) => ({
      id: s.id,
      slug: s.slug,
      title: s.title,
      description: s.description,
      icon: s.icon,
      sortOrder: s.sortOrder,
      isActive: s.isActive,
      categories: s.categories.map((c) => ({
        id: c.id,
        sectionId: c.sectionId,
        title: c.title,
        sortOrder: c.sortOrder,
        promptCount: c._count.prompts,
      })),
    }));
  }

  /** Lista paginada de prompt templates com filtros (tipo, seção, categoria, busca). */
  async getPromptTemplates(query: ListPromptTemplatesQueryDto) {
    const where: Prisma.PromptTemplateWhereInput = {};
    if (query.type) where.type = query.type;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.sectionId) where.category = { sectionId: query.sectionId };
    const search = query.search?.trim();
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { prompt: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.promptTemplate.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        skip: query.skip,
        take: query.limit,
        include: {
          category: {
            select: {
              id: true,
              title: true,
              section: { select: { id: true, title: true } },
            },
          },
        },
      }),
      this.prisma.promptTemplate.count({ where }),
    ]);

    const data = items.map((t) => ({
      id: t.id,
      categoryId: t.categoryId,
      title: t.title,
      type: t.type,
      prompt: t.prompt,
      imageUrl: t.imageUrl,
      thumbnailUrl: t.thumbnailUrl,
      aiModel: t.aiModel,
      sortOrder: t.sortOrder,
      isActive: t.isActive,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      category: {
        id: t.category.id,
        title: t.category.title,
        section: { id: t.category.section.id, title: t.category.section.title },
      },
    }));

    return new PaginatedResponseDto(data, total, query.page, query.limit);
  }

  async createPromptSection(dto: CreatePromptSectionDto) {
    return this.prisma.promptSection.create({
      data: {
        slug: dto.slug,
        title: dto.title,
        description: dto.description,
        icon: dto.icon,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updatePromptSection(id: string, dto: UpdatePromptSectionDto) {
    const section = await this.prisma.promptSection.findUnique({ where: { id } });
    if (!section) {
      throw new NotFoundException('Seção de prompts não encontrada');
    }
    return this.prisma.promptSection.update({
      where: { id },
      data: {
        ...(dto.slug !== undefined && { slug: dto.slug }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async deletePromptSection(id: string) {
    const section = await this.prisma.promptSection.findUnique({ where: { id } });
    if (!section) {
      throw new NotFoundException('Seção de prompts não encontrada');
    }

    await this.prisma.promptSection.delete({ where: { id } });
    return { success: true, message: 'Seção removida com sucesso' };
  }

  async createPromptCategory(dto: CreatePromptCategoryDto) {
    const section = await this.prisma.promptSection.findUnique({ where: { id: dto.sectionId } });
    if (!section) {
      throw new NotFoundException('Seção de prompts não encontrada');
    }
    return this.prisma.promptCategory.create({
      data: {
        sectionId: dto.sectionId,
        title: dto.title,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updatePromptCategory(id: string, dto: UpdatePromptCategoryDto) {
    const category = await this.prisma.promptCategory.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException('Categoria de prompts não encontrada');
    }
    if (dto.sectionId) {
      const section = await this.prisma.promptSection.findUnique({ where: { id: dto.sectionId } });
      if (!section) {
        throw new NotFoundException('Seção de prompts não encontrada');
      }
    }
    return this.prisma.promptCategory.update({
      where: { id },
      data: {
        ...(dto.sectionId !== undefined && { sectionId: dto.sectionId }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
  }

  async deletePromptCategory(id: string) {
    const category = await this.prisma.promptCategory.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException('Categoria de prompts não encontrada');
    }
    await this.prisma.promptCategory.delete({ where: { id } });
    return { success: true, message: 'Categoria removida com sucesso' };
  }

  async createPromptTemplate(dto: CreatePromptTemplateDto) {
    const category = await this.prisma.promptCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) {
      throw new NotFoundException('Categoria de prompts não encontrada');
    }

    const created = await this.prisma.promptTemplate.create({
      data: {
        categoryId: dto.categoryId,
        title: dto.title,
        type: dto.type,
        prompt: dto.prompt,
        imageUrl: dto.imageUrl,
        aiModel: dto.aiModel,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    if (dto.imageUrl) {
      const thumbnailUrl = await this.generatePromptThumbnail(dto.imageUrl, created.id);
      if (thumbnailUrl) {
        return this.prisma.promptTemplate.update({
          where: { id: created.id },
          data: { thumbnailUrl },
        });
      }
    }

    return created;
  }

  async updatePromptTemplate(id: string, dto: UpdatePromptTemplateDto) {
    const template = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!template) {
      throw new NotFoundException('Prompt template não encontrado');
    }

    if (dto.categoryId) {
      const category = await this.prisma.promptCategory.findUnique({
        where: { id: dto.categoryId },
      });
      if (!category) {
        throw new NotFoundException('Categoria de prompts não encontrada');
      }
    }

    // Regenerate thumbnail only if imageUrl actually changes
    let thumbnailPatch: { thumbnailUrl: string | null } | undefined;
    if (dto.imageUrl !== undefined && dto.imageUrl !== template.imageUrl) {
      if (dto.imageUrl) {
        const thumbnailUrl = await this.generatePromptThumbnail(dto.imageUrl, id);
        thumbnailPatch = { thumbnailUrl: thumbnailUrl ?? null };
      } else {
        thumbnailPatch = { thumbnailUrl: null };
      }
    }

    return this.prisma.promptTemplate.update({
      where: { id },
      data: {
        ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.prompt !== undefined && { prompt: dto.prompt }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
        ...(dto.aiModel !== undefined && { aiModel: dto.aiModel }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(thumbnailPatch ?? {}),
      },
    });
  }

  async deletePromptTemplate(id: string) {
    const template = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!template) {
      throw new NotFoundException('Prompt template não encontrado');
    }

    await this.prisma.promptTemplate.delete({ where: { id } });
    return { success: true, message: 'Prompt template removido com sucesso' };
  }

  // ===== AI MODELS =====

  async listAllModels() {
    return this.prisma.aiModel.findMany({
      orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async toggleModelStatus(id: string, isActive: boolean, statusMessage?: string) {
    const model = await this.prisma.aiModel.findUnique({ where: { id } });
    if (!model) {
      throw new NotFoundException('Modelo não encontrado');
    }

    await this.prisma.aiModel.update({
      where: { id },
      data: {
        isActive,
        statusMessage: statusMessage ?? null,
      },
    });

    // Invalida o cache do ModelsService para refletir mudanças imediatamente
    this.modelsService.invalidateCache();
  }
}
