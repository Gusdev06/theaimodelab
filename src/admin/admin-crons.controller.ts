import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminCronsService } from './admin-crons.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/crons')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminCronsController {
  constructor(private readonly service: AdminCronsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista todos os crons com último status + próxima execução' })
  async listCrons() {
    return this.service.listCrons();
  }

  @Get('executions')
  @ApiOperation({ summary: 'Histórico paginado de execuções (filtra por cronName / status)' })
  async getExecutions(
    @Query('cronName') cronName?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.getExecutions({
      cronName,
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
