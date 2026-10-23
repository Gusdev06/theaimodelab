import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UploadsModule } from '../uploads/uploads.module';
import { CommunityController } from './community.controller';
import { CommunityAdminController } from './community-admin.controller';
import { CommunityService } from './community.service';

@Module({
  // UploadsModule: só mídia do bucket público vira post (saída promovida)
  imports: [PrismaModule, NotificationsModule, UploadsModule],
  controllers: [CommunityController, CommunityAdminController],
  providers: [CommunityService],
})
export class CommunityModule {}
