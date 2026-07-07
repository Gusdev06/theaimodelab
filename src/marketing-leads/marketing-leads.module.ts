import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MarketingLeadsController } from './marketing-leads.controller';
import { MarketingLeadsService } from './marketing-leads.service';

@Module({
  imports: [PrismaModule],
  controllers: [MarketingLeadsController],
  providers: [MarketingLeadsService],
})
export class MarketingLeadsModule {}
