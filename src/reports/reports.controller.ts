import { Body, Controller, HttpCode, Post, Req, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

/**
 * Canal público de denúncia: qualquer pessoa (inclusive quem aparece num conteúdo e não tem conta) denuncia sem
 * login. Limitado por IP (o throttler global já conta por IP; aqui 5 a cada 10 minutos).
 */
@ApiTags('reports')
@Controller('api/v1/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Public()
  @Post()
  @HttpCode(201)
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Denuncia um conteúdo (menor, imagem íntima sem consentimento, uso de imagem, direito autoral)' })
  async create(
    @Body() dto: CreateReportDto,
    @Req() req: { ip?: string; headers?: Record<string, string | string[] | undefined>; user?: { sub?: string } },
  ) {
    const forwarded = req.headers?.['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || req.ip || null;
    const result = await this.reports.create(dto, { ip, userId: req.user?.sub ?? null });
    return { ok: true, id: result.id, message: 'Denúncia recebida. A equipe analisa e responde pelo e-mail informado.' };
  }
}
