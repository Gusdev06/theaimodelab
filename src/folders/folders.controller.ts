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
import { FoldersService } from './folders.service';
import { CurrentUser } from '../common/decorators';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { AddGenerationsToFolderDto } from './dto/add-generations-to-folder.dto';
import { RemoveGenerationsFromFolderDto } from './dto/remove-generations-from-folder.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@ApiTags('folders')
@ApiBearerAuth()
@Controller('api/v1/folders')
export class FoldersController {
  constructor(private readonly foldersService: FoldersService) {}

  @Post()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Criar uma nova pasta' })
  @ApiResponse({ status: 201, description: 'Pasta criada com sucesso' })
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateFolderDto,
  ) {
    return this.foldersService.create(userId, dto);
  }

  @Get()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Listar pastas do usuario' })
  @ApiResponse({ status: 200, description: 'Pastas retornadas com sucesso' })
  async findAll(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.foldersService.findAll(userId, pagination);
  }

  @Get(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Obter pasta com geracoes paginadas' })
  @ApiResponse({ status: 200, description: 'Pasta retornada com sucesso' })
  @ApiResponse({ status: 404, description: 'Pasta nao encontrada' })
  async findOne(
    @CurrentUser('sub') userId: string,
    @Param('id') folderId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.foldersService.findOne(userId, folderId, pagination);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Atualizar pasta' })
  @ApiResponse({ status: 200, description: 'Pasta atualizada com sucesso' })
  @ApiResponse({ status: 404, description: 'Pasta nao encontrada' })
  async update(
    @CurrentUser('sub') userId: string,
    @Param('id') folderId: string,
    @Body() dto: UpdateFolderDto,
  ) {
    return this.foldersService.update(userId, folderId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Excluir pasta' })
  @ApiResponse({ status: 204, description: 'Pasta excluida com sucesso' })
  @ApiResponse({ status: 404, description: 'Pasta nao encontrada' })
  async remove(
    @CurrentUser('sub') userId: string,
    @Param('id') folderId: string,
  ) {
    return this.foldersService.remove(userId, folderId);
  }

  @Post(':id/generations')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Adicionar geracoes a uma pasta' })
  @ApiResponse({ status: 201, description: 'Geracoes adicionadas com sucesso' })
  @ApiResponse({ status: 404, description: 'Pasta nao encontrada' })
  async addGenerations(
    @CurrentUser('sub') userId: string,
    @Param('id') folderId: string,
    @Body() dto: AddGenerationsToFolderDto,
  ) {
    return this.foldersService.addGenerations(
      userId,
      folderId,
      dto.generationIds,
    );
  }

  @Delete(':id/generations')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Remover geracoes de uma pasta' })
  @ApiResponse({ status: 200, description: 'Geracoes removidas com sucesso' })
  @ApiResponse({ status: 404, description: 'Pasta nao encontrada' })
  async removeGenerations(
    @CurrentUser('sub') userId: string,
    @Param('id') folderId: string,
    @Body() dto: RemoveGenerationsFromFolderDto,
  ) {
    return this.foldersService.removeGenerations(
      userId,
      folderId,
      dto.generationIds,
    );
  }
}
