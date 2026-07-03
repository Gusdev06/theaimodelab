import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TheaimodelabChatClient } from '../prompt-enhancer/theaimodelab-chat.client';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { VisualAnalyzerService } from './visual-analyzer.service';

@Module({
  imports: [PrismaModule],
  controllers: [BrandsController],
  providers: [BrandsService, VisualAnalyzerService, TheaimodelabChatClient],
  exports: [BrandsService, VisualAnalyzerService],
})
export class BrandsModule {}
