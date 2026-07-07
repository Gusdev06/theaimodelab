import { Module } from '@nestjs/common';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PlansModule } from '../plans/plans.module';
import { PaymentsModule } from '../payments/payments.module';
import { MetaModule } from '../meta/meta.module';

@Module({
  imports: [PrismaModule, PlansModule, PaymentsModule, MetaModule],
  controllers: [CreditsController],
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
