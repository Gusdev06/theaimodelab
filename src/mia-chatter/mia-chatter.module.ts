import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MiaChatterController } from './mia-chatter.controller';
import { MiaChatterCron } from './mia-chatter.cron';
import { MiaChatterService } from './mia-chatter.service';

/** Mia Chatter (candy-chatter, L20): Fanvue OAuth + chat que vende o catálogo PPV. Atrás de MIA_CHATTER_ENABLED. */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [MiaChatterController],
  providers: [MiaChatterService, MiaChatterCron],
  exports: [MiaChatterService],
})
export class MiaChatterModule {}
