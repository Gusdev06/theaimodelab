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
  Query,
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
import { PaginationDto } from '../common/dto/pagination.dto';
import { BrandsService } from './brands.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@ApiTags('brands')
@ApiBearerAuth()
@Controller('api/v1/brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Post()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Cria marca. Se houver references, dispara Visual Analyzer (sincrono).',
  })
  @ApiResponse({ status: 201, description: 'Marca criada' })
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateBrandDto,
  ) {
    return this.brandsService.create(userId, dto);
  }

  @Get()
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Lista marcas do usuario (paginado)' })
  async findAll(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.brandsService.findAll(userId, pagination);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe da marca' })
  @ApiResponse({ status: 404, description: 'Marca nao encontrada' })
  async findOne(
    @CurrentUser('sub') userId: string,
    @Param('id') brandId: string,
  ) {
    return this.brandsService.findOne(userId, brandId);
  }

  @Patch(':id')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary:
      'Atualiza marca. Se "references" estiver presente no body, substitui o array e reanalisa.',
  })
  @ApiResponse({ status: 200, description: 'Marca atualizada' })
  @ApiResponse({ status: 404, description: 'Marca nao encontrada' })
  async update(
    @CurrentUser('sub') userId: string,
    @Param('id') brandId: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brandsService.update(userId, brandId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete da marca' })
  @ApiResponse({ status: 204, description: 'Marca removida' })
  @ApiResponse({ status: 404, description: 'Marca nao encontrada' })
  async remove(
    @CurrentUser('sub') userId: string,
    @Param('id') brandId: string,
  ) {
    return this.brandsService.remove(userId, brandId);
  }
}
