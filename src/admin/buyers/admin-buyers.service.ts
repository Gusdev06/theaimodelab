import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  REAL_PAYMENT_PROVIDERS,
  buildBuyersReport,
  type BuyerGrantRow,
  type BuyerPaymentRow,
  type BuyerUserRow,
  type BuyersReport,
} from './buyers-report';

/** Lotes para `in` (o Postgres aceita muito mais, mas lote pequeno mantém cada consulta leve). */
const CHUNK = 1000;

const USER_SELECT = {
  id: true,
  email: true,
  country: true,
  locale: true,
  phone: true,
  utmSource: true,
  utmCampaign: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const PAYMENT_SELECT = {
  id: true,
  userId: true,
  type: true,
  amountCents: true,
  currency: true,
  createdAt: true,
  subscription: {
    select: {
      plan: { select: { slug: true, name: true, billingInterval: true } },
    },
  },
  creditPackage: { select: { name: true, credits: true } },
} satisfies Prisma.PaymentSelect;

const GRANT_SELECT = {
  email: true,
  source: true,
  externalEventId: true,
  consumedByUserId: true,
  consumedAt: true,
  createdAt: true,
} satisfies Prisma.PendingFreeGenerationGrantSelect;

type PaymentRecord = Prisma.PaymentGetPayload<{
  select: typeof PAYMENT_SELECT;
}>;

function toPaymentRow(p: PaymentRecord): BuyerPaymentRow {
  return {
    id: p.id,
    userId: p.userId,
    type: p.type,
    amountCents: p.amountCents,
    currency: p.currency,
    createdAt: p.createdAt,
    planSlug: p.subscription?.plan.slug ?? null,
    planName: p.subscription?.plan.name ?? null,
    billingInterval: p.subscription?.plan.billingInterval ?? null,
    packageName: p.creditPackage?.name ?? null,
    packageCredits: p.creditPackage?.credits ?? null,
  };
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/**
 * Lê só o que o relatório de compradores precisa (cadastros, pagamentos reais e grants da isca) e devolve agregados.
 * Somente leitura; nada de e-mail, nome ou telefone sai na resposta (ver buyers-report.ts).
 */
@Injectable()
export class AdminBuyersService {
  constructor(private readonly prisma: PrismaService) {}

  private realPaymentWhere(
    extra: Prisma.PaymentWhereInput,
  ): Prisma.PaymentWhereInput {
    return {
      status: PaymentStatus.COMPLETED,
      provider: { in: [...REAL_PAYMENT_PROVIDERS] },
      ...extra,
    };
  }

  async getBuyersReport(days: number): Promise<BuyersReport> {
    const now = new Date();
    const since = new Date(now.getTime() - days * 86_400_000);

    const [signups, windowPaymentRecords, windowGrants] = await Promise.all([
      this.prisma.user.findMany({
        where: { createdAt: { gte: since } },
        select: USER_SELECT,
      }),
      this.prisma.payment.findMany({
        where: this.realPaymentWhere({ createdAt: { gte: since } }),
        select: PAYMENT_SELECT,
      }),
      this.prisma.pendingFreeGenerationGrant.findMany({
        where: { createdAt: { gte: since } },
        select: GRANT_SELECT,
      }),
    ]);
    const windowPayments = windowPaymentRecords.map(toPaymentRow);

    // usuários da isca: pelo vínculo do grant ou, sem vínculo, pelo e-mail
    const grantEmails = [
      ...new Set(
        windowGrants
          .filter((g) => !g.consumedByUserId)
          .map((g) => g.email.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const grantUsersByEmail: BuyerUserRow[] = [];
    for (const batch of chunks(grantEmails)) {
      grantUsersByEmail.push(
        ...(await this.prisma.user.findMany({
          where: { email: { in: batch, mode: 'insensitive' } },
          select: USER_SELECT,
        })),
      );
    }

    const knownUserIds = [
      ...new Set([
        ...windowPayments.map((p) => p.userId),
        ...windowGrants
          .map((g) => g.consumedByUserId)
          .filter((id): id is string => Boolean(id)),
        ...grantUsersByEmail.map((u) => u.id),
      ]),
    ];

    const users: BuyerUserRow[] = [...grantUsersByEmail];
    const allPaymentsOfKnownUsers: BuyerPaymentRow[] = [];
    for (const batch of chunks(knownUserIds)) {
      const [batchUsers, batchPayments] = await Promise.all([
        this.prisma.user.findMany({
          where: { id: { in: batch } },
          select: USER_SELECT,
        }),
        this.prisma.payment.findMany({
          where: this.realPaymentWhere({ userId: { in: batch } }),
          select: PAYMENT_SELECT,
        }),
      ]);
      users.push(...batchUsers);
      allPaymentsOfKnownUsers.push(...batchPayments.map(toPaymentRow));
    }

    // grants (qualquer data) de quem pagou pela 1ª vez na janela: diz se o cliente novo veio da isca
    const firstPaymentAt = new Map<string, Date>();
    for (const p of allPaymentsOfKnownUsers) {
      const prev = firstPaymentAt.get(p.userId);
      if (!prev || p.createdAt < prev)
        firstPaymentAt.set(p.userId, p.createdAt);
    }
    const newBuyerIds = [...firstPaymentAt.entries()]
      .filter(([, at]) => at >= since)
      .map(([id]) => id);
    const userById = new Map(users.map((u) => [u.id, u]));
    const grantsOfNewBuyers: BuyerGrantRow[] = [];
    for (const batch of chunks(newBuyerIds)) {
      const emails = batch
        .map((id) => userById.get(id)?.email.trim().toLowerCase())
        .filter((e): e is string => Boolean(e));
      grantsOfNewBuyers.push(
        ...(await this.prisma.pendingFreeGenerationGrant.findMany({
          where: {
            OR: [
              { consumedByUserId: { in: batch } },
              ...(emails.length
                ? [{ email: { in: emails, mode: 'insensitive' as const } }]
                : []),
            ],
          },
          select: GRANT_SELECT,
        })),
      );
    }

    return buildBuyersReport({
      days,
      now,
      signups,
      windowPayments,
      users,
      allPaymentsOfKnownUsers,
      windowGrants,
      grantsOfNewBuyers,
    });
  }
}
