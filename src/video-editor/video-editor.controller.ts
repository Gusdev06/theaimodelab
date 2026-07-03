import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UsePipes,
  ValidationPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { VideoEditorService } from './video-editor.service';
import { CurrentUser } from '../common/decorators';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AddClipDto } from './dto/add-clip.dto';
import { UpdateClipDto } from './dto/update-clip.dto';
import { ReorderClipsDto } from './dto/reorder-clips.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('video-editor')
@ApiBearerAuth()
@Controller('api/v1/video-editor')
export class VideoEditorController {
  constructor(private readonly videoEditorService: VideoEditorService) {}

  @Post('projects')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Criar um novo projeto de video' })
  @ApiResponse({ status: 201, description: 'Projeto criado com sucesso' })
  async createProject(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateProjectDto,
  ) {
    return this.videoEditorService.createProject(userId, dto);
  }

  @Get('projects')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Listar projetos do usuario' })
  @ApiResponse({ status: 200, description: 'Projetos retornados com sucesso' })
  async listProjects(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.videoEditorService.listProjects(userId, pagination);
  }

  @Get('projects/:id')
  @ApiOperation({ summary: 'Obter projeto com clips' })
  @ApiResponse({ status: 200, description: 'Projeto retornado com sucesso' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async getProject(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
  ) {
    return this.videoEditorService.getProject(userId, projectId);
  }

  @Patch('projects/:id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Atualizar nome do projeto' })
  @ApiResponse({ status: 200, description: 'Projeto atualizado com sucesso' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async updateProject(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.videoEditorService.updateProject(userId, projectId, dto);
  }

  @Delete('projects/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Excluir projeto' })
  @ApiResponse({ status: 204, description: 'Projeto excluido com sucesso' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async deleteProject(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
  ) {
    return this.videoEditorService.deleteProject(userId, projectId);
  }

  @Post('projects/:id/clips')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Adicionar clip ao projeto' })
  @ApiResponse({ status: 201, description: 'Clip adicionado com sucesso' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async addClip(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
    @Body() dto: AddClipDto,
  ) {
    return this.videoEditorService.addClip(userId, projectId, dto);
  }

  @Patch('projects/:id/clips/:clipId')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Atualizar corte do clip' })
  @ApiResponse({ status: 200, description: 'Clip atualizado com sucesso' })
  @ApiResponse({ status: 404, description: 'Clip nao encontrado' })
  async updateClip(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
    @Param('clipId') clipId: string,
    @Body() dto: UpdateClipDto,
  ) {
    return this.videoEditorService.updateClip(userId, projectId, clipId, dto);
  }

  @Delete('projects/:id/clips/:clipId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remover clip do projeto' })
  @ApiResponse({ status: 204, description: 'Clip removido com sucesso' })
  @ApiResponse({ status: 404, description: 'Clip nao encontrado' })
  async deleteClip(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
    @Param('clipId') clipId: string,
  ) {
    return this.videoEditorService.deleteClip(userId, projectId, clipId);
  }

  @Post('projects/:id/reorder')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Reordenar clips do projeto' })
  @ApiResponse({ status: 200, description: 'Clips reordenados com sucesso' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async reorderClips(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
    @Body() dto: ReorderClipsDto,
  ) {
    return this.videoEditorService.reorderClips(userId, projectId, dto.clipIds);
  }

  @Post('projects/:id/render')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Iniciar renderizacao do projeto' })
  @ApiResponse({ status: 202, description: 'Renderizacao iniciada' })
  @ApiResponse({ status: 400, description: 'Projeto sem clips ou ja processando' })
  @ApiResponse({ status: 404, description: 'Projeto nao encontrado' })
  async render(
    @CurrentUser('sub') userId: string,
    @Param('id') projectId: string,
  ) {
    return this.videoEditorService.render(userId, projectId);
  }
}
