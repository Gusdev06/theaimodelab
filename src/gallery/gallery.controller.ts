import {
  Controller,
  Get,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { GalleryService } from './gallery.service';
import { CurrentUser } from '../common/decorators';
import { GalleryFiltersDto } from './dto/gallery-filters.dto';
import { GalleryStatsResponseDto } from './dto/gallery-stats-response.dto';

@ApiTags('gallery')
@ApiBearerAuth()
@Controller('api/v1/gallery')
export class GalleryController {
  constructor(private readonly galleryService: GalleryService) {}

  @Get()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Lista gerações completadas (galeria)' })
  @ApiResponse({ status: 200, description: 'Galeria retornada com sucesso' })
  async getGallery(
    @CurrentUser('sub') userId: string,
    @Query() filters: GalleryFiltersDto,
  ) {
    return this.galleryService.getGallery(userId, filters);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Estatísticas da galeria do usuário' })
  @ApiResponse({
    status: 200,
    description: 'Estatísticas retornadas com sucesso',
    type: GalleryStatsResponseDto,
  })
  async getStats(
    @CurrentUser('sub') userId: string,
  ): Promise<GalleryStatsResponseDto> {
    return this.galleryService.getStats(userId);
  }
}
