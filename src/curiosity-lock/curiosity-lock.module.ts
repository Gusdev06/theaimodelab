import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { CuriosityLockController } from './curiosity-lock.controller';
import { CuriosityLockService } from './curiosity-lock.service';

@Module({
  imports: [PrismaModule],
  controllers: [CuriosityLockController],
  providers: [CuriosityLockService],
})
export class CuriosityLockModule {}
