import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PixKeyType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../payments/stripe.service';
import { EmailService } from '../email/email.service';
import { CreateAffiliateDto } from './dto/create-affiliate.dto';
import { UpdateAffiliateDto } from './dto/update-affiliate.dto';
import { UpdatePixKeyDto } from './dto/update-pix-key.dto';
import { UpdatePayoutDto } from './dto/update-payout.dto';
import { MarkEarningsPaidDto } from './dto/mark-paid.dto';
import { AffiliateDiscountScope } from '@prisma/client';
import {
  EarningCurrencySlice,
  resolveEarningCurrency,
  summarizeByCurrency,
} from './affiliate-currency';
import { abbreviateCustomerName, maskEmail } from './mask-email';
import { resolveAffiliateRecurringWindow } from './affiliate-recurring';
import {
  PayoutData,
  PayoutInput,
  resolvePayout,
  resolveSelfServiceCommissionPercent,
} from './affiliate-payout';

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

    const perfectpayAffiliateEmail = dto.perfectpayAffiliateEmail?.trim().toLowerCase() || null;
    const perfectpayAffiliateCode = dto.perfectpayAffiliateCode?.trim().toUpperCase() || null;
    await this.assertPerfectpayIdentityFree({ perfectpayAffiliateEmail, perfectpayAffiliateCode });

    const affiliate = await this.prisma.affiliate
      .create({
        data: {
          name: dto.name,
          code,
          commissionPercent: dto.commissionPercent ?? 30,
          userId: dto.userId ?? null,
          ...(perfectpayAffiliateEmail && { perfectpayAffiliateEmail }),
          ...(perfectpayAffiliateCode && { perfectpayAffiliateCode }),
          discountPercent: dto.discountPercent ?? null,
          discountAppliesTo: dto.discountAppliesTo ?? AffiliateDiscountScope.FIRST_PURCHASE,
        },
      })
      .catch((err: unknown) => this.rethrowUniqueAsConflict(err));

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
            payoutMethod: true,
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
      {
        email: string;
        name: string;
        currency: string;
        payoutMethod: string | null;
        totalCents: number;
        count: number;
      }
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
        payoutMethod: earning.affiliate.payoutMethod ?? null,
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
          payoutMethod: info.payoutMethod,
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

    const perfectpayEmailProvided = dto.perfectpayAffiliateEmail !== undefined;
    const perfectpayAffiliateEmail = dto.perfectpayAffiliateEmail?.trim().toLowerCase() || null;
    const perfectpayCodeProvided = dto.perfectpayAffiliateCode !== undefined;
    const perfectpayAffiliateCode = dto.perfectpayAffiliateCode?.trim().toUpperCase() || null;
    await this.assertPerfectpayIdentityFree(
      {
        perfectpayAffiliateEmail: perfectpayEmailProvided ? perfectpayAffiliateEmail : null,
        perfectpayAffiliateCode: perfectpayCodeProvided ? perfectpayAffiliateCode : null,
      },
      id,
    );

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

    return this.prisma.affiliate
      .update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.commissionPercent !== undefined && { commissionPercent: dto.commissionPercent }),
          ...(dto.userId !== undefined && { userId: dto.userId || null }),
          ...(discountProvided && { discountPercent: newDiscount ?? null }),
          ...(dto.discountAppliesTo !== undefined && { discountAppliesTo: dto.discountAppliesTo }),
          ...(perfectpayEmailProvided && { perfectpayAffiliateEmail }),
          ...(perfectpayCodeProvided && { perfectpayAffiliateCode }),
          ...(discountChanged && {
            stripeCouponId: newCouponId,
            stripePromotionCodeId: newPromotionCodeId,
          }),
        },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      })
      .catch((err: unknown) => this.rethrowUniqueAsConflict(err));
  }

  /**
   * O e-mail e o código do afiliado na Perfect Pay decidem para quem vai o cliente que comprou
   * o Pack por afiliado: um e-mail, um afiliado; um código, um afiliado. Só o admin grava
   * (nunca o autoatendimento, que permitiria sequestrar as vendas de outro afiliado).
   */
  private async assertPerfectpayIdentityFree(
    identity: { perfectpayAffiliateEmail: string | null; perfectpayAffiliateCode: string | null },
    ownAffiliateId?: string,
  ): Promise<void> {
    if (identity.perfectpayAffiliateEmail) {
      const holder = await this.prisma.affiliate.findUnique({
        where: { perfectpayAffiliateEmail: identity.perfectpayAffiliateEmail },
        select: { id: true, code: true },
      });
      if (holder && holder.id !== ownAffiliateId) {
        throw new ConflictException(`Este e-mail da Perfect Pay já está no afiliado "${holder.code}"`);
      }
    }
    if (identity.perfectpayAffiliateCode) {
      const holder = await this.prisma.affiliate.findUnique({
        where: { perfectpayAffiliateCode: identity.perfectpayAffiliateCode },
        select: { id: true, code: true },
      });
      if (holder && holder.id !== ownAffiliateId) {
        throw new ConflictException(`Este código da Perfect Pay já está no afiliado "${holder.code}"`);
      }
    }
  }

  /**
   * Dois admins gravando o mesmo e-mail/código da Perfect Pay ao mesmo tempo passam os dois
   * pela checagem acima; quem chega depois bate no índice único (P2002) e recebe 409, não 500.
   */
  private rethrowUniqueAsConflict(err: unknown): never {
    if (!this.isUniqueConstraintError(err)) throw err;

    const target = (err as { meta?: { target?: unknown } }).meta?.target;
    const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');
    if (fields.includes('perfectpay_affiliate_email') || fields.includes('perfectpayAffiliateEmail')) {
      throw new ConflictException('Este e-mail da Perfect Pay já está em outro afiliado');
    }
    if (fields.includes('perfectpay_affiliate_code') || fields.includes('perfectpayAffiliateCode')) {
      throw new ConflictException('Este código da Perfect Pay já está em outro afiliado');
    }
    throw new ConflictException('Já existe um afiliado com estes dados (código, conta ou identificação da Perfect Pay)');
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

  async createForUser(userId: string, dto: UpdatePayoutDto | UpdatePixKeyDto) {
    const existing = await this.prisma.affiliate.findFirst({
      where: { userId },
    });
    if (existing) {
      throw new ConflictException('Você já possui um link de afiliado');
    }

    const payout = this.requirePayout(dto);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true, emailVerified: true },
    });
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }
    // Comissão é dinheiro: conta sem e-mail confirmado não vira afiliada (barra cadastro descartável em série).
    if (!user.emailVerified) {
      throw new ForbiddenException({
        message: 'Confirme seu e-mail antes de criar o link de afiliado',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }

    const commissionPercent = resolveSelfServiceCommissionPercent(
      process.env.AFFILIATE_SELF_SERVICE_PERCENT,
    );

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
            commissionPercent,
            userId,
            ...this.payoutColumns(payout),
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
    this.assertAffiliateActive(affiliate);

    const payout = this.requirePayout({ payoutMethod: 'PIX', pixKey: dto.pixKey, pixKeyType: dto.pixKeyType });

    return this.prisma.affiliate.update({
      where: { id: affiliate.id },
      data: this.payoutColumns(payout),
      select: {
        id: true,
        pixKey: true,
        pixKeyType: true,
        payoutMethod: true,
      },
    });
  }

  /** Troca a forma de recebimento do afiliado logado (PIX, PayPal ou Wise). */
  async updateMyPayout(userId: string, dto: UpdatePayoutDto) {
    const affiliate = await this.prisma.affiliate.findFirst({
      where: { userId },
    });
    if (!affiliate) {
      throw new NotFoundException('Você ainda não é afiliado');
    }
    this.assertAffiliateActive(affiliate);

    const payout = this.requirePayout(dto);

    return this.prisma.affiliate.update({
      where: { id: affiliate.id },
      data: this.payoutColumns(payout),
      select: {
        id: true,
        payoutMethod: true,
        payoutEmail: true,
        pixKey: true,
        pixKeyType: true,
      },
    });
  }

  /** Afiliado desativado pelo admin não troca o destino do dinheiro (comissão pendente pode estar em análise). */
  private assertAffiliateActive(affiliate: { isActive?: boolean | null }): void {
    if (affiliate.isActive === false) {
      throw new ForbiddenException({
        message: 'Seu link de afiliado está desativado. Fale com o suporte para alterar o recebimento',
        code: 'AFFILIATE_INACTIVE',
      });
    }
  }

  /** O DTO já valida na rota; aqui é a mesma regra para quem chama o serviço direto. */
  private requirePayout(input: PayoutInput): PayoutData {
    const payout = resolvePayout(input);
    if (!payout.ok) {
      throw new BadRequestException(payout.reason);
    }
    return payout.data;
  }

  private payoutColumns(payout: PayoutData) {
    return {
      payoutMethod: payout.payoutMethod,
      payoutEmail: payout.payoutEmail,
      pixKey: payout.pixKey,
      pixKeyType: payout.pixKeyType as PixKeyType | null,
    };
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

    // O afiliado vê quem comprou, mas não o nome completo nem o e-mail inteiro do cliente.
    const earnings = earningRows.map((earning) => ({
      ...earning,
      currency: resolveEarningCurrency(earning.currency, earning.payment?.currency),
      user: earning.user
        ? { name: abbreviateCustomerName(earning.user.name), email: maskEmail(earning.user.email) }
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
        // Afiliado anterior a este campo só tem a chave Pix: conta como PIX.
        payoutMethod: affiliate.payoutMethod ?? (affiliate.pixKey ? 'PIX' : null),
        payoutEmail: affiliate.payoutEmail ?? null,
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
        // Para o site dizer a verdade: se a renovação paga comissão e que a base é o valor líquido.
        commissionWindow: resolveAffiliateRecurringWindow(process.env.AFFILIATE_RECURRING_MONTHS),
        netOfFees: true,
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
   * Tudo sai agregado do banco. Comissão antiga (sem moeda gravada) usa a moeda do
   * pagamento ligado: primeiro as moedas que existem entre esses pagamentos (poucas),
   * depois uma soma por moeda. Nenhuma comissão é lida linha a linha.
   */
  private async loadCurrencySlices(
    where: Prisma.AffiliateEarningWhereInput,
    maturationDate: Date = this.maturationCutoff(),
  ): Promise<AffiliateCurrencySlice[]> {
    const slices: AffiliateCurrencySlice[] = [];
    const maturationWindows = [
      { matured: true, createdAt: { lte: maturationDate } },
      { matured: false, createdAt: { gt: maturationDate } },
    ];

    for (const { matured, createdAt } of maturationWindows) {
      const groups = await this.prisma.affiliateEarning.groupBy({
        by: ['affiliateId', 'currency', 'status'],
        where: { ...where, currency: { not: null }, createdAt },
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

    const legacyWhere: Prisma.AffiliateEarningWhereInput = { ...where, currency: null };
    const legacyPaymentCurrencies = await this.prisma.payment.groupBy({
      by: ['currency'],
      where: { affiliateEarnings: { some: legacyWhere } },
    });

    for (const { currency: paymentCurrency } of legacyPaymentCurrencies) {
      for (const { matured, createdAt } of maturationWindows) {
        const groups = await this.prisma.affiliateEarning.groupBy({
          by: ['affiliateId', 'status'],
          where: { ...legacyWhere, payment: { currency: paymentCurrency }, createdAt },
          _sum: { amountCents: true, commissionCents: true },
        });
        for (const group of groups) {
          slices.push({
            affiliateId: group.affiliateId,
            currency: null,
            paymentCurrency,
            status: group.status,
            matured,
            amountCents: group._sum.amountCents ?? 0,
            commissionCents: group._sum.commissionCents ?? 0,
          });
        }
      }
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
