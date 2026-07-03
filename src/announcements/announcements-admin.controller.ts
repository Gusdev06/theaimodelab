import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AnnouncementsService } from './announcements.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/announcements')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AnnouncementsAdminController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista todos os avisos (incluindo inativos)' })
  async list() {
    return this.announcementsService.listAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhes de um aviso' })
  async get(@Param('id') id: string) {
    return this.announcementsService.getById(id);
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Cria um novo aviso' })
  async create(@Body() dto: CreateAnnouncementDto) {
    return this.announcementsService.create(dto);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Edita um aviso (slug não é editável)' })
  async update(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.announcementsService.update(id, dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Alterna o status ativo/inativo' })
  async toggle(@Param('id') id: string) {
    return this.announcementsService.toggle(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um aviso' })
  async delete(@Param('id') id: string) {
    await this.announcementsService.delete(id);
    return { success: true };
  }
}
