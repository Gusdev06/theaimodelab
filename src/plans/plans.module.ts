import { Module } from '@nestjs/common';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CheckoutCodesModule } from '../checkout-codes/checkout-codes.module';

@Module({
  imports: [PrismaModule, CheckoutCodesModule],
  controllers: [PlansController],
  providers: [PlansService],
  exports: [PlansService],
})
export class PlansModule {}
