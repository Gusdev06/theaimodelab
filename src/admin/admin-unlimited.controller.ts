import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  AdminUnlimitedService,
  UnlimitedJobStatusFilter,
} from './admin-unlimited.service';

const ALLOWED_STATUS: UnlimitedJobStatusFilter[] = [
  'waiting',
  'active',
  'delayed',
  'completed',
  'failed',
  'paused',
];

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/unlimited')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminUnlimitedController {
  constructor(private readonly service: AdminUnlimitedService) {}

  @Get('queue/stats')
  @ApiOperation({
    summary: 'Stats da fila ilimitada (waiting, active, delayed, completed, failed)',
  })
  async queueStats() {
    return this.service.getQueueStats();
  }

  @Get('queue/jobs')
  @ApiOperation({
    summary:
      'Lista jobs da fila ilimitada filtrados por status, com user/generation enriquecidos',
  })
  async queueJobs(
    @Query('status') status: string = 'waiting',
    @Query('limit') limit?: string,
  ) {
    if (!ALLOWED_STATUS.includes(status as UnlimitedJobStatusFilter)) {
      throw new BadRequestException(
        `status inválido. Use um destes: ${ALLOWED_STATUS.join(', ')}`,
      );
    }
    return this.service.listJobs({
      status: status as UnlimitedJobStatusFilter,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Get('usage/overview')
  @ApiOperation({
    summary:
      'Uso do modo ilimitado nas últimas 24h (total, breakdown por modelo, top usuários)',
  })
  async usageOverview() {
    return this.service.getUsageOverview();
  }

  // ── Manual delay por usuário ─────────────────────────────────

  @Get('users/:userId/manual-delay')
  @ApiOperation({ summary: 'Consulta delay manual ativo do usuário' })
  async getManualDelay(@Param('userId') userId: string) {
    return this.service.getManualDelay(userId);
  }

  @Post('users/:userId/manual-delay')
  @ApiOperation({
    summary:
      'Define delay manual em segundos para o usuário, com TTL em minutos. Soma com o delay da curva.',
  })
  async setManualDelay(
    @Param('userId') userId: string,
    @Body() body: { delaySeconds: number; ttlMinutes: number },
  ) {
    if (
      typeof body?.delaySeconds !== 'number' ||
      typeof body?.ttlMinutes !== 'number' ||
      body.delaySeconds < 0 ||
      body.ttlMinutes <= 0
    ) {
      throw new BadRequestException(
        'delaySeconds (>=0) e ttlMinutes (>0) são obrigatórios e numéricos',
      );
    }
    return this.service.setManualDelay(userId, body.delaySeconds, body.ttlMinutes);
  }

  @Delete('users/:userId/manual-delay')
  @ApiOperation({ summary: 'Remove o delay manual do usuário (volta ao normal)' })
  async clearManualDelay(@Param('userId') userId: string) {
    return this.service.clearManualDelay(userId);
  }
}
