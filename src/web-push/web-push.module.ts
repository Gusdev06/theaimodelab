import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { WebPushController } from './web-push.controller';
import { WebPushService } from './web-push.service';

@Module({
  imports: [PrismaModule],
  controllers: [WebPushController],
  providers: [WebPushService],
  exports: [WebPushService],
})
export class WebPushModule {}
