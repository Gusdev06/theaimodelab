import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Put,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminThrottle } from '../common/decorators/admin-throttle.decorator';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { SceneSeriesService } from './scene-series.service';
import { UpsertSceneSeriesDto } from './dto/upsert-scene-series.dto';
import type { PublicSeriesResponse } from './scene-series.logic';

type MaybeUserRequest = {
  user?: { sub?: string; role?: string } | false | null;
};

/** Séries com cadeado nos Reels (candy-series). Desligado (SCENE_SERIES_ENABLED ausente/off) = vazio e 404. */
@ApiTags('scene-series')
@Controller('api/v1/scene-series')
export class SceneSeriesController {
  constructor(private readonly sceneSeries: SceneSeriesService) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  // a resposta muda por conta (assinante vê tudo): nunca em cache compartilhado
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      'Séries do acervo: ep. 1 e 2 abertos, o resto com cadeado para quem não assina',
  })
  async list(@Req() req: MaybeUserRequest): Promise<PublicSeriesResponse> {
    const user = req.user || null;
    return this.sceneSeries.listPublic({
      userId: user?.sub ?? null,
      role: user?.role ?? null,
    });
  }

  @Public()
  // um pedido por card trancado na tela; o trabalho é limitado pelo cache (conjunto fechado pelo catálogo)
  @Throttle({ default: { ttl: 60_000, limit: 240 } })
  @Get(':seriesId/episodes/:episodeNumber/teaser')
  @Header('Cache-Control', 'public, max-age=86400')
  @ApiOperation({ summary: '1º quadro borrado do episódio trancado (JPEG)' })
  async teaser(
    @Param('seriesId') seriesId: string,
    @Param('episodeNumber', ParseIntPipe) episodeNumber: number,
  ): Promise<StreamableFile> {
    const image = await this.sceneSeries.teaser(seriesId, episodeNumber);
    return new StreamableFile(image, {
      type: 'image/jpeg',
      length: image.length,
    });
  }
}

/** Montagem das séries pelo dono (só ADMIN). Funciona com a flag desligada, para a série ficar pronta antes de ligar. */
@ApiTags('admin')
@ApiBearerAuth()
@AdminThrottle()
@Controller('api/v1/admin/scene-series')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminSceneSeriesController {
  constructor(private readonly sceneSeries: SceneSeriesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Catálogo de séries com as cenas resolvidas (tranca, ativa na parede, apagada)',
  })
  async list() {
    return this.sceneSeries.adminList();
  }

  @Put(':seriesId')
  @ApiOperation({
    summary: 'Cria ou troca uma série (3 a 12 cenas do acervo, na ordem)',
  })
  async upsert(
    @Param('seriesId') seriesId: string,
    @Body() dto: UpsertSceneSeriesDto,
  ) {
    const { lockInLibrary, ...input } = dto;
    return this.sceneSeries.adminUpsert(seriesId, input, { lockInLibrary });
  }

  @Delete(':seriesId')
  @ApiOperation({
    summary: 'Apaga a série (as cenas do acervo ficam como estão)',
  })
  async remove(@Param('seriesId') seriesId: string) {
    return this.sceneSeries.adminRemove(seriesId);
  }
}
