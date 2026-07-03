import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateGrokImagineTextToVideoDto {
  @ApiProperty({
    description: 'Prompt de texto descrevendo o vídeo desejado (máx 5000 chars)',
    example:
      'A couple of doors open to the right one by one randomly and stay open, to show the inside, each is either a living room, or a kitchen, or a bedroom or an office, with little people living inside.',
  })
  @IsString()
  @MaxLength(5000)
  prompt: string;

  @ApiProperty({
    description: 'Resolução do vídeo (Grok Imagine suporta 480p e 720p)',
    enum: ['RES_480P', 'RES_720P'],
    example: 'RES_480P',
  })
  @IsIn(['RES_480P', 'RES_720P'])
  resolution: Resolution;

  @ApiProperty({
    description: 'Duração do vídeo em segundos (6-30)',
    minimum: 6,
    maximum: 30,
    example: 6,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(6)
  @Max(30)
  duration_seconds: number;

  @ApiPropertyOptional({
    description: 'Proporção do vídeo',
    enum: ['2:3', '3:2', '1:1', '16:9', '9:16'],
    default: '2:3',
  })
  @IsOptional()
  @IsString()
  @IsIn(['2:3', '3:2', '1:1', '16:9', '9:16'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'Variante do modelo para cálculo de créditos (GROK_IMAGINE)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
