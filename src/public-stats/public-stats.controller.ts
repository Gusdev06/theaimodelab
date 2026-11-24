import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators';
import { PublicStatsService, type PublicStatsResponse } from './public-stats.service';

@ApiTags('public')
@Controller('api/v1/public')
export class PublicStatsController {
  constructor(private readonly publicStats: PublicStatsService) {}

  /** Contas, fotos/vídeos e criadoras pagantes, arredondados para baixo (L14). Cache de 1 h. */
  @Public()
  @Get('stats')
  @Header('Cache-Control', 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=600')
  @ApiOperation({ summary: 'Números reais da plataforma (prova social), arredondados para baixo' })
  @ApiResponse({ status: 200, description: '{ enabled, accounts, generations, payingCreators, updatedAt }' })
  async stats(): Promise<PublicStatsResponse> {
    return this.publicStats.get();
  }
}
