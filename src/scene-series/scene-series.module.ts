import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import {
  AdminSceneSeriesController,
  SceneSeriesController,
} from './scene-series.controller';
import { SceneSeriesService } from './scene-series.service';

@Module({
  imports: [PrismaModule],
  controllers: [SceneSeriesController, AdminSceneSeriesController],
  providers: [SceneSeriesService],
  exports: [SceneSeriesService],
})
export class SceneSeriesModule {}
