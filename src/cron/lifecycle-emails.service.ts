import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { GenerationStatus, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { CronLoggerService } from './cron-logger.service';
import { renderMarkdownToEmailHtml } from '../admin-emails/helpers/markdown.helper';
import { wrapInBroadcastTemplate } from '../admin-emails/helpers/email-template.helper';
import { applyMergeTags, buildMergeVars } from '../admin-emails/helpers/merge-tags.helper';
import {
  buildLowBalanceEmail,
  buildCreditsDepletedEmail,
  buildWinbackEmail,
} from '../email-sequences/lifecycle-templates';
import { resolveEmailLocale } from '../email-sequences/onboarding-sequence-templates';

// 1x/dia às 14h UTC = 11h BRT — 1h depois do onboarding (13h UTC) pra não
// concorrer pela janela de envio nem pelo mesmo lock de instância.
const SCHEDULE = '0 14 * * *';

/** Flag env — só roda com LIFECYCLE_EMAILS_ENABLED === 'true'. */
const ENABLED_ENV = 'LIFECYCLE_EMAILS_ENABLED';

const SEQUENCE_NAME = 'lifecycle';

// ── Critérios ──────────────────────────────────────────
/** Email 1: dispara quando 0 < saldo total <= 20% da cota mensal do plano. */
const LOW_BALANCE_FRACTION = 0.2;
/** Email 1: no máximo 1 envio a cada 7 dias (guarda extra além do por-ciclo). */
const LOW_BALANCE_MIN_INTERVAL_DAYS = 7;
/** Email 2: só se ainda faltarem >= 5 dias até a renovação. */
const DEPLETED_MIN_DAYS_LEFT = 5;
/** Email 3: winback disparado ~7 dias após a expiração/cancelamento. */
const WINBACK_TARGET_DAYS = 7;
/** Janela do winback: [7, 7+catchup) dias — evita rajada retroativa. */
const WINBACK_CATCHUP_DAYS = 2;

interface LifecycleRecipient {
  userId: string;
  email: string;
  name: string | null;
  plan: string | null;
}

@Injectable()
export class LifecycleEmailsService {
  private readonly logger = new Logger(LifecycleEmailsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async processLifecycleEmails(): Promise<void> {
    try {
      const enabled =
        this.configService.get<string>(ENABLED_ENV) === 'true';
      if (!enabled) {
        this.logger.log(
          `Emails de lifecycle desativados (${ENABLED_ENV} != "true") — pulando`,
        );
        return;
      }

      await this.cronLogger.wrap(
        {
          cronName: 'LifecycleEmailsService.processLifecycleEmails',
          schedule: SCHEDULE,
        },
        async () => {
          const appUrl =
            this.configService
              .get<string>('FRONTEND_URL')
              ?.split(',')[0]
              ?.trim() || 'https://theaimodelab.com';
          const logoUrl = this.configService.get<string>('LOGO_URL') || '';

          const lowBalance = await this.processLowBalance(appUrl, logoUrl);
          const depleted = await this.processCreditsDepleted(appUrl, logoUrl);
          const winback = await this.processWinback(appUrl, logoUrl);

          return { lowBalance, depleted, winback };
        },
      );
    } catch (err: any) {
      this.logger.error(`processLifecycleEmails falhou: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────────────
  // Email 1 — Saldo baixo
  // Assinante ativo com 0 < (planCreditsRemaining + bonusCreditsRemaining)
  //   <= 20% da cota mensal do plano.
  // emailKey por ciclo → 1 envio por ciclo; guarda extra de 7 dias.
  // ────────────────────────────────────────────────────────
  private async processLowBalance(appUrl: string, logoUrl: string) {
    const subs = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        user: {
          isActive: true,
          emailVerified: true,
        },
      },
      select: {
        currentPeriodStart: true,
        plan: { select: { name: true, creditsPerMonth: true } },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            locale: true,
            creditBalance: {
              select: {
                planCreditsRemaining: true,
                bonusCreditsRemaining: true,
              },
            },
            emailSequenceLogs: {
              where: { sequence: SEQUENCE_NAME },
              select: { emailKey: true, sentAt: true },
            },
          },
        },
      },
    });

    let candidates = 0;
    let sent = 0;
    for (const sub of subs) {
      const balance = sub.user.creditBalance;
      if (!balance) continue;

      const total =
        balance.planCreditsRemaining + balance.bonusCreditsRemaining;
      const monthly = sub.plan.creditsPerMonth;
      const threshold = Math.floor(monthly * LOW_BALANCE_FRACTION);

      // 0 < total <= 20% da cota. Saldo zerado é território do Email 2.
      if (total <= 0 || total > threshold) continue;
      candidates++;

      const emailKey = `${SEQUENCE_NAME}-low-balance-${sub.user.id}-${this.cycleKey(
        sub.currentPeriodStart,
      )}`;

      // 1 por ciclo (unique userId+emailKey) + guarda de 7 dias entre quaisquer
      // low-balance (protege contra ciclos curtos / renovações antecipadas).
      if (this.alreadySent(sub.user.emailSequenceLogs, emailKey)) continue;
      if (
        this.sentWithinDays(
          sub.user.emailSequenceLogs,
          `${SEQUENCE_NAME}-low-balance-`,
          LOW_BALANCE_MIN_INTERVAL_DAYS,
        )
      ) {
        continue;
      }

      const { subject, body } = buildLowBalanceEmail(
        {
          appUrl,
          totalCredits: total,
          monthlyCredits: monthly,
        },
        resolveEmailLocale(sub.user.locale),
      );

      const ok = await this.sendLifecycleEmail(
        emailKey,
        subject,
        body,
        {
          userId: sub.user.id,
          email: sub.user.email,
          name: sub.user.name,
          plan: sub.plan.name,
        },
        logoUrl,
      );
      if (ok) sent++;
    }

    this.logger.log(
      `Lifecycle saldo-baixo: ${candidates} elegíveis, ${sent} emails enviados`,
    );
    return { candidates, sent };
  }

  // ────────────────────────────────────────────────────────
  // Email 2 — Créditos esgotados no meio do ciclo
  // Assinante ativo, saldo total 0, >= 5 dias até a renovação.
  // emailKey por ciclo → envio único por ciclo.
  // ────────────────────────────────────────────────────────
  private async processCreditsDepleted(appUrl: string, logoUrl: string) {
    const now = new Date();

    const subs = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: { gt: now },
        user: {
          isActive: true,
          emailVerified: true,
        },
      },
      select: {
        currentPeriodStart: true,
        currentPeriodEnd: true,
        plan: { select: { name: true, creditsPerMonth: true } },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            locale: true,
            creditBalance: {
              select: {
                planCreditsRemaining: true,
                bonusCreditsRemaining: true,
              },
            },
            emailSequenceLogs: {
              where: { sequence: SEQUENCE_NAME },
              select: { emailKey: true, sentAt: true },
            },
          },
        },
      },
    });

    // Tiers pra achar o "próximo acima" (por créditos/mês). Só planos ativos.
    const activePlans = await this.prisma.plan.findMany({
      where: { isActive: true },
      select: { name: true, creditsPerMonth: true, priceCents: true },
      orderBy: { creditsPerMonth: 'asc' },
    });

    let candidates = 0;
    let sent = 0;
    for (const sub of subs) {
      const balance = sub.user.creditBalance;
      if (!balance) continue;

      const total =
        balance.planCreditsRemaining + balance.bonusCreditsRemaining;
      if (total !== 0) continue;

      const daysUntilRenewal = this.daysBetween(now, sub.currentPeriodEnd);
      if (daysUntilRenewal < DEPLETED_MIN_DAYS_LEFT) continue;

      candidates++;

      const emailKey = `${SEQUENCE_NAME}-depleted-${sub.user.id}-${this.cycleKey(
        sub.currentPeriodStart,
      )}`;
      if (this.alreadySent(sub.user.emailSequenceLogs, emailKey)) continue;

      const upgrade = this.findNextTier(activePlans, sub.plan.creditsPerMonth);
      const daysUsed = Math.max(
        0,
        this.daysBetween(sub.currentPeriodStart, now),
      );

      const { subject, body } = buildCreditsDepletedEmail(
        {
          appUrl,
          monthlyCredits: sub.plan.creditsPerMonth,
          daysUsed,
          daysUntilRenewal,
          upgrade: upgrade
            ? {
                name: upgrade.name,
                creditsPerMonth: upgrade.creditsPerMonth,
                priceUsd: upgrade.priceCents / 100,
              }
            : null,
        },
        resolveEmailLocale(sub.user.locale),
      );

      const ok = await this.sendLifecycleEmail(
        emailKey,
        subject,
        body,
        {
          userId: sub.user.id,
          email: sub.user.email,
          name: sub.user.name,
          plan: sub.plan.name,
        },
        logoUrl,
      );
      if (ok) sent++;
    }

    this.logger.log(
      `Lifecycle créditos-esgotados: ${candidates} elegíveis, ${sent} emails enviados`,
    );
    return { candidates, sent };
  }

  // ────────────────────────────────────────────────────────
  // Email 3 — Winback pós-cancelamento/expiração
  // Assinatura CANCELED cujo período pago acabou entre 7 e 7+catchup dias atrás.
  // (PerfectpaySubscriptionExpiryService marca CANCELED e é quando o acesso de
  //  fato termina; usamos currentPeriodEnd como a data da expiração.)
  // emailKey inclui a data de expiração → permite winback em cancelamentos
  //   futuros distintos, mas nunca duas vezes pro mesmo evento.
  // ────────────────────────────────────────────────────────
  private async processWinback(appUrl: string, logoUrl: string) {
    const now = new Date();
    const windowStart = this.daysAgo(WINBACK_TARGET_DAYS + WINBACK_CATCHUP_DAYS);
    const windowEnd = this.daysAgo(WINBACK_TARGET_DAYS);

    const subs = await this.prisma.subscription.findMany({
      where: {
        status: SubscriptionStatus.CANCELED,
        currentPeriodEnd: { gte: windowStart, lte: windowEnd },
        user: {
          isActive: true,
          emailVerified: true,
        },
      },
      orderBy: { currentPeriodEnd: 'desc' },
      select: {
        currentPeriodEnd: true,
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            locale: true,
            // Se o usuário voltou a assinar (nova ACTIVE), não é winback.
            subscriptions: {
              where: { status: SubscriptionStatus.ACTIVE },
              select: { id: true },
            },
            emailSequenceLogs: {
              where: { sequence: SEQUENCE_NAME },
              select: { emailKey: true, sentAt: true },
            },
          },
        },
      },
    });

    // Um winback por usuário nesta execução (o cancelamento mais recente).
    const byUser = new Map<string, (typeof subs)[number]>();
    for (const sub of subs) {
      if (sub.user.subscriptions.length > 0) continue; // reativou → pula
      if (!byUser.has(sub.user.id)) byUser.set(sub.user.id, sub);
    }

    let candidates = 0;
    let sent = 0;
    for (const sub of byUser.values()) {
      candidates++;

      const emailKey = `${SEQUENCE_NAME}-winback-${sub.user.id}-${this.cycleKey(
        sub.currentPeriodEnd,
      )}`;
      if (this.alreadySent(sub.user.emailSequenceLogs, emailKey)) continue;

      const generationsCount = await this.prisma.generation.count({
        where: {
          userId: sub.user.id,
          status: GenerationStatus.COMPLETED,
        },
      });

      const { subject, body } = buildWinbackEmail(
        {
          appUrl,
          generationsCount,
        },
        resolveEmailLocale(sub.user.locale),
      );

      const ok = await this.sendLifecycleEmail(
        emailKey,
        subject,
        body,
        {
          userId: sub.user.id,
          email: sub.user.email,
          name: sub.user.name,
          plan: null,
        },
        logoUrl,
      );
      if (ok) sent++;
    }

    this.logger.log(
      `Lifecycle winback: ${byUser.size} elegíveis, ${sent} emails enviados`,
    );
    return { candidates: byUser.size, sent };
  }

  // ────────────────────────────────────────────────────────
  // Envio — mesmo pipeline de render dos broadcasts do admin
  // ────────────────────────────────────────────────────────
  private async sendLifecycleEmail(
    emailKey: string,
    subjectTemplate: string,
    bodyMarkdown: string,
    recipient: LifecycleRecipient,
    logoUrl: string,
  ): Promise<boolean> {
    try {
      const innerHtml = await renderMarkdownToEmailHtml(bodyMarkdown);
      const wrappedHtml = wrapInBroadcastTemplate(innerHtml, logoUrl);
      const vars = buildMergeVars({
        name: recipient.name,
        plan: recipient.plan,
        email: recipient.email,
      });
      const html = applyMergeTags(wrappedHtml, vars);
      const subject = applyMergeTags(subjectTemplate, vars);

      const { id } = await this.emailService.sendRawEmail({
        to: recipient.email,
        subject,
        html,
      });
      if (!id) {
        this.logger.warn(
          `Email ${emailKey} não enviado para ${recipient.email} (service não configurado)`,
        );
        return false;
      }

      await this.prisma.emailSequenceLog.create({
        data: {
          userId: recipient.userId,
          sequence: SEQUENCE_NAME,
          emailKey,
          resendEmailId: id,
        },
      });

      this.logger.log(
        `Lifecycle ${emailKey} enviado para ${recipient.email} (resend id: ${id})`,
      );
      return true;
    } catch (err: any) {
      // Violação do unique (userId, emailKey) = corrida benigna — já foi enviado.
      if (err.code === 'P2002') return false;
      this.logger.error(
        `Lifecycle ${emailKey} falhou para ${recipient.email}: ${err.message}`,
      );
      return false;
    }
  }

  // ────────────────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────────────────

  /** Chave estável do ciclo (data ISO, sem hora) pra compor o emailKey. */
  private cycleKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private alreadySent(
    logs: Array<{ emailKey: string }>,
    emailKey: string,
  ): boolean {
    return logs.some((l) => l.emailKey === emailKey);
  }

  /** True se algum email com o prefixo dado foi enviado nos últimos N dias. */
  private sentWithinDays(
    logs: Array<{ emailKey: string; sentAt: Date }>,
    keyPrefix: string,
    days: number,
  ): boolean {
    const cutoff = this.daysAgo(days);
    return logs.some(
      (l) => l.emailKey.startsWith(keyPrefix) && l.sentAt >= cutoff,
    );
  }

  /** Menor tier ativo com mais créditos/mês que o plano atual. */
  private findNextTier(
    plans: Array<{ name: string; creditsPerMonth: number; priceCents: number }>,
    currentCreditsPerMonth: number,
  ): { name: string; creditsPerMonth: number; priceCents: number } | null {
    for (const plan of plans) {
      if (plan.creditsPerMonth > currentCreditsPerMonth) return plan;
    }
    return null;
  }

  /** Dias inteiros de `from` até `to` (>= 0 assumindo to >= from). */
  private daysBetween(from: Date, to: Date): number {
    return Math.floor(
      (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000),
    );
  }

  private daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}
