import {
  BadRequestException, Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Query, UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContentReportStatus } from '@prisma/client';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpdateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/reports')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ReportsAdminController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista as denúncias de conteúdo, abertas primeiro (admin)' })
  async list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    if (status && !(status in ContentReportStatus)) throw new BadRequestException('status inválido');
    return this.reports.listForAdmin(page, limit, status as ContentReportStatus | undefined);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Muda o andamento de uma denúncia (em análise, removido, descartado) (admin)' })
  async update(@Param('id') id: string, @Body() dto: UpdateReportDto, @CurrentUser() admin: JwtPayload) {
    return this.reports.update(id, dto, admin.email);
  }
}
