import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UploadsModule } from '../uploads/uploads.module';
import { VoicesController } from './voices.controller';
import { VoicesService } from './voices.service';

@Module({
  imports: [PrismaModule, UploadsModule],
  controllers: [VoicesController],
  providers: [VoicesService],
  exports: [VoicesService],
})
export class VoicesModule {}
