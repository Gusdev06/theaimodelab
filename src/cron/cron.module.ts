import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SubscriptionRenewalService } from './subscription-renewal.service';
import { GalleryCleanupService } from './gallery-cleanup.service';
import { StuckGenerationsService } from './stuck-generations.service';
import { PaymentRecoveryCampaignService } from './payment-recovery-campaign.service';
import { PixAutoBillingService } from './pix-auto-billing.service';
import { PerfectpaySubscriptionExpiryService } from './perfectpay-subscription-expiry.service';
import { OnboardingSequenceService } from './onboarding-sequence.service';
import { LifecycleEmailsService } from './lifecycle-emails.service';
import { CronLoggerService } from './cron-logger.service';
import { UploadsModule } from '../uploads/uploads.module';
import { EmailModule } from '../email/email.module';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [ScheduleModule.forRoot(), UploadsModule, EmailModule, PaymentsModule, PrismaModule, SettingsModule],
  providers: [
    CronLoggerService,
    SubscriptionRenewalService,
    GalleryCleanupService,
    StuckGenerationsService,
    PaymentRecoveryCampaignService,
    PixAutoBillingService,
    PerfectpaySubscriptionExpiryService,
    OnboardingSequenceService,
    LifecycleEmailsService,
  ],
  exports: [CronLoggerService],
})
export class CronModule {}
