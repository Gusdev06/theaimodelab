import { Injectable, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { PixKeyType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../payments/stripe.service';
import { EmailService } from '../email/email.service';
import { CreateAffiliateDto } from './dto/create-affiliate.dto';
import { UpdateAffiliateDto } from './dto/update-affiliate.dto';
import { UpdatePixKeyDto } from './dto/update-pix-key.dto';
import { MarkEarningsPaidDto } from './dto/mark-paid.dto';
import { AffiliateDiscountScope } from '@prisma/client';

@Injectable()
export class AffiliatesService {
  private readonly logger = new Logger(AffiliatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly emailService: EmailService,
  ) {}

  async create(dto: CreateAffiliateDto) {
    const code = dto.code.toUpperCase();

    const existing = await this.prisma.affiliate.findUnique({
      where: { code },
    });
    if (existing) {
      throw new ConflictException(`Código "${code}" já está em uso`);
    }

    const affiliate = await this.prisma.affiliate.create({
      data: {
        name: dto.name,
        code,
        commissionPercent: dto.commissionPercent ?? 30,
        userId: dto.userId ?? null,
        discountPercent: dto.discountPercent ?? null,
        discountAppliesTo: dto.discountAppliesTo ?? AffiliateDiscountScope.FIRST_PURCHASE,
      },
    });

    if (dto.discountPercent && dto.discountPercent > 0) {
      try {
        const { couponId, promotionCodeId } = await this.stripeService.createAffiliateCoupon(
          affiliate.id,
          code,
          dto.discountPercent,
        );
        return this.prisma.affiliate.update({
          where: { id: affiliate.id },
          data: { stripeCouponId: couponId, stripePromotionCodeId: promotionCodeId },
        });
      } catch (err) {
        // Rollback: remove afiliado se nao conseguiu criar cupom
        await this.prisma.affiliate.delete({ where: { id: affiliate.id } });
        throw err;
      }
    }

    return affiliate;
  }

  async findAll() {
    const affiliates = await this.prisma.affiliate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { earnings: true } },
        user: { select: { id: true, email: true, name: true } },
      },
    });

    if (affiliates.length === 0) return [];

    // Single aggregated query to avoid N+1 (estourava o pool do Supabase em session mode)
    const grouped = await this.prisma.affiliateEarning.groupBy({
      by: ['affiliateId', 'status'],
      where: { affiliateId: { in: affiliates.map((a) => a.id) } },
      _sum: { commissionCents: true },
    });

    const totalsByAffiliate = new Map<string, { total: number; pending: number }>();
    for (const row of grouped) {
      const current = totalsByAffiliate.get(row.affiliateId) ?? { total: 0, pending: 0 };
      const amount = row._sum.commissionCents ?? 0;
      current.total += amount;
      if (row.status === 'PENDING') current.pending += amount;
      totalsByAffiliate.set(row.affiliateId, current);
    }

    // Single query to count referred users per affiliate code
    const referralRows = await this.prisma.user.groupBy({
      by: ['referredByCode'],
      where: { referredByCode: { in: affiliates.map((a) => a.code) } },
      _count: { _all: true },
    });

    const referredUsersByCode = new Map<string, number>();
    for (const row of referralRows) {
      if (row.referredByCode) {
        referredUsersByCode.set(row.referredByCode, row._count._all);
      }
    }

    return affiliates.map((affiliate) => {
      const totals = totalsByAffiliate.get(affiliate.id) ?? { total: 0, pending: 0 };
      return {
        ...affiliate,
        totalEarningsCents: totals.total,
        pendingEarningsCents: totals.pending,
        referralsCount: affiliate._count.earnings,
        referredUsersCount: referredUsersByCode.get(affiliate.code) ?? 0,
      };
    });
  }

  async findById(id: string) {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });

    if (!affiliate) {
      throw new NotFoundException('Afiliado não encontrado');
    }

    return affiliate;
  }

  async getEarnings(affiliateId: string) {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id: affiliateId },
    });
    if (!affiliate) {
      throw new NotFoundException('Afiliado não encontrado');
    }

    const earnings = await this.prisma.affiliateEarning.findMany({
      where: { affiliateId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, name: true } },
        payment: { select: { id: true, type: true, amountCents: true, createdAt: true } },
      },
    });

    const totals = await this.prisma.affiliateEarning.aggregate({
      where: { affiliateId },
      _sum: { commissionCents: true, amountCents: true },
    });

    const pendingTotals = await this.prisma.affiliateEarning.aggregate({
      where: { affiliateId, status: 'PENDING' },
      _sum: { commissionCents: true },
    });

    const paidTotals = await this.prisma.affiliateEarning.aggregate({
      where: { affiliateId, status: 'PAID' },
      _sum: { commissionCents: true },
    });

    return {
      affiliate,
      earnings,
      summary: {
        totalRevenueCents: totals._sum.amountCents ?? 0,
        totalCommissionCents: totals._sum.commissionCents ?? 0,
        pendingCommissionCents: pendingTotals._sum.commissionCents ?? 0,
        paidCommissionCents: paidTotals._sum.commissionCents ?? 0,
      },
    };
  }

  async markEarningsPaid(dto: MarkEarningsPaidDto) {
    const { earningIds, receiptBase64, receiptFilename, receiptMimeType } = dto;

    // Capture earnings + affiliate info before updating (so we can group by affiliate for email)
    const earnings = await this.prisma.affiliateEarning.findMany({
      where: { id: { in: earningIds }, status: 'PENDING' },
      select: {
        id: true,
        commissionCents: true,
        createdAt: true,
        affiliate: {
          select: {
            id: true,
            name: true,
            pixKey: true,
            pixKeyType: true,
            user: { select: { email: true, name: true } },
          },
        },
      },
    });

    const result = await this.prisma.affiliateEarning.updateMany({
      where: {
        id: { in: earningIds },
        status: 'PENDING',
      },
      data: {
        status: 'PAID',
        paidAt: new Date(),
      },
    });

    // Group by affiliate and dispatch one email per affiliate
    const byAffiliate = new Map<
      string,
      { email: string; name: string; totalCents: number; count: number }
    >();

    for (const earning of earnings) {
      const email = earning.affiliate.user?.email;
      if (!email) {
        this.logger.warn(
          `Skipping payment email for affiliate ${earning.affiliate.id} — no linked user email`,
        );
        continue;
      }
      const current = byAffiliate.get(earning.affiliate.id) ?? {
        email,
        name: earning.affiliate.user?.name || earning.affiliate.name,
        totalCents: 0,
        count: 0,
      };
      current.totalCents += earning.commissionCents;
      current.count += 1;
      byAffiliate.set(earning.affiliate.id, current);
    }

    const attachment =
      receiptBase64 && receiptFilename
        ? {
            filename: receiptFilename,
            content: receiptBase64,
            contentType: receiptMimeType,
          }
        : undefined;

    await Promise.all(
      Array.from(byAffiliate.values()).map((info) =>
        this.emailService.sendAffiliatePaymentEmail({
          to: info.email,
          name: info.name,
          totalCents: info.totalCents,
          earningsCount: info.count,
          attachment,
        }),
      ),
    );

    return { updated: result.count };
  }

  async update(id: string, dto: UpdateAffiliateDto) {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id },
    });
    if (!affiliate) {
      throw new NotFoundException('Afiliado não encontrado');
    }

    const oldDiscount = affiliate.discountPercent ?? null;
    const discountProvided = dto.discountPercent !== undefined;
    const newDiscount = discountProvided ? dto.discountPercent : oldDiscount;
    const discountChanged = discountProvided && newDiscount !== oldDiscount;

    let newCouponId = affiliate.stripeCouponId;
    let newPromotionCodeId = affiliate.stripePromotionCodeId;

    if (discountChanged) {
      // Remove cupom antigo (se existir)
      if (affiliate.stripeCouponId || affiliate.stripePromotionCodeId) {
        await this.stripeService.removeAffiliateCoupon(
          affiliate.stripeCouponId,
          affiliate.stripePromotionCodeId,
        );
        newCouponId = null;
        newPromotionCodeId = null;
      }
      // Cria novo (se desconto > 0)
      if (newDiscount && newDiscount > 0) {
        const created = await this.stripeService.createAffiliateCoupon(
          affiliate.id,
          affiliate.code,
          newDiscount,
        );
        newCouponId = created.couponId;
        newPromotionCodeId = created.promotionCodeId;
      }
    }

    return this.prisma.affiliate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.commissionPercent !== undefined && { commissionPercent: dto.commissionPercent }),
        ...(dto.userId !== undefined && { userId: dto.userId || null }),
        ...(discountProvided && { discountPercent: newDiscount ?? null }),
        ...(dto.discountAppliesTo !== undefined && { discountAppliesTo: dto.discountAppliesTo }),
        ...(discountChanged && {
          stripeCouponId: newCouponId,
          stripePromotionCodeId: newPromotionCodeId,
        }),
      },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
    });
  }

  async toggleActive(id: string) {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id },
    });
    if (!affiliate) {
      throw new NotFoundException('Afiliado não encontrado');
    }

    const nextActive = !affiliate.isActive;

    // Ativa/desativa promotion code no Stripe junto com o afiliado
    if (affiliate.stripePromotionCodeId) {
      await this.stripeService.setAffiliatePromotionCodeActive(
        affiliate.stripePromotionCodeId,
        nextActive,
      );
    }

    return this.prisma.affiliate.update({
      where: { id },
      data: { isActive: nextActive },
    });
  }

  async remove(id: string) {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id },
      include: { _count: { select: { earnings: true } } },
    });
    if (!affiliate) {
      throw new NotFoundException('Afiliado não encontrado');
    }

    await this.prisma.affiliate.delete({ where: { id } });

    return {
      id,
      code: affiliate.code,
      deletedEarnings: affiliate._count.earnings,
    };
  }

  async createForUser(userId: string, dto: UpdatePixKeyDto) {
    const existing = await this.prisma.affiliate.findFirst({
      where: { userId },
    });
    if (existing) {
      throw new ConflictException('Você já possui um link de afiliado');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    const displayName = user.name?.trim() || user.email.split('@')[0];

    for (let attempt = 0; attempt < 8; attempt++) {
      const code = this.buildAffiliateCodeCandidate(user.name, user.email, attempt);
      try {
        return await this.prisma.affiliate.create({
          data: {
            name: displayName,
            code,
            commissionPercent: 20,
            userId,
            pixKey: dto.pixKey.trim(),
            pixKeyType: dto.pixKeyType as PixKeyType,
          },
        });
      } catch (err: unknown) {
        if (this.isUniqueConstraintError(err)) continue;
        throw err;
      }
    }

    throw new ConflictException('Não foi possível gerar um código único, tente novamente');
  }

  async updateMyPixKey(userId: string, dto: UpdatePixKeyDto) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { userId },
    });
    if (!affiliate) {
      throw new NotFoundException('Você ainda não é afiliado');
    }

    return this.prisma.affiliate.update({
      where: { id: affiliate.id },
      data: {
        pixKey: dto.pixKey.trim(),
        pixKeyType: dto.pixKeyType as PixKeyType,
      },
      select: {
        id: true,
        pixKey: true,
        pixKeyType: true,
      },
    });
  }

  private buildAffiliateCodeCandidate(name: string, email: string, attempt: number): string {
    const base =
      (name || email.split('@')[0])
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .toUpperCase()
        .slice(0, 12) || 'USER';

    // First try: clean code. After that: append 4-digit random suffix to break collisions.
    const suffix = attempt === 0 ? '' : Math.floor(1000 + Math.random() * 9000).toString();
    return `${base}${suffix}`.slice(0, 20);
  }

  private isUniqueConstraintError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === 'P2002'
    );
  }

  async getMyAffiliate(userId: string) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { userId },
    });

    if (!affiliate) {
      return null;
    }

    const totals = await this.prisma.affiliateEarning.aggregate({
      where: { affiliateId: affiliate.id },
      _sum: { commissionCents: true, amountCents: true },
      _count: true,
    });

    const maturationDate = new Date();
    maturationDate.setDate(maturationDate.getDate() - 30);

    const pendingTotals = await this.prisma.affiliateEarning.aggregate({
      where: { affiliateId: affiliate.id, status: 'PENDING' },
      _sum: { commissionCents: true },
    });

    const availableTotals = await this.prisma.affiliateEarning.aggregate({
      where: {
        affiliateId: affiliate.id,
        status: 'PENDING',
        createdAt: { lte: maturationDate },
      },
      _sum: { commissionCents: true },
    });

    const maturingTotals = await this.prisma.affiliateEarning.aggregate({
      where: {
        affiliateId: affiliate.id,
        status: 'PENDING',
        createdAt: { gt: maturationDate },
      },
      _sum: { commissionCents: true },
    });

    const paidTotals = await this.prisma.affiliateEarning.aggregate({
      where: { affiliateId: affiliate.id, status: 'PAID' },
      _sum: { commissionCents: true },
    });

    const referredUsers = await this.prisma.user.count({
      where: { referredByCode: affiliate.code },
    });

    const earnings = await this.prisma.affiliateEarning.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        amountCents: true,
        commissionCents: true,
        status: true,
        paidAt: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
        payment: {
          select: {
            type: true,
            amountCents: true,
            subscription: {
              select: { plan: { select: { name: true, slug: true } } },
            },
            creditPackage: {
              select: { name: true, credits: true },
            },
          },
        },
      },
    });

    return {
      affiliate: {
        id: affiliate.id,
        code: affiliate.code,
        name: affiliate.name,
        commissionPercent: affiliate.commissionPercent,
        isActive: affiliate.isActive,
        discountPercent: affiliate.discountPercent,
        discountAppliesTo: affiliate.discountAppliesTo,
        pixKey: affiliate.pixKey,
        pixKeyType: affiliate.pixKeyType,
        createdAt: affiliate.createdAt,
      },
      summary: {
        referredUsers,
        totalPayments: totals._count,
        totalRevenueCents: totals._sum.amountCents ?? 0,
        totalCommissionCents: totals._sum.commissionCents ?? 0,
        pendingCommissionCents: pendingTotals._sum.commissionCents ?? 0,
        availableCommissionCents: availableTotals._sum.commissionCents ?? 0,
        maturingCommissionCents: maturingTotals._sum.commissionCents ?? 0,
        paidCommissionCents: paidTotals._sum.commissionCents ?? 0,
        maturationDays: 30,
      },
      earnings,
    };
  }

  async getReferredUsers(affiliateId: string) {
    const affiliate = await this.prisma.affiliate.findUnique({
      where: { id: affiliateId },
    });
    if (!affiliate) {
      throw new NotFoundException('Afiliado não encontrado');
    }

    const users = await this.prisma.user.findMany({
      where: { referredByCode: affiliate.code },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          take: 1,
          select: {
            plan: { select: { name: true, slug: true } },
          },
        },
      },
    });

    return users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      createdAt: u.createdAt,
      plan: u.subscriptions[0]?.plan?.name ?? 'Free',
    }));
  }

  async getDashboard() {
    const totalAffiliates = await this.prisma.affiliate.count();
    const activeAffiliates = await this.prisma.affiliate.count({
      where: { isActive: true },
    });

    const totalEarnings = await this.prisma.affiliateEarning.aggregate({
      _sum: { commissionCents: true, amountCents: true },
      _count: true,
    });

    const pendingEarnings = await this.prisma.affiliateEarning.aggregate({
      where: { status: 'PENDING' },
      _sum: { commissionCents: true },
    });

    const paidEarnings = await this.prisma.affiliateEarning.aggregate({
      where: { status: 'PAID' },
      _sum: { commissionCents: true },
    });

    const referredUsers = await this.prisma.user.count({
      where: { referredByCode: { not: null } },
    });

    return {
      totalAffiliates,
      activeAffiliates,
      referredUsers,
      totalPayments: totalEarnings._count,
      totalRevenueCents: totalEarnings._sum.amountCents ?? 0,
      totalCommissionCents: totalEarnings._sum.commissionCents ?? 0,
      pendingCommissionCents: pendingEarnings._sum.commissionCents ?? 0,
      paidCommissionCents: paidEarnings._sum.commissionCents ?? 0,
    };
  }
}
