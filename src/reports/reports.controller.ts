import { Body, Controller, HttpCode, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { CreateReportDto } from './dto/create-report.dto';
import { ReportsService } from './reports.service';

export interface ReportRequest {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  /** preenchido pelo OptionalJwtAuthGuard só com Bearer válido; sem token, ou com token inválido/vencido, fica vazio */
  user?: { sub?: string } | false | null;
}

/**
 * Quem denuncia, para o limite por cliente e o hash do IP: o 1º IP do x-forwarded-for, senão o req.ip.
 *
 * Por que confiar no 1º salto: a API fica atrás do rewrite da Vercel, que reescreve o x-forwarded-for com o IP real
 * do visitante; o req.ip é sempre o do proxy (um "cliente" só para o mundo inteiro). Quem chama o VPS direto, sem
 * passar pela Vercel, escreve o que quiser nesse cabeçalho: por isso o limite por cliente é só o freio do visitante
 * comum, e quem segura a enxurrada com IP inventado são os tetos globais por faixa (ReportsRateLimiter).
 */
export function reportClientIp(req: ReportRequest): string | null {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.ip || null;
}

/**
 * Canal público de denúncia: qualquer pessoa (inclusive quem aparece num conteúdo e não tem conta) denuncia sem
 * login. Logada, a denúncia leva a conta (reporterUserId): o OptionalJwtAuthGuard valida o Bearer com a mesma chave
 * e a mesma estratégia do resto da API, e token inválido ou vencido segue como anônimo (nunca 401: denúncia não pode
 * ser recusada por sessão velha). Fora do throttler global de propósito: atrás da Vercel o req.ip é o do proxy, e o
 * limite dele virava um limite único para todo mundo. O limite fica no ReportsService: 5 a cada 10 minutos por
 * cliente (a denúncia urgente acima disso é gravada assim mesmo) e tetos globais por hora separados para comuns
 * (120), isca de robô (120) e urgentes (5.000, só a proteção do banco; a recusa indica o e-mail de denúncia)
 * (429 REPORTS_RATE_LIMITED).
 */
@ApiTags('reports')
@Controller('api/v1/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Post()
  @HttpCode(201)
  @SkipThrottle()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Denuncia um conteúdo (menor, imagem íntima sem consentimento, uso de imagem, direito autoral)' })
  async create(@Body() dto: CreateReportDto, @Req() req: ReportRequest) {
    const userId = req.user && typeof req.user.sub === 'string' && req.user.sub ? req.user.sub : null;
    const result = await this.reports.create(dto, { ip: reportClientIp(req), userId });
    return { ok: true, id: result.id, message: 'Denúncia recebida. A equipe analisa e responde pelo e-mail informado.' };
  }
}
