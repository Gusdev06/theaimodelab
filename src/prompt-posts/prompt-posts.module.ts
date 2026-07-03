import { Module } from '@nestjs/common';
import {
  PromptPostsAdminController,
  PromptPostsPublicController,
} from './prompt-posts.controller';
import { PromptPostsService } from './prompt-posts.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PromptPostsPublicController, PromptPostsAdminController],
  providers: [PromptPostsService],
  exports: [PromptPostsService],
})
export class PromptPostsModule {}
