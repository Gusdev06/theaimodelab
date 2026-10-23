import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';
import { UploadsModule } from '../uploads/uploads.module';
import { AvatarsModule } from '../avatars/avatars.module';
import { AccountErasureAdminController } from './account-erasure.controller';
import { AccountErasureService } from './account-erasure.service';

@Module({
  // Payments (Stripe, Cakto, Asaas), Uploads (bucket) e Avatars (HeyGen): a exclusão de conta (LGPD) fala com eles
  imports: [PrismaModule, PaymentsModule, UploadsModule, AvatarsModule],
  controllers: [UsersController, AccountErasureAdminController],
  providers: [UsersService, AccountErasureService],
  exports: [UsersService, AccountErasureService],
})
export class UsersModule {}
