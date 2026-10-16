import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { ReportsAdminController } from './reports-admin.controller';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [EmailModule],
  controllers: [ReportsController, ReportsAdminController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
