import { resolveBrand } from '../brand/brand';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { x1LocaleFrom } from '../email/x1-footer';
import { SettingsService, SETTING_KEYS } from '../settings/settings.service';
import { CronLoggerService } from './cron-logger.service';
import { renderMarkdownToEmailHtml } from '../admin-emails/helpers/markdown.helper';
import { wrapInBroadcastTemplate } from '../admin-emails/helpers/email-template.helper';
import { applyMergeTags, buildMergeVars } from '../admin-emails/helpers/merge-tags.helper';
import {
  ONBOARDING_EMAILS,
  POST_SUBSCRIPTION_EMAILS,
  pickNextSequenceEmail,
  resolveEmailLocale,
  type SequenceEmail,
} from '../email-sequences/onboarding-sequence-templates';

const SCHEDULE = '0 13 * * *'; // 1x/dia às 13h UTC = 10h BRT

/** Email expira se o dia dele passou há mais deste tanto de dias (sem rajada retroativa). */
const CATCHUP_DAYS = 3;

/**
 * O cadastro cria uma assinatura ACTIVE do plano grátis (936 de 936 contas novas em 21 dias, leitura de 23/11/2026).
 * Por isso a trilha de conversão (exige "nenhuma assinatura") nunca enviou um e-mail, e a pós-assinatura dizia
 * "sua assinatura está ativa" a quem não pagou. Env `CONVERSION_TRACK_FREE_PLAN_SINCE` (data ISO):
 * - vazia ou inválida = comportamento antigo (nada muda no deploy);
 * - com data = conta grátis criada a partir dela entra na trilha de conversão, e a pós-assinatura fica só com plano pago.
 *   Só contas novas a partir da data: ligar não dispara rajada para a base antiga.
 */
export function readFreePlanSince(raw: string | undefined | null): Date | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

interface SequenceRecipient {
  userId: string;
  email: string;
  name: string | null;
  plan: string | null;
  /** user.locale cru do banco — resolvido pra pt-BR/en/es na hora do envio. */
  locale: string | null;
  /** users.signup_brand: site em que a conta nasceu (null = The AI Model Lab) — marca e links do e-mail */
  signupBrand?: string | null;
}

@Injectable()
export class OnboardingSequenceService {
  private readonly logger = new Logger(OnboardingSequenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async processSequences(): Promise<void> {
    try {
      // Flag editável pelo admin em /admin/emails (tabela app_settings)
      const enabled = await this.settingsService.getBool(
        SETTING_KEYS.onboardingSequenceEnabled,
        false,
      );
      if (!enabled) {
        this.logger.log('Sequência de onboarding desativada no admin — pulando');
        return;
      }

      await this.cronLogger.wrap(
        {
          cronName: 'OnboardingSequenceService.processSequences',
          schedule: SCHEDULE,
        },
        async () => {
          const appUrl =
            this.configService.get<string>('FRONTEND_URL')?.split(',')[0]?.trim() ||
            'https://theaimodelab.com';
          const logoUrl = this.configService.get<string>('LOGO_URL') || '';

          const conversion = await this.processConversionTrack(appUrl, logoUrl);
          const postSub = await this.processPostSubscriptionTrack(appUrl, logoUrl);

          return { conversion, postSub };
        },
      );
    } catch (err: any) {
      this.logger.error(`processSequences falhou: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────────────
  // Trilha de conversão: cadastrou, nunca assinou
  // ────────────────────────────────────────────────────────
  private async processConversionTrack(appUrl: string, logoUrl: string) {
    const maxOffset = Math.max(...ONBOARDING_EMAILS.map((e) => e.offsetDays));
    const cutoff = this.daysAgo(maxOffset + CATCHUP_DAYS);

    const freePlanSince = readFreePlanSince(this.configService.get<string>('CONVERSION_TRACK_FREE_PLAN_SINCE'));
    const users = await this.prisma.user.findMany({
      where: freePlanSince
        ? {
            isActive: true,
            emailVerified: true,
            createdAt: { gte: cutoff > freePlanSince ? cutoff : freePlanSince },
            // Nunca teve plano pago (ativo, cancelado ou past_due); a assinatura do plano grátis não conta.
            subscriptions: { none: { plan: { slug: { not: 'free' } } } },
          }
        : {
            isActive: true,
            emailVerified: true,
            createdAt: { gte: cutoff },
            // Nunca passou pelo checkout — quem já tem qualquer assinatura
            // (ativa, cancelada, past_due) sai da trilha de conversão.
            subscriptions: { none: {} },
          },
      select: {
        id: true,
        email: true,
        name: true,
        locale: true,
        signupBrand: true,
        createdAt: true,
        emailSequenceLogs: { select: { emailKey: true } },
      },
    });

    let sent = 0;
    for (const user of users) {
      const sentKeys = new Set(user.emailSequenceLogs.map((l) => l.emailKey));
      const emailToSend = pickNextSequenceEmail(
        ONBOARDING_EMAILS,
        this.daysSince(user.createdAt),
        sentKeys,
        CATCHUP_DAYS,
      );
      if (!emailToSend) continue;

      const ok = await this.sendSequenceEmail(
        emailToSend,
        { userId: user.id, email: user.email, name: user.name, plan: null, locale: user.locale, signupBrand: user.signupBrand },
        appUrl,
        logoUrl,
      );
      if (ok) sent++;
    }

    this.logger.log(`Trilha de conversão: ${users.length} usuários na janela, ${sent} emails enviados`);
    return { usersInWindow: users.length, sent };
  }

  // ────────────────────────────────────────────────────────
  // Trilha pós-assinatura: assinou → ativação
  // ────────────────────────────────────────────────────────
  private async processPostSubscriptionTrack(appUrl: string, logoUrl: string) {
    const maxOffset = Math.max(...POST_SUBSCRIPTION_EMAILS.map((e) => e.offsetDays));
    const cutoff = this.daysAgo(maxOffset + CATCHUP_DAYS);

    const freePlanSince = readFreePlanSince(this.configService.get<string>('CONVERSION_TRACK_FREE_PLAN_SINCE'));
    const subs = await this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        createdAt: { gte: cutoff },
        // com a correção ligada, "assinatura ativa" é só plano pago (o grátis vai para a trilha de conversão)
        ...(freePlanSince ? { plan: { slug: { not: 'free' } } } : {}),
        user: {
          isActive: true,
          emailVerified: true,
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        plan: { select: { name: true } },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            locale: true,
            signupBrand: true,
            emailSequenceLogs: { select: { emailKey: true } },
          },
        },
      },
    });

    // Uma trilha por usuário — se houver mais de uma assinatura recente,
    // vale a mais nova (primeira no orderBy desc).
    const byUser = new Map<string, (typeof subs)[number]>();
    for (const sub of subs) {
      if (!byUser.has(sub.user.id)) byUser.set(sub.user.id, sub);
    }

    let sent = 0;
    for (const sub of byUser.values()) {
      const sentKeys = new Set(sub.user.emailSequenceLogs.map((l) => l.emailKey));
      const emailToSend = pickNextSequenceEmail(
        POST_SUBSCRIPTION_EMAILS,
        this.daysSince(sub.createdAt),
        sentKeys,
        CATCHUP_DAYS,
      );
      if (!emailToSend) continue;

      const ok = await this.sendSequenceEmail(
        emailToSend,
        {
          userId: sub.user.id,
          email: sub.user.email,
          name: sub.user.name,
          plan: sub.plan.name,
          locale: sub.user.locale,
          signupBrand: sub.user.signupBrand,
        },
        appUrl,
        logoUrl,
      );
      if (ok) sent++;
    }

    this.logger.log(`Trilha pós-assinatura: ${byUser.size} assinantes na janela, ${sent} emails enviados`);
    return { subscribersInWindow: byUser.size, sent };
  }

  // ────────────────────────────────────────────────────────
  // Envio — mesmo pipeline de render dos broadcasts do admin
  // ────────────────────────────────────────────────────────
  private async sendSequenceEmail(
    template: SequenceEmail,
    recipient: SequenceRecipient,
    appUrl: string,
    logoUrl: string,
  ): Promise<boolean> {
    try {
      // conta que nasceu noutra marca (Funvmake): links, logo, nome e remetente dela
      const brand = resolveBrand(recipient.signupBrand);
      const brandAppUrl = brand.key === 'taml' ? appUrl : brand.frontendUrl;
      const brandLogoUrl = brand.key === 'taml' ? logoUrl : brand.logoUrl || logoUrl;
      const content = template.content[resolveEmailLocale(recipient.locale)];
      const innerHtml = await renderMarkdownToEmailHtml(
        content.body(brandAppUrl, { mia: brand.key === 'taml' }),
      );
      const wrappedHtml = wrapInBroadcastTemplate(innerHtml, brandLogoUrl);
      const vars = buildMergeVars({
        name: recipient.name,
        plan: recipient.plan,
        email: recipient.email,
      });
      const html = applyMergeTags(wrappedHtml, vars);
      const subject = applyMergeTags(content.subject, vars);

      const { id } = await this.emailService.sendRawEmail({
        to: recipient.email,
        subject,
        html,
        brand,
        x1Locale: x1LocaleFrom(recipient.locale),
      });
      if (!id) {
        this.logger.warn(`Email ${template.key} não enviado para ${recipient.email} (service não configurado)`);
        return false;
      }

      await this.prisma.emailSequenceLog.create({
        data: {
          userId: recipient.userId,
          sequence: template.sequence,
          emailKey: template.key,
          resendEmailId: id,
        },
      });

      this.logger.log(`Sequência ${template.key} enviada para ${recipient.email} (resend id: ${id})`);
      return true;
    } catch (err: any) {
      // Violação do unique (userId, emailKey) = corrida benigna — já foi enviado.
      if (err.code === 'P2002') return false;
      this.logger.error(`Sequência ${template.key} falhou para ${recipient.email}: ${err.message}`);
      return false;
    }
  }

  private daysSince(date: Date): number {
    return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
  }

  private daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}
