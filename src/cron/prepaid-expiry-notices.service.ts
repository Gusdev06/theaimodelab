import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CronLoggerService } from './cron-logger.service';
import { MailLocale, mailLocaleFor, sitePathFor } from '../email/brand-email';
import {
  PREPAID_PLAN_SLUG_SUFFIX,
  endedByExpiry,
  isPrepaidNoticesEnabled,
} from '../plans/prepaid-plan';

// Meia hora depois do cron de vencimento (minuto 0): o D0 já encontra a assinatura cancelada.
const SCHEDULE = '30 * * * *';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** D-3: vence em até 72 h. D-1: em até 24 h. */
const D3_WINDOW_MS = 72 * HOUR_MS;
const D1_WINDOW_MS = 24 * HOUR_MS;
/** D0: avisa até 48 h depois do vencimento (cobre uma rodada perdida do cron). */
const D0_WINDOW_MS = 48 * HOUR_MS;

export const PREPAID_EXPIRING_TYPE = 'prepaid-expiring';
export const PREPAID_EXPIRED_TYPE = 'prepaid-expired';
export const PREPAID_RENEW_BASE_URL = 'https://www.theaimodelab.com';
/** `sequence` em email_sequence_logs que guarda os avisos do sino já dados (não é e-mail). */
export const PREPAID_NOTICE_SEQUENCE = 'prepaid_notice';

export type PrepaidMilestone = 'D-3' | 'D-1' | 'D0';

/** Marco do aviso antes do vencimento, ou null fora da janela de 72 h. */
export function expiringMilestone(currentPeriodEnd: Date, now: Date): PrepaidMilestone | null {
  const left = currentPeriodEnd.getTime() - now.getTime();
  if (left <= 0 || left > D3_WINDOW_MS) return null;
  return left <= D1_WINDOW_MS ? 'D-1' : 'D-3';
}

/** Nome do plano sem o "30 dias" que o nome do pré-pago pode trazer (o texto já diz). */
export function prepaidPlanDisplayName(name: string): string {
  const cleaned = name.replace(/\s*[(\-–·]?\s*30\s*(d|dias|días|days)\s*\)?\s*$/i, '').trim();
  return cleaned || name;
}

/** Texto do sino (só texto, sem link clicável) na língua da cliente. */
export function prepaidNoticeText(
  locale: MailLocale,
  planName: string,
  daysLeft: number | null,
): string {
  const plan = prepaidPlanDisplayName(planName);
  if (locale === 'pt') {
    if (daysLeft === null) {
      return `Seu plano ${plan} (acesso de 30 dias) venceu. Renove em theaimodelab.com/pricing: suas modelos estão esperando por você.`;
    }
    const when = daysLeft === 1 ? '1 dia' : `${daysLeft} dias`;
    return `Seu plano ${plan} (acesso de 30 dias) vence em ${when}. Renove em theaimodelab.com/pricing e continue criando sem pausa.`;
  }
  if (locale === 'es') {
    if (daysLeft === null) {
      return `Tu plan ${plan} (acceso de 30 días) venció. Renueva en theaimodelab.com/pricing: tus modelos te están esperando.`;
    }
    const when = daysLeft === 1 ? '1 día' : `${daysLeft} días`;
    return `Tu plan ${plan} (acceso de 30 días) vence en ${when}. Renueva en theaimodelab.com/pricing y sigue creando sin pausa.`;
  }
  if (daysLeft === null) {
    return `Your ${plan} plan (30-day access) has expired. Renew at theaimodelab.com/pricing: your models are waiting for you.`;
  }
  const when = daysLeft === 1 ? '1 day' : `${daysLeft} days`;
  return `Your ${plan} plan (30-day access) expires in ${when}. Renew at theaimodelab.com/pricing and keep creating without a pause.`;
}

export function prepaidNoticeKey(subscriptionId: string, currentPeriodEnd: Date, milestone: PrepaidMilestone): string {
  return `${subscriptionId}:${currentPeriodEnd.toISOString()}:${milestone}`;
}

interface NoticeCandidate {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  updatedAt: Date;
  plan: { slug: string; name: string };
  user: { locale: string | null; country: string | null };
}

/**
 * Aviso do pré-pago de 30 dias no sino da plataforma (TKT-290): D-3 e D-1 antes de
 * vencer ('prepaid-expiring') e D0 logo depois ('prepaid-expired'). Uma notificação por
 * marco. O "já avisei" fica em email_sequence_logs (único por conta + chave), não na
 * notificação: o "Limpar" do sino apaga a notificação e o aviso voltaria a cada hora.
 * Env PREPAID_NOTICES=off desliga.
 */
@Injectable()
export class PrepaidExpiryNoticesService {
  private readonly logger = new Logger(PrepaidExpiryNoticesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleNotices() {
    if (!isPrepaidNoticesEnabled()) return { skipped: 'PREPAID_NOTICES=off' };
    try {
      return await this.cronLogger.wrap(
        { cronName: 'PrepaidExpiryNoticesService.handleNotices', schedule: SCHEDULE },
        () => this.run(new Date()),
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Prepaid notices cron failed: ${err.message}`, err.stack);
      return undefined;
    }
  }

  async run(now: Date): Promise<{ candidates: number; created: number }> {
    const select = {
      id: true,
      userId: true,
      status: true,
      currentPeriodEnd: true,
      updatedAt: true,
      plan: { select: { slug: true, name: true } },
      user: { select: { locale: true, country: true } },
    } as const;
    const prepaidPlan = { slug: { endsWith: PREPAID_PLAN_SLUG_SUFFIX } };

    const [expiring, ended] = await Promise.all([
      this.prisma.subscription.findMany({
        where: {
          status: SubscriptionStatus.ACTIVE,
          plan: prepaidPlan,
          currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + D3_WINDOW_MS) },
        },
        select,
      }),
      this.prisma.subscription.findMany({
        where: {
          status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.CANCELED] },
          plan: prepaidPlan,
          currentPeriodEnd: { gt: new Date(now.getTime() - D0_WINDOW_MS), lte: now },
        },
        select,
      }),
    ]);

    let created = 0;
    for (const sub of expiring as NoticeCandidate[]) {
      const milestone = expiringMilestone(sub.currentPeriodEnd, now);
      if (!milestone) continue;
      const daysLeft = Math.max(1, Math.ceil((sub.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS));
      if (await this.notify(sub, PREPAID_EXPIRING_TYPE, milestone, daysLeft)) created++;
    }

    for (const sub of ended as NoticeCandidate[]) {
      // Estorno/chargeback cancela antes do fim: não é vencimento, não avisa.
      if (!endedByExpiry(sub, now)) continue;
      // Já recomprou (outro plano ou depois de vencer): não há o que renovar.
      const otherActive = await this.prisma.subscription.findFirst({
        where: { userId: sub.userId, status: SubscriptionStatus.ACTIVE, id: { not: sub.id } },
        select: { id: true },
      });
      if (otherActive) continue;
      if (await this.notify(sub, PREPAID_EXPIRED_TYPE, 'D0', null)) created++;
    }

    const candidates = expiring.length + ended.length;
    if (created > 0) this.logger.log(`Prepaid notices: ${created} created (${candidates} candidates)`);
    return { candidates, created };
  }

  /** Cria a notificação do marco se ainda não existe. Devolve true quando criou. */
  private async notify(
    sub: NoticeCandidate,
    type: string,
    milestone: PrepaidMilestone,
    daysLeft: number | null,
  ): Promise<boolean> {
    const key = prepaidNoticeKey(sub.id, sub.currentPeriodEnd, milestone);
    // Reserva antes de criar: outra instância que chegar junto bate no P2002 e sai.
    let claimId: string;
    try {
      const claim = await this.prisma.emailSequenceLog.create({
        data: { userId: sub.userId, sequence: PREPAID_NOTICE_SEQUENCE, emailKey: `${PREPAID_NOTICE_SEQUENCE}:${key}` },
        select: { id: true },
      });
      claimId = claim.id;
    } catch (error: unknown) {
      if ((error as { code?: string } | null)?.code === 'P2002') return false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Prepaid notice ${key}: claim failed: ${message}`);
      return false;
    }
    try {
      const locale = mailLocaleFor(sub.user);
      await this.notifications.create(sub.userId, type, {
        key,
        reason: prepaidNoticeText(locale, sub.plan.name, daysLeft),
        milestone,
        subscriptionId: sub.id,
        planSlug: sub.plan.slug,
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        url: `${PREPAID_RENEW_BASE_URL}/${sitePathFor(locale)}/pricing`,
      });
      return true;
    } catch (error: unknown) {
      // Não saiu: libera a reserva para a próxima rodada tentar de novo (dentro da janela).
      await this.prisma.emailSequenceLog.delete({ where: { id: claimId } }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Prepaid notice ${key} failed: ${message}`);
      return false;
    }
  }
}
