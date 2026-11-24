import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PublicStatsController } from './public-stats.controller';
import { PublicStatsService } from './public-stats.service';

@Module({
  imports: [PrismaModule],
  controllers: [PublicStatsController],
  providers: [PublicStatsService],
})
export class PublicStatsModule {}
