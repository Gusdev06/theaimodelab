import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminStripeController } from './stripe/admin-stripe.controller';
import { AdminStripeService } from './stripe/admin-stripe.service';
import { AdminUnlimitedController } from './admin-unlimited.controller';
import { AdminUnlimitedService } from './admin-unlimited.service';
import { AdminCronsController } from './admin-crons.controller';
import { AdminCronsService } from './admin-crons.service';
import { AdminVertexController } from './admin-vertex.controller';
import { AdminVertexService } from './admin-vertex.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UploadsModule } from '../uploads/uploads.module';
import { ModelsModule } from '../models/models.module';
import { GENERATION_UNLIMITED_QUEUE } from '../generations/queue/generation-queue.constants';

@Module({
  imports: [
    PrismaModule,
    UploadsModule,
    ModelsModule,
    BullModule.registerQueue({ name: GENERATION_UNLIMITED_QUEUE }),
  ],
  controllers: [AdminController, AdminStripeController, AdminUnlimitedController, AdminCronsController, AdminVertexController],
  providers: [AdminService, AdminStripeService, AdminUnlimitedService, AdminCronsService, AdminVertexService],
})
export class AdminModule {}
