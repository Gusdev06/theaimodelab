import { Module } from '@nestjs/common';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { DailyCreditsService } from './daily-credits.service';
import { FreeFixService } from './free-fix.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PlansModule } from '../plans/plans.module';
import { PaymentsModule } from '../payments/payments.module';
import { MetaModule } from '../meta/meta.module';
import { CheckoutCodesModule } from '../checkout-codes/checkout-codes.module';

@Module({
  imports: [PrismaModule, PlansModule, PaymentsModule, MetaModule, CheckoutCodesModule],
  controllers: [CreditsController],
  providers: [CreditsService, DailyCreditsService, FreeFixService],
  exports: [CreditsService, DailyCreditsService, FreeFixService],
})
export class CreditsModule {}
