import { Injectable, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { PixKeyType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../payments/stripe.service';
import { EmailService } from '../email/email.service';
import { CreateAffiliateDto } from './dto/create-affiliate.dto';
import { UpdateAffiliateDto } from './dto/update-affiliate.dto';
import { UpdatePixKeyDto } from './dto/update-pix-key.dto';
import { MarkEarningsPaidDto } from './dto/mark-paid.dto';
import { AffiliateDiscountScope } from '@prisma/client';
import {
  EarningCurrencySlice,
  resolveEarningCurrency,
  summarizeByCurrency,
} from './affiliate-currency';
import { maskEmail } from './mask-email';

/** Dias até a comissão pendente ficar disponível para saque (janela de reembolso). */
const AFFILIATE_MATURATION_DAYS = 30;

type AffiliateCurrencySlice = EarningCurrencySlice & { affiliateId: string };

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
    // Código de indicação de usuário também conta: senão o afiliado novo passaria a receber pelo link de outra pessoa.
    const usedByReferral = await this.prisma.referralCode.findUnique({ where: { code }, select: { id: true } });
    if (existing || usedByReferral) {
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

    const currencySlices = await this.loadCurrencySlices({
      affiliateId: { in: affiliates.map((a) => a.id) },
    });

    return affiliates.map((affiliate) => {
      const totals = totalsByAffiliate.get(affiliate.id) ?? { total: 0, pending: 0 };
      return {
        ...affiliate,
        totalEarningsCents: totals.total,
        pendingEarningsCents: totals.pending,
        byCurrency: summarizeByCurrency(
          currencySlices.filter((slice) => slice.affiliateId === affiliate.id),
        ),
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
        payment: { select: { id: true, type: true, amountCents: true, currency: true, createdAt: true } },
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

    const byCurrency = summarizeByCurrency(await this.loadCurrencySlices({ affiliateId }));

    return {
      affiliate,
      earnings,
      summary: {
        totalRevenueCents: totals._sum.amountCents ?? 0,
        totalCommissionCents: totals._sum.commissionCents ?? 0,
        pendingCommissionCents: pendingTotals._sum.commissionCents ?? 0,
        paidCommissionCents: paidTotals._sum.commissionCents ?? 0,
        byCurrency,
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
        currency: true,
        createdAt: true,
        payment: { select: { currency: true } },
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

    // Um e-mail por afiliado e por moeda: somar centavos de real com centavos de dólar daria um valor que não existe.
    const byAffiliate = new Map<
      string,
      { email: string; name: string; currency: string; totalCents: number; count: number }
    >();

    for (const earning of earnings) {
      const email = earning.affiliate.user?.email;
      if (!email) {
        this.logger.warn(
          `Skipping payment email for affiliate ${earning.affiliate.id} — no linked user email`,
        );
        continue;
      }
      const currency = resolveEarningCurrency(earning.currency, earning.payment?.currency);
      const groupKey = `${earning.affiliate.id}:${currency}`;
      const current = byAffiliate.get(groupKey) ?? {
        email,
        name: earning.affiliate.user?.name || earning.affiliate.name,
        currency,
        totalCents: 0,
        count: 0,
      };
      current.totalCents += earning.commissionCents;
      current.count += 1;
      byAffiliate.set(groupKey, current);
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
          currency: info.currency,
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
      // O código sai do nome, que a pessoa escolhe: um nome igual ao código de indicação de outro usuário
      // sequestraria o link dele (cadastro com código de afiliado ativo vira comissão em dinheiro).
      const usedByReferral = await this.prisma.referralCode.findUnique({ where: { code }, select: { id: true } });
      if (usedByReferral) continue;
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

    const maturationDate = this.maturationCutoff();

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

    // Clientes distintos que já geraram comissão (indicado que só se cadastrou não conta).
    const payingUserRows = await this.prisma.affiliateEarning.groupBy({
      by: ['userId'],
      where: { affiliateId: affiliate.id },
    });

    const byCurrency = summarizeByCurrency(
      await this.loadCurrencySlices({ affiliateId: affiliate.id }, maturationDate),
    );

    const earningRows = await this.prisma.affiliateEarning.findMany({
      where: { affiliateId: affiliate.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        amountCents: true,
        commissionCents: true,
        currency: true,
        status: true,
        paidAt: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
        payment: {
          select: {
            type: true,
            amountCents: true,
            currency: true,
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

    // O afiliado vê quem comprou, mas não o e-mail inteiro do cliente.
    const earnings = earningRows.map((earning) => ({
      ...earning,
      currency: resolveEarningCurrency(earning.currency, earning.payment?.currency),
      user: earning.user
        ? { name: earning.user.name, email: maskEmail(earning.user.email) }
        : earning.user,
    }));

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
        payingUsers: payingUserRows.length,
        totalPayments: totals._count,
        totalRevenueCents: totals._sum.amountCents ?? 0,
        totalCommissionCents: totals._sum.commissionCents ?? 0,
        pendingCommissionCents: pendingTotals._sum.commissionCents ?? 0,
        availableCommissionCents: availableTotals._sum.commissionCents ?? 0,
        maturingCommissionCents: maturingTotals._sum.commissionCents ?? 0,
        paidCommissionCents: paidTotals._sum.commissionCents ?? 0,
        maturationDays: AFFILIATE_MATURATION_DAYS,
        byCurrency,
      },
      earnings,
    };
  }

  private maturationCutoff(): Date {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - AFFILIATE_MATURATION_DAYS);
    return cutoff;
  }

  /**
   * Fatias de comissão por afiliado, moeda, status e maturação, para o `byCurrency`.
   * Comissão com moeda gravada sai agregada do banco; as antigas (sem moeda) vêm uma
   * a uma com a moeda do pagamento ligado.
   */
  private async loadCurrencySlices(
    where: Prisma.AffiliateEarningWhereInput,
    maturationDate: Date = this.maturationCutoff(),
  ): Promise<AffiliateCurrencySlice[]> {
    const slices: AffiliateCurrencySlice[] = [];

    for (const matured of [true, false]) {
      const groups = await this.prisma.affiliateEarning.groupBy({
        by: ['affiliateId', 'currency', 'status'],
        where: {
          ...where,
          currency: { not: null },
          createdAt: matured ? { lte: maturationDate } : { gt: maturationDate },
        },
        _sum: { amountCents: true, commissionCents: true },
      });
      for (const group of groups) {
        slices.push({
          affiliateId: group.affiliateId,
          currency: group.currency,
          status: group.status,
          matured,
          amountCents: group._sum.amountCents ?? 0,
          commissionCents: group._sum.commissionCents ?? 0,
        });
      }
    }

    const earningsWithoutCurrency = await this.prisma.affiliateEarning.findMany({
      where: { ...where, currency: null },
      select: {
        affiliateId: true,
        status: true,
        createdAt: true,
        amountCents: true,
        commissionCents: true,
        payment: { select: { currency: true } },
      },
    });
    for (const earning of earningsWithoutCurrency) {
      slices.push({
        affiliateId: earning.affiliateId,
        currency: null,
        paymentCurrency: earning.payment?.currency ?? null,
        status: earning.status,
        matured: earning.createdAt.getTime() <= maturationDate.getTime(),
        amountCents: earning.amountCents,
        commissionCents: earning.commissionCents,
      });
    }

    return slices;
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

    const byCurrency = summarizeByCurrency(await this.loadCurrencySlices({}));

    return {
      totalAffiliates,
      activeAffiliates,
      referredUsers,
      totalPayments: totalEarnings._count,
      totalRevenueCents: totalEarnings._sum.amountCents ?? 0,
      totalCommissionCents: totalEarnings._sum.commissionCents ?? 0,
      pendingCommissionCents: pendingEarnings._sum.commissionCents ?? 0,
      paidCommissionCents: paidEarnings._sum.commissionCents ?? 0,
      byCurrency,
    };
  }
}
