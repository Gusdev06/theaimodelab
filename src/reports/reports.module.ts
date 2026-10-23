import { Module } from '@nestjs/common';
import { TakedownModule } from '../content-safety/takedown/takedown.module';
import { EmailModule } from '../email/email.module';
import { ReportsAdminController } from './reports-admin.controller';
import { ReportsController } from './reports.controller';
import { ReportsRateLimiter } from './reports-rate-limiter';
import { ReportsService } from './reports.service';
import { ReportsTakedownController } from './reports-takedown.controller';

@Module({
  imports: [EmailModule, TakedownModule],
  controllers: [ReportsController, ReportsAdminController, ReportsTakedownController],
  providers: [
    ReportsService,
    // um limitador por processo: 5 denúncias a cada 10 min por cliente (a urgente acima disso é gravada e vai no
    // resumo); por hora, 5.000 urgentes (proteção do banco), 120 comuns, 120 iscas e 30 avisos avulsos por e-mail
    { provide: ReportsRateLimiter, useFactory: () => new ReportsRateLimiter() },
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
