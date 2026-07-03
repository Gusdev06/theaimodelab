import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@ApiTags('workspaces')
@ApiBearerAuth()
@Controller('api/v1/workspaces')
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar workspaces do usuario (resumo, sem canvas)',
  })
  @ApiResponse({
    status: 200,
    description: 'Workspaces retornados com sucesso',
  })
  async list(@CurrentUser('sub') userId: string) {
    return this.workspacesService.list(userId);
  }

  @Post()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Criar um novo workspace' })
  @ApiResponse({ status: 201, description: 'Workspace criado com sucesso' })
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateWorkspaceDto,
  ) {
    return this.workspacesService.create(userId, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obter workspace com o conteudo do canvas' })
  @ApiResponse({ status: 200, description: 'Workspace retornado com sucesso' })
  @ApiResponse({ status: 404, description: 'Workspace nao encontrado' })
  async get(
    @CurrentUser('sub') userId: string,
    @Param('id') workspaceId: string,
  ) {
    return this.workspacesService.get(userId, workspaceId);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Atualizar workspace (autosave, rename, favorito)' })
  @ApiResponse({ status: 200, description: 'Workspace atualizado com sucesso' })
  @ApiResponse({ status: 404, description: 'Workspace nao encontrado' })
  async update(
    @CurrentUser('sub') userId: string,
    @Param('id') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspacesService.update(userId, workspaceId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Excluir workspace' })
  @ApiResponse({ status: 204, description: 'Workspace excluido com sucesso' })
  @ApiResponse({ status: 404, description: 'Workspace nao encontrado' })
  async remove(
    @CurrentUser('sub') userId: string,
    @Param('id') workspaceId: string,
  ) {
    return this.workspacesService.remove(userId, workspaceId);
  }
}
