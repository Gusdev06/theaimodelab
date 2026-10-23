import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ListReferralsQueryDto } from './dto/list-referrals.query';
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
  @ApiOperation({ summary: 'Totais da indicação: por status e créditos pagos' })
  async stats() {
    return this.referralsService.adminStats();
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
