import { Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RewardsService } from './rewards.service';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';

@ApiTags('rewards')
@ApiBearerAuth()
@Controller('api/v1/rewards')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @Get('weekly-claim')
  @ApiOperation({ summary: 'Status do resgate semanal de gerações Veo 3.1 Fast' })
  async getStatus(@CurrentUser() user: JwtPayload) {
    return this.rewardsService.getWeeklyClaimStatus(user.sub);
  }

  @Post('weekly-claim')
  @ApiOperation({ summary: 'Resgata o bônus semanal (somente quartas, BRT)' })
  async claim(@CurrentUser() user: JwtPayload) {
    return this.rewardsService.claimWeekly(user.sub);
  }
}
