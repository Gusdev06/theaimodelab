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

export class GenerateMinimaxH3TextToVideoDto {
  @ApiProperty({
    description: 'Prompt descrevendo cena, ação, câmera e trilha (3-2500 chars)',
    example: 'cinematic aerial shot over a neon city at night, upbeat soundtrack',
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

  @ApiPropertyOptional({
    description: 'Proporção do vídeo.',
    enum: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'],
    default: '16:9',
  })
  @IsOptional()
  @IsIn(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'Variante do modelo para cálculo de créditos (WAVESPEED_MINIMAX_H3)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
