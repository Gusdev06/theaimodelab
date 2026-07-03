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

export class GenerateGrokImagineImageToVideoDto {
  @ApiPropertyOptional({
    description:
      'Prompt de texto descrevendo o movimento do vídeo (máx 5000 chars)',
    example: 'POV hand handing the girl a cup of coffee',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  prompt?: string;

  @ApiProperty({
    description: 'Resolução do vídeo (Grok Imagine suporta 480p e 720p)',
    enum: ['RES_480P', 'RES_720P'],
    example: 'RES_720P',
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
    description: 'Proporção do vídeo (só aplica em multi-imagem)',
    enum: ['2:3', '3:2', '1:1', '16:9', '9:16'],
    default: '16:9',
  })
  @IsOptional()
  @IsString()
  @IsIn(['2:3', '3:2', '1:1', '16:9', '9:16'])
  aspect_ratio?: string;

  @ApiProperty({
    description: 'Primeiro frame em base64',
  })
  @IsString()
  first_frame: string;

  @ApiPropertyOptional({
    description: 'MIME type do primeiro frame',
    default: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  first_frame_mime_type?: string;

  @ApiPropertyOptional({
    description:
      'Último frame em base64 (opcional — vira a segunda imagem do multi-imagem)',
  })
  @IsOptional()
  @IsString()
  last_frame?: string;

  @ApiPropertyOptional({
    description: 'MIME type do último frame',
    default: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  last_frame_mime_type?: string;

  @ApiPropertyOptional({
    description: 'Variante do modelo para cálculo de créditos (GROK_IMAGINE)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
