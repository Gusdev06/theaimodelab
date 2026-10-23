import {
  BadRequestException, Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards, UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SafetyReviewerGuard } from '../content-safety/reviewer/safety-reviewer.guard';
import { TakedownService } from '../content-safety/takedown/takedown.service';
import { ExecuteTakedownDto } from './dto/takedown.dto';
import { auditClientIp } from '../access-log/access-log.config';
import type { ReportRequest } from './reports.controller';
import { ReportsService, TAKEDOWN_QUEUE_STATES, type TakedownQueueState } from './reports.service';

/**
 * Remoção pedida pela própria pessoa retratada ("sou a pessoa da imagem", TAKE IT DOWN, 48 h) e remoção de qualquer
 * denúncia confirmada. A fila traz o relógio do prazo (takedown: dueAt, remainingMs, state) para o cockpit; a remoção
 * tira os arquivos do público (apaga, ou leva para a evidência quando há guarda legal), põe o hash na lista de
 * bloqueio, purga o CDN e grava quem, quando e por quê em content_safety_access_log.
 *
 * A fila (só texto e prazos, como /admin/reports) é do ADMIN; mexer no conteúdo (remover, ver os arquivos de uma
 * remoção) é do revisor designado (SafetyReviewerGuard: ADMIN + SAFETY_REVIEWER_IDS).
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/takedowns')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ReportsTakedownController {
  constructor(
    private readonly reports: ReportsService,
    private readonly takedown: TakedownService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Fila das remoções pedidas pela vítima (prazo de 48 h): state=open (padrão, prazo mais próximo primeiro) | overdue | done | all. Cada denúncia traz takedown { dueAt, doneAt, remainingMs, state }; counts traz abertas, vencidas, vencendo em 6 h e purgas do CDN pendentes (admin)',
  })
  async queue(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('state') state?: string,
  ) {
    if (state && !TAKEDOWN_QUEUE_STATES.includes(state as TakedownQueueState)) {
      throw new BadRequestException('state inválido (open, overdue, done ou all)');
    }
    return this.reports.takedownQueue((state as TakedownQueueState | undefined) ?? 'open', page, limit);
  }

  @Get('reports/:reportId')
  @UseGuards(SafetyReviewerGuard)
  @ApiOperation({ summary: 'Arquivos já tirados do ar por uma denúncia: destino (apagado ou evidência), purga do CDN e o relógio do prazo (revisor)' })
  async items(@Param('reportId') reportId: string) {
    return this.takedown.listItems(reportId);
  }

  @Post('reports/:reportId')
  @UseGuards(SafetyReviewerGuard)
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
  @ApiOperation({
    summary:
      'Confirma a denúncia e remove as gerações (as citadas nela ou generationIds): arquivos fora do público (evidência quando há guarda legal), hash na lista de bloqueio, cópias idênticas junto, parecidas em nearCopies, post fora do ar, purga do CDN (pendente sem CLOUDFLARE_PURGE_TOKEN/CLOUDFLARE_ZONE_ID). complete=false quando algum arquivo falhou (repetir). 409 TAKEDOWN_EVIDENCE_STORAGE_MISSING sem bucket de evidência para conteúdo sob guarda (revisor)',
  })
  async execute(
    @Param('reportId') reportId: string,
    @Body() dto: ExecuteTakedownDto,
    @CurrentUser() admin: JwtPayload,
    @Req() req: ReportRequest,
  ) {
    return this.takedown.execute({
      reportId,
      generationIds: dto.generationIds,
      reason: dto.reason,
      preserveEvidence: dto.preserveEvidence,
      actor: { id: admin.sub, email: admin.email },
      ip: auditClientIp(req),
    });
  }
}
