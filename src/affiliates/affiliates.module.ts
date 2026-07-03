import { Module } from '@nestjs/common';
import { AffiliatesController } from './affiliates.controller';
import { AffiliateMeController } from './affiliate-me.controller';
import { AffiliatesService } from './affiliates.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [PrismaModule, PaymentsModule, EmailModule],
  controllers: [AffiliatesController, AffiliateMeController],
  providers: [AffiliatesService],
  exports: [AffiliatesService],
})
export class AffiliatesModule {}
