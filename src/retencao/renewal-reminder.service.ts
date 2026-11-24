import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { sitePathFor } from '../email/brand-email';
import { isPrepaidPlanSlug } from '../plans/prepaid-plan';
import { prepaidPlanDisplayName } from '../cron/prepaid-expiry-notices.service';
import { showMiaFor } from '../email-sequences/mia-email';
import { appBaseUrl, emailLocaleOf, sendMiaEmail, toMailLocale } from '../email-sequences/mia-mailer';
import { buildRenewalReminderEmail } from '../email-sequences/retencao-templates';
import { billingDescriptorFor } from '../payments/billing-descriptor';
import { RENEWAL_REMINDER_EMAIL_ENV, isFlagOn } from './retencao-flags';

/**
 * Lembrete 3 dias antes da renovação da Perfect Pay e da Cakto, com o nome na fatura (candy-retencao, L17, 24/11/2026).
 *
 * Molde: Candy escreve "Charge shown as "EverAI" on your bank statement" no checkout (candy.ai/subscriptions); no
 * varejo de assinatura, o aviso antes de cobrar reduz a ligação ao banco. Meta interna: disputa < 0,5% (hoje 0,8%,
 * TKT-353). Sem preço novo: conta de prejuízo zero n/a.
 *
 * - Quem: assinatura ATIVA da Perfect Pay/Cakto que não vai cancelar, de plano pago recorrente (pré-pago fica no
 *   aviso próprio do sino), com o fim do período entre 2 e 3 dias à frente.
 * - Texto: plano, data, o valor da última cobrança desta assinatura (número real), o nome na fatura quando
 *   configurado (BILLING_DESCRIPTOR_*) e os créditos usados no ciclo; botão "Gerenciar assinatura".
 * - É aviso de cobrança, não marketing: sai mesmo para quem se descadastrou do marketing.
 * - Dedupe por claim em email_sequence_logs (sequence `renewal_reminder`, 1 por assinatura e ciclo).
 * - Desligado por padrão: RENEWAL_REMINDER_EMAIL=on liga.
 */
export const RENEWAL_REMINDER_SEQUENCE = 'renewal_reminder';

const DAY_MS = 24 * 60 * 60 * 1000;
const RUN_LIMIT = 500;

export function renewalReminderKey(subscriptionId: string, periodEnd: Date): string {
  return `${RENEWAL_REMINDER_SEQUENCE}:${subscriptionId}:${periodEnd.toISOString().slice(0, 10)}`;
}

/** Janela do D-3: o fim do período cai entre 2 e 3 dias à frente (o cron roda 1×/dia, cada ciclo entra 1 vez). */
export function reminderWindow(now: Date): { gt: Date; lte: Date } {
  return { gt: new Date(now.getTime() + 2 * DAY_MS), lte: new Date(now.getTime() + 3 * DAY_MS) };
}

@Injectable()
export class RenewalReminderService {
  private readonly logger = new Logger(RenewalReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  isEnabled(): boolean {
    return isFlagOn(this.configService.get<string>(RENEWAL_REMINDER_EMAIL_ENV));
  }

  /** 1×/dia às 15h UTC (12h BRT). */
  @Cron('0 15 * * *')
  async run(now: Date = new Date()): Promise<{ due: number; sent: number }> {
    const result = { due: 0, sent: 0 };
    if (!this.isEnabled()) return result;
    try {
      const subs = await this.prisma.subscription.findMany({
        where: {
          status: SubscriptionStatus.ACTIVE,
          cancelAtPeriodEnd: false,
          paymentProvider: { in: ['perfectpay', 'cakto'] },
          currentPeriodEnd: reminderWindow(now),
          plan: { slug: { not: 'free' } },
          user: { isActive: true },
        },
        orderBy: { currentPeriodEnd: 'asc' },
        take: RUN_LIMIT,
        select: {
          id: true,
          userId: true,
          currentPeriodEnd: true,
          paymentProvider: true,
          plan: { select: { slug: true, name: true } },
          user: {
            select: { id: true, email: true, name: true, locale: true, country: true, signupBrand: true },
          },
        },
      });
      for (const sub of subs) {
        if (isPrepaidPlanSlug(sub.plan.slug)) continue;
        result.due++;
        try {
          if (await this.remind(sub)) result.sent++;
        } catch (error: unknown) {
          this.logger.error(`Lembrete de renovação (sub ${sub.id}): ${messageOf(error)}`);
        }
      }
      if (result.sent) this.logger.log(`Lembrete de renovação: ${result.sent}/${result.due} enviado(s)`);
    } catch (error: unknown) {
      this.logger.error(`Varredura do lembrete de renovação falhou: ${messageOf(error)}`);
    }
    return result;
  }

  private async remind(sub: {
    id: string;
    userId: string;
    currentPeriodEnd: Date;
    paymentProvider: string | null;
    plan: { slug: string; name: string };
    user: { id: string; email: string; name: string | null; locale: string | null; country: string | null; signupBrand: string | null };
  }): Promise<boolean> {
    // valor real: a última cobrança concluída desta assinatura; sem ela, não há número para dizer
    const lastPayment = await this.prisma.payment.findFirst({
      where: { subscriptionId: sub.id, status: 'COMPLETED', amountCents: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      select: { amountCents: true, currency: true },
    });
    if (!lastPayment) return false;

    let claimId: string;
    try {
      const claim = await this.prisma.emailSequenceLog.create({
        data: {
          userId: sub.userId,
          sequence: RENEWAL_REMINDER_SEQUENCE,
          emailKey: renewalReminderKey(sub.id, sub.currentPeriodEnd),
        },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code === 'P2002') return false;
      throw error;
    }

    try {
      const locale = emailLocaleOf(sub.user);
      const balance = await this.prisma.creditBalance.findUnique({
        where: { userId: sub.userId },
        select: { planCreditsUsed: true },
      });
      const descriptor = billingDescriptorFor(sub.paymentProvider, {
        BILLING_DESCRIPTOR: this.configService.get<string>('BILLING_DESCRIPTOR'),
        BILLING_DESCRIPTOR_PERFECTPAY: this.configService.get<string>('BILLING_DESCRIPTOR_PERFECTPAY'),
        BILLING_DESCRIPTOR_CAKTO: this.configService.get<string>('BILLING_DESCRIPTOR_CAKTO'),
      });
      const { subject, body } = buildRenewalReminderEmail(
        {
          planName: prepaidPlanDisplayName(sub.plan.name),
          renewAt: sub.currentPeriodEnd,
          amountCents: lastPayment.amountCents,
          currency: lastPayment.currency,
          descriptor,
          creditsUsed: balance?.planCreditsUsed ?? 0,
          manageUrl: `${appBaseUrl()}/${sitePathFor(toMailLocale(locale))}/perfil?utm_source=email&utm_campaign=renewal_reminder`,
        },
        locale,
        { mia: showMiaFor(sub.user.signupBrand) },
      );
      const resendId = await sendMiaEmail(this.emailService, {
        recipient: sub.user,
        subject,
        bodyMarkdown: body,
        plan: sub.plan.name,
      });
      if (!resendId) {
        // e-mail não configurado: libera a reserva para a próxima rodada
        await this.prisma.emailSequenceLog.delete({ where: { id: claimId } }).catch(() => undefined);
        return false;
      }
      await this.prisma.emailSequenceLog
        .update({ where: { id: claimId }, data: { resendEmailId: resendId } })
        .catch(() => undefined);
      return true;
    } catch (error: unknown) {
      await this.prisma.emailSequenceLog.delete({ where: { id: claimId } }).catch(() => undefined);
      throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
