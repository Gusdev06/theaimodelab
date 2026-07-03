import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommunityController } from './community.controller';
import { CommunityAdminController } from './community-admin.controller';
import { CommunityService } from './community.service';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [CommunityController, CommunityAdminController],
  providers: [CommunityService],
})
export class CommunityModule {}
