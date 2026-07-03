import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PromptPostsService } from './prompt-posts.service';
import { CreatePromptPostDto } from './dto/create-prompt-post.dto';
import { UpdatePromptPostDto } from './dto/update-prompt-post.dto';
import { TrackEventDto } from './dto/track-event.dto';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('prompt-posts')
@Controller('api/v1/prompt-posts')
export class PromptPostsPublicController {
  constructor(private readonly service: PromptPostsService) {}

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Retorna um post público por slug' })
  async findBySlug(@Param('slug') slug: string) {
    return this.service.findBySlug(slug);
  }

  @Public()
  @Post(':slug/track')
  @HttpCode(204)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Registra evento de view, copy ou use' })
  async track(@Param('slug') slug: string, @Body() dto: TrackEventDto) {
    await this.service.trackEvent(slug, dto.event, dto.slideIndex);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/prompt-posts')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class PromptPostsAdminController {
  constructor(private readonly service: PromptPostsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista todos os prompt posts (admin)' })
  async list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('published') published?: string,
  ) {
    return this.service.list({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      published:
        published === 'true' ? true : published === 'false' ? false : undefined,
    });
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Cria um novo prompt post' })
  async create(
    @Body() dto: CreatePromptPostDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.service.create(dto, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retorna um prompt post pelo id (admin)' })
  async findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Atualiza um prompt post' })
  async update(@Param('id') id: string, @Body() dto: UpdatePromptPostDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um prompt post' })
  async remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
