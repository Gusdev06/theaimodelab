import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AnnouncementsService } from './announcements.service';

@ApiTags('announcements')
@ApiBearerAuth()
@Controller('api/v1/announcements')
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Get('active')
  @ApiOperation({ summary: 'Lista avisos ativos para exibir aos usuários' })
  @ApiQuery({ name: 'locale', required: false, enum: ['pt-BR', 'en', 'es'] })
  async listActive(@Query('locale') locale?: string) {
    return this.announcementsService.listActive(locale);
  }
}
