import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators';
import { CuriosityLockService, type CuriosityLockStatus } from './curiosity-lock.service';

@ApiTags('growth')
@ApiBearerAuth()
@Controller('api/v1/growth')
export class CuriosityLockController {
  constructor(private readonly curiosityLock: CuriosityLockService) {}

  /** Paywall de curiosidade (L02): a conta está no 1º resultado e nunca pagou? Só leitura. */
  @Get('curiosity-lock')
  @ApiOperation({ summary: 'Elegibilidade do card de mídia trancada após o 1º resultado' })
  @ApiResponse({ status: 200, description: '{ eligible, completedGenerations, abBucket, variant, mediaUrl }' })
  async status(@CurrentUser('sub') userId: string): Promise<CuriosityLockStatus> {
    return this.curiosityLock.statusFor(userId);
  }
}
