import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MarketingLeadsAdminController } from './marketing-leads-admin.controller';
import { MarketingLeadsController } from './marketing-leads.controller';
import { MarketingLeadsService } from './marketing-leads.service';

@Module({
  imports: [PrismaModule],
  controllers: [MarketingLeadsController, MarketingLeadsAdminController],
  providers: [MarketingLeadsService],
})
export class MarketingLeadsModule {}
