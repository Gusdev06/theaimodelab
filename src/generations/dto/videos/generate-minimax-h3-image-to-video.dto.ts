import {
  IsString,
  IsOptional,
  IsInt,
  IsIn,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateMinimaxH3ImageToVideoDto {
  @ApiProperty({
    description: 'Prompt descrevendo o movimento, cena e trilha (3-2500 chars)',
    example: 'slow push-in, subtle camera motion, warm ambient soundtrack',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(2500)
  prompt: string;

  @ApiPropertyOptional({
    description: 'Resolução (MiniMax H3 — 480p mais rápido, 768p nativo). RES_720P = 768p.',
    enum: ['RES_480P', 'RES_720P'],
    default: 'RES_480P',
  })
  @IsOptional()
  @IsIn(['RES_480P', 'RES_720P'])
  resolution?: Resolution;

  @ApiProperty({
    description: 'Duração do vídeo em segundos (5–15).',
    minimum: 5,
    maximum: 15,
    example: 5,
  })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(15)
  duration_seconds: number;

  @ApiProperty({
    description:
      'Imagem de entrada (primeiro frame) em base64. A proporção do vídeo segue esta imagem.',
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
      'Último frame (base64, opcional). Quando presente, interpola do primeiro para este.',
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
    description: 'Variante do modelo para cálculo de créditos (WAVESPEED_MINIMAX_H3)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
