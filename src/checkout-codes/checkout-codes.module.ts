import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CheckoutCodesController } from './checkout-codes.controller';
import { CheckoutCodesService } from './checkout-codes.service';

@Module({
  imports: [PrismaModule],
  controllers: [CheckoutCodesController],
  providers: [CheckoutCodesService],
  exports: [CheckoutCodesService],
})
export class CheckoutCodesModule {}
