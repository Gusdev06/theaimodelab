import { Module } from '@nestjs/common';
import { InworldVoicesController } from './inworld-voices.controller';
import { InworldVoicesService } from './inworld-voices.service';

@Module({
  controllers: [InworldVoicesController],
  providers: [InworldVoicesService],
  exports: [InworldVoicesService],
})
export class InworldVoicesModule {}
