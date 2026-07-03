import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { StripeService } from '../payments/stripe.service';
import { CronLoggerService } from './cron-logger.service';
import {
  buildRecoveryEmail,
  type BrandConfig,
  type EmailNumber,
  type RecoveryLead,
  type SocialProof,
} from '../payments/recovery/recovery-templates';

const RECENT_CANCEL_DAYS = 30;
const DAYS_BEFORE_EMAIL_2 = 3;
const DAYS_BEFORE_EMAIL_3 = 7;
const DAYS_BEFORE_ABANDON = 10;
const DEFAULT_BONUS_CREDITS = 2000;
const DEFAULT_RECOVERY_COUPON_CODE = 'RECOVERY20';
const DEFAULT_RECOVERY_COUPON_DISCOUNT = '20%';

const SCHEDULE_ENROLL = '0 8 * * *';
const SCHEDULE_PROCESS = '0 12,18 * * *';

@Injectable()
export class PaymentRecoveryCampaignService {
  private readonly logger = new Logger(PaymentRecoveryCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  // ────────────────────────────────────────────────────────
  // JOB 1 — Enrollment (1x/dia às 8h UTC)
  // ────────────────────────────────────────────────────────
  @Cron(SCHEDULE_ENROLL)
  async enrollEligibleSubscriptions(): Promise<void> {
    try {
      await this.cronLogger.wrap(
        {
          cronName: 'PaymentRecoveryCampaignService.enrollEligibleSubscriptions',
          schedule: SCHEDULE_ENROLL,
        },
        async () => {
          const recentCutoff = new Date(Date.now() - RECENT_CANCEL_DAYS * 24 * 60 * 60 * 1000);

          const eligible = await this.prisma.subscription.findMany({
            where: {
              paymentProvider: 'stripe',
              recoveryCampaigns: { is: null },
              OR: [
                { status: 'PAST_DUE' },
                {
                  status: 'CANCELED',
                  paymentRetryCount: { gt: 0 },
                  updatedAt: { gte: recentCutoff },
                },
              ],
            },
            include: { user: { select: { stripeCustomerId: true } } },
          });

          if (eligible.length === 0) {
            this.logger.log('Recovery enrollment: 0 novas subscriptions elegíveis');
            return { eligibleFound: 0, enrolled: 0 };
          }

          this.logger.log(`Recovery enrollment: ${eligible.length} subscriptions elegíveis`);

          let enrolled = 0;
          for (const sub of eligible) {
            const ctx = await this.fetchStripeContext(sub.user.stripeCustomerId);

            try {
              await this.prisma.paymentRecoveryCampaign.create({
                data: {
                  userId: sub.userId,
                  subscriptionId: sub.id,
                  declineCode: ctx.declineCode,
                  cardBrand: ctx.cardBrand,
                  cardLast4: ctx.cardLast4,
                },
              });
              enrolled++;
            } catch (err: any) {
              if (!err.message?.includes('Unique')) {
                this.logger.error(`Falha ao enroll sub ${sub.id}: ${err.message}`);
              }
            }
          }

          return { eligibleFound: eligible.length, enrolled };
        },
      );
    } catch (err: any) {
      this.logger.error(`enrollEligibleSubscriptions falhou: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────────────
  // JOB 2 — Processamento (2x/dia: 12h e 18h UTC = 9h e 15h BR)
  // ────────────────────────────────────────────────────────
  @Cron(SCHEDULE_PROCESS)
  async processCampaigns(): Promise<void> {
    try {
      await this.cronLogger.wrap(
        {
          cronName: 'PaymentRecoveryCampaignService.processCampaigns',
          schedule: SCHEDULE_PROCESS,
        },
        async () => {
          const open = await this.prisma.paymentRecoveryCampaign.findMany({
            where: { recoveredAt: null, abandonedAt: null },
            include: {
              user: { select: { name: true, email: true } },
              subscription: {
                include: { plan: { select: { name: true, priceCents: true } } },
              },
            },
          });

          if (open.length === 0) {
            this.logger.log('Recovery processing: 0 campanhas abertas');
            return { openCampaigns: 0, sent: 0, recovered: 0, abandoned: 0 };
          }

          this.logger.log(`Recovery processing: ${open.length} campanhas abertas`);

          const brand = await this.buildBrandConfig();

          let recoveredCount = 0;
          let sentCount = 0;
          let abandonedCount = 0;

          for (const campaign of open) {
            try {
              if (campaign.subscription.status === 'ACTIVE') {
                await this.prisma.paymentRecoveryCampaign.update({
                  where: { id: campaign.id },
                  data: { recoveredAt: new Date() },
                });
                recoveredCount++;
                continue;
              }

              const daysSinceEnrolled = this.daysSince(campaign.enrolledAt);

              if (daysSinceEnrolled >= DAYS_BEFORE_ABANDON && campaign.email3SentAt) {
                await this.prisma.paymentRecoveryCampaign.update({
                  where: { id: campaign.id },
                  data: { abandonedAt: new Date() },
                });
                abandonedCount++;
                continue;
              }

              const emailToSend = this.decideEmailToSend(campaign, daysSinceEnrolled);
              if (!emailToSend) continue;

              const lead = this.buildLead(campaign);
              const sent = await this.sendEmail(emailToSend, lead, brand, campaign.user.email);

              if (sent) {
                const fieldUpdate =
                  emailToSend === 1
                    ? { email1SentAt: new Date() }
                    : emailToSend === 2
                      ? { email2SentAt: new Date() }
                      : { email3SentAt: new Date() };
                await this.prisma.paymentRecoveryCampaign.update({
                  where: { id: campaign.id },
                  data: fieldUpdate,
                });
                sentCount++;
              }
            } catch (err: any) {
              this.logger.error(`Falha ao processar campanha ${campaign.id}: ${err.message}`);
            }
          }

          this.logger.log(
            `Recovery processing concluído: ${sentCount} emails enviados, ${recoveredCount} recuperados, ${abandonedCount} abandonados`,
          );

          return {
            openCampaigns: open.length,
            sent: sentCount,
            recovered: recoveredCount,
            abandoned: abandonedCount,
          };
        },
      );
    } catch (err: any) {
      this.logger.error(`processCampaigns falhou: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────────────
  // HELPERS
  // ────────────────────────────────────────────────────────

  private decideEmailToSend(
    campaign: { email1SentAt: Date | null; email2SentAt: Date | null; email3SentAt: Date | null },
    daysSinceEnrolled: number,
  ): EmailNumber | null {
    if (!campaign.email1SentAt) return 1;
    if (!campaign.email2SentAt && daysSinceEnrolled >= DAYS_BEFORE_EMAIL_2) return 2;
    if (!campaign.email3SentAt && daysSinceEnrolled >= DAYS_BEFORE_EMAIL_3) return 3;
    return null;
  }

  private buildLead(campaign: any): RecoveryLead {
    const planPriceCents: number = campaign.subscription.plan.priceCents;
    return {
      name: campaign.user.name || 'amigo',
      planName: campaign.subscription.plan.name,
      planPriceBRL: (planPriceCents / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }),
      daysSinceFailure: this.daysSince(campaign.enrolledAt),
      declineCode: campaign.declineCode || 'unknown',
      declineLabel: '',
      cardBrand: campaign.cardBrand,
      cardLast4: campaign.cardLast4,
      billingPortalUrl: null, // gerado on-the-fly abaixo
      lastInvoiceUrl: null,
    };
  }

  private async sendEmail(
    n: EmailNumber,
    lead: RecoveryLead,
    brand: BrandConfig,
    toEmail: string,
  ): Promise<boolean> {
    const built = buildRecoveryEmail(n, lead, brand);
    try {
      const { id } = await this.emailService.sendRawEmail({
        to: toEmail,
        subject: built.subject,
        html: built.html,
      });
      if (!id) {
        this.logger.warn(`Email ${n} não enviado para ${toEmail} (service não configurado)`);
        return false;
      }
      this.logger.log(`Recovery Email ${n} enviado para ${toEmail} (resend id: ${id})`);
      return true;
    } catch (err: any) {
      this.logger.error(`Recovery Email ${n} falhou para ${toEmail}: ${err.message}`);
      return false;
    }
  }

  private async buildBrandConfig(): Promise<BrandConfig> {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL')?.split(',')[0]?.trim() || 'https://theaimodelab.ai';
    const supportEmail =
      this.configService.get<string>('SUPPORT_EMAIL') || 'ola@theaimodelab.ai';
    const recoveryCouponCode =
      this.configService.get<string>('RECOVERY_COUPON_CODE') || DEFAULT_RECOVERY_COUPON_CODE;
    const recoveryCouponDiscount =
      this.configService.get<string>('RECOVERY_COUPON_DISCOUNT') || DEFAULT_RECOVERY_COUPON_DISCOUNT;
    const bonusCredits = parseInt(
      this.configService.get<string>('RECOVERY_BONUS_CREDITS') || String(DEFAULT_BONUS_CREDITS),
      10,
    );

    const socialProof = await this.fetchSocialProof();

    return {
      frontendUrl,
      supportEmail,
      recoveryCouponCode,
      recoveryCouponDiscount,
      bonusCredits,
      socialProof,
    };
  }

  private async fetchSocialProof(): Promise<SocialProof | undefined> {
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const [imagesCount, videosCount, activeCreatorsRaw] = await Promise.all([
        this.prisma.generation.count({
          where: {
            status: 'COMPLETED',
            createdAt: { gte: since },
            type: { in: ['TEXT_TO_IMAGE', 'IMAGE_TO_IMAGE'] as any },
          },
        }),
        this.prisma.generation.count({
          where: {
            status: 'COMPLETED',
            createdAt: { gte: since },
            type: { in: ['TEXT_TO_VIDEO', 'IMAGE_TO_VIDEO', 'MOTION_CONTROL'] as any },
          },
        }),
        this.prisma.generation.findMany({
          where: { status: 'COMPLETED', createdAt: { gte: since } },
          distinct: ['userId'],
          select: { userId: true },
        }),
      ]);

      const sp: SocialProof = {
        imagesThisWeek: imagesCount,
        videosThisWeek: videosCount,
        creatorsActiveThisWeek: activeCreatorsRaw.length,
      };

      // Só usa se números forem dignos — abaixo de 50 criadores parece fraco
      if (sp.creatorsActiveThisWeek < 50) {
        return undefined;
      }
      return sp;
    } catch (err: any) {
      this.logger.warn(`fetchSocialProof falhou: ${err.message}`);
      return undefined;
    }
  }

  /**
   * Busca o motivo da falha e dados de cartão direto no Stripe.
   * Tolerante a erro — retorna {null,null,null} se Stripe falhar.
   */
  private async fetchStripeContext(customerId: string | null): Promise<{
    declineCode: string | null;
    cardBrand: string | null;
    cardLast4: string | null;
  }> {
    const empty = { declineCode: null, cardBrand: null, cardLast4: null };
    if (!customerId) return empty;

    try {
      const charges = await this.stripeService.listCustomerCharges(customerId, 10);
      const lastFailed = charges.find((c) => c.status === 'failed');
      const declineCode = lastFailed
        ? (lastFailed.outcome?.reason || lastFailed.failure_code || null)
        : null;

      const card = await this.stripeService.getDefaultCard(customerId);

      return {
        declineCode,
        cardBrand: card?.brand || null,
        cardLast4: card?.last4 || null,
      };
    } catch (err: any) {
      this.logger.warn(`fetchStripeContext falhou pra customer ${customerId}: ${err.message}`);
      return empty;
    }
  }

  private daysSince(date: Date): number {
    return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
  }
}
