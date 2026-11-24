import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RetencaoController } from './retencao.controller';
import { RetencaoService } from './retencao.service';
import { ModelWaitingService } from './model-waiting.service';
import { RenewalReminderService } from './renewal-reminder.service';

/**
 * Pacote candy-retencao (24/11/2026): "sua modelo está esperando" (L10), lembrete antes de renovar (L17) e os dados
 * do cartão de fidelidade do Pack (L27). Tudo desligado por padrão (retencao-flags.ts). O ScheduleModule já é
 * registrado pelo CronModule.
 */
@Module({
  imports: [PrismaModule, EmailModule, NotificationsModule],
  controllers: [RetencaoController],
  providers: [RetencaoService, ModelWaitingService, RenewalReminderService],
})
export class RetencaoModule {}
