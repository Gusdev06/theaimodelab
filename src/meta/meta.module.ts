import { Module } from '@nestjs/common';
import { MetaController } from './meta.controller';
import { MetaConversionsService } from './meta-conversions.service';

@Module({
  controllers: [MetaController],
  providers: [MetaConversionsService],
  exports: [MetaConversionsService],
})
export class MetaModule {}
