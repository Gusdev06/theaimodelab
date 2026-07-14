import {
  IsString,
  IsOptional,
  IsInt,
  IsIn,
  IsBoolean,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateWavespeedSeedanceImageToVideoDto {
  @ApiPropertyOptional({
    description: 'Prompt descrevendo cena, ação, câmera e clima (opcional, máx 2500 chars)',
    example: 'cinematic slow push-in, subtle motion, warm light',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2500)
  prompt?: string;

  @ApiPropertyOptional({
    description:
      'Resolução do vídeo (Seedance 2.0 Fast Spicy — 480p, 720p, 1080p; 4k desabilitado por custo)',
    enum: ['RES_480P', 'RES_720P', 'RES_1080P'],
    default: 'RES_720P',
  })
  @IsOptional()
  @IsIn(['RES_480P', 'RES_720P', 'RES_1080P'])
  resolution?: Resolution;

  @ApiProperty({
    description: 'Duração do vídeo em segundos (4–15).',
    minimum: 4,
    maximum: 15,
    example: 5,
  })
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(15)
  duration_seconds: number;

  @ApiPropertyOptional({
    description:
      'Proporção do vídeo (opcional — se ausente, adapta à imagem de entrada)',
    enum: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
  })
  @IsOptional()
  @IsIn(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'Gerar áudio nativo sincronizado (muda o custo). Default: true.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  generate_audio?: boolean;

  @ApiProperty({
    description: 'Imagem de entrada (primeiro frame) em base64 — image-to-video',
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
    description: 'Variante do modelo para cálculo de créditos (WAVESPEED_SEEDANCE_SPICY)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
