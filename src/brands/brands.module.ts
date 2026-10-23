import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UploadsModule } from '../uploads/uploads.module';
import { ExternalMediaCheck } from '../content-safety/image-safety/external-media-check';
import { TheaimodelabChatClient } from '../prompt-enhancer/theaimodelab-chat.client';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { VisualAnalyzerService } from './visual-analyzer.service';

@Module({
  imports: [PrismaModule, UploadsModule],
  controllers: [BrandsController],
  providers: [
    BrandsService,
    VisualAnalyzerService,
    TheaimodelabChatClient,
    ExternalMediaCheck,
  ],
  exports: [BrandsService, VisualAnalyzerService],
})
export class BrandsModule {}
