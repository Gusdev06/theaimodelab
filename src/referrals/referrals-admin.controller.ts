import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ListReferralsQueryDto } from './dto/list-referrals.query';
import { UpdateReferralSettingsDto } from './dto/update-referral-settings.dto';
import { ReferralsService } from './referrals.service';

@ApiTags('referrals')
@ApiBearerAuth()
@Controller('api/v1/admin/referrals')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ReferralsAdminController {
  constructor(private readonly referralsService: ReferralsService) {}

  @Get()
  @ApiOperation({ summary: 'Indicações (filtro por status; padrão: todas, mais novas primeiro)' })
  async list(@Query() query: ListReferralsQueryDto) {
    return this.referralsService.listForAdmin(query.status, query.take ?? 50);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Totais da indicação: por status, créditos pagos, revisão parada e configuração' })
  async stats() {
    return this.referralsService.adminStats();
  }

  @Get('settings')
  @ApiOperation({ summary: 'Valor por indicação e tetos em vigor' })
  async settings() {
    return this.referralsService.getSettings();
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Muda valor e tetos sem deploy (rewardCredits 0 desliga a indicação)' })
  async updateSettings(@Body() dto: UpdateReferralSettingsDto) {
    return this.referralsService.updateSettings(dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Libera indicação em revisão ou bloqueada (paga se o indicado já cumpriu)' })
  async approve(@Param('id') id: string, @CurrentUser() admin: JwtPayload) {
    return this.referralsService.approve(id, admin.sub);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recusa indicação pendente ou em revisão' })
  async reject(@Param('id') id: string, @CurrentUser() admin: JwtPayload) {
    return this.referralsService.reject(id, admin.sub);
  }
}
