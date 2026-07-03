import { IsOptional, IsString, IsEnum, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { GenerationType, GenerationStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ListGenerationsQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Busca por nome ou email do usuário (case-insensitive)',
    example: 'joao',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ enum: GenerationType, description: 'Tipo de geração' })
  @IsOptional()
  @IsEnum(GenerationType)
  type?: GenerationType;

  @ApiPropertyOptional({ enum: GenerationStatus, description: 'Status da geração' })
  @IsOptional()
  @IsEnum(GenerationStatus)
  status?: GenerationStatus;

  @ApiPropertyOptional({ description: 'Modelo utilizado (modelUsed)', example: 'veo-3.1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;
}
