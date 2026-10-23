import {
  BadRequestException, Body, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, Patch, Query, Req, UseGuards, UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContentReportStatus } from '@prisma/client';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpdateReportDto } from './dto/create-report.dto';
import { auditClientIp } from '../access-log/access-log.config';
import type { ReportRequest } from './reports.controller';
import { REPORTS_SORTS, ReportsService, ReportsSort } from './reports.service';

/**
 * Denúncias no admin. Cada denúncia vem com `citesMinor` (descrição ou alvo cita menor, a mesma conferência da
 * urgência) e `urgentReasons` ('category' | 'depicted_person' | 'cites_minor'): o cockpit decide por eles se a
 * denúncia fura o mudo. `evidenceReleasedAt` diz se a evidência já foi liberada (a denúncia deixou de segurar a
 * exclusão LGPD da conta denunciada).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/reports')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ReportsAdminController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Lista as denúncias de conteúdo, abertas primeiro; sort=newest (padrão) ou oldest dentro de cada status. Traz open, urgentOpen e, em cada denúncia, citesMinor e urgentReasons (admin)',
  })
  async list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('sort') sort?: string,
  ) {
    if (status && !Object.prototype.hasOwnProperty.call(ContentReportStatus, status)) {
      throw new BadRequestException('status inválido');
    }
    if (sort && !REPORTS_SORTS.includes(sort as ReportsSort)) throw new BadRequestException('sort inválido (newest ou oldest)');
    return this.reports.listForAdmin(page, limit, status as ContentReportStatus | undefined, (sort as ReportsSort | undefined) ?? 'newest');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Uma denúncia de conteúdo, com citesMinor, urgentReasons e evidenceReleasedAt (admin)' })
  async detail(@Param('id') id: string) {
    return this.reports.getForAdmin(id);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Muda o andamento de uma denúncia (em análise, removido, descartado), a nota e libera a evidência (evidenceReleased: true, só com a denúncia removida/ACTIONED; troca de status desfaz a liberação; 409 se outro admin mudou a denúncia no meio). Fica no registro de acesso. Com a revisão de segurança em uso (checagem ligada ou SAFETY_REVIEWER_IDS preenchido), descartar ou liberar a evidência de denúncia que segura evidência (menor, crime, imagem íntima, pessoa retratada) é só do revisor designado (403 para o resto). Marcar removido aqui não tira arquivo do ar: a remoção é POST /api/v1/admin/takedowns/reports/:id (admin)',
  })
  async update(@Param('id') id: string, @Body() dto: UpdateReportDto, @CurrentUser() admin: JwtPayload, @Req() req?: ReportRequest) {
    // IP da trilha pela regra do registro de acesso (com proxy declarado, o x-forwarded-for não é forjável)
    return this.reports.update(id, dto, { id: admin.sub, email: admin.email, ip: req ? auditClientIp(req) : undefined });
  }
}
