import {
  IsString,
  IsOptional,
  IsInt,
  IsIn,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateWavespeedImageToVideoDto {
  @ApiProperty({
    description: 'Prompt descrevendo o movimento/cena do vídeo (máx 2500 chars)',
    example: 'a mulher caminha lentamente em direção à câmera',
  })
  @IsString()
  @MaxLength(2500)
  prompt: string;

  @ApiPropertyOptional({
    description: 'Resolução do vídeo (LTX 2.3 Spicy aceita 480p, 720p e 1080p)',
    enum: ['RES_480P', 'RES_720P', 'RES_1080P'],
    default: 'RES_480P',
  })
  @IsOptional()
  @IsIn(['RES_480P', 'RES_720P', 'RES_1080P'])
  resolution?: Resolution;

  @ApiProperty({
    description:
      'Duração do vídeo em segundos (5–20). O WaveSpeed fatura no mínimo 5s.',
    minimum: 5,
    maximum: 20,
    example: 5,
  })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(20)
  duration_seconds: number;

  @ApiPropertyOptional({
    description: 'Preset de estilo do LTX: tuned (recomendado) ou original',
    enum: ['tuned', 'original'],
    default: 'tuned',
  })
  @IsOptional()
  @IsIn(['tuned', 'original'])
  preset?: 'tuned' | 'original';

  @ApiProperty({
    description: 'Imagem de entrada (primeiro frame) em base64 — LTX é image-to-video',
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
    description: 'Variante do modelo para cálculo de créditos (WAVESPEED_LTX_SPICY)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
