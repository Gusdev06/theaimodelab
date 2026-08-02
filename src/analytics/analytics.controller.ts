import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { AnalyticsService } from './analytics.service';
import { CreateAnalyticsEventDto } from './dto/create-analytics-event.dto';

@ApiTags('analytics')
@Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Ingestão de eventos de analytics de produto (paywall, etc.).
   *
   * Auth OPCIONAL: `@Public()` faz o JwtAuthGuard global liberar; o
   * OptionalJwtAuthGuard tenta validar o Bearer e popula `req.user` quando válido
   * (sem token → segue anônimo). `whitelist` NÃO é usado no ValidationPipe para
   * preservar campos extras do payload (o limite de tamanho é aplicado no
   * service). Coberto pelo throttler global; `@Throttle` aperta ainda mais.
   */
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Post('events')
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @UsePipes(new ValidationPipe({ transform: true }))
  @ApiOperation({ summary: 'Registra um evento de analytics (auth opcional)' })
  @ApiResponse({ status: 204, description: 'Evento registrado' })
  async createEvent(
    @Body() dto: CreateAnalyticsEventDto,
    @Req() req: { user?: { sub?: string } },
  ): Promise<void> {
    await this.analyticsService.record(dto, req.user?.sub ?? null);
  }
}
