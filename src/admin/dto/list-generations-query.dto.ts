import { IsOptional, IsString, IsEnum, IsISO8601, MaxLength } from 'class-validator';
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

  @ApiPropertyOptional({
    description: 'Criadas a partir de (ISO 8601; só a data vale desde 00:00 UTC)',
    example: '2026-11-01T00:00:00Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    description: 'Criadas até (ISO 8601; só a data vale até 23:59:59 UTC)',
    example: '2026-11-06T23:59:59Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional({ description: 'Código de erro exato (generations.error_code)', example: 'CONTENT_SAFETY_BLOCKED' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  errorCode?: string;
}
