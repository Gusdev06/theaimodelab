import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsIn,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateKlingImageToVideoDto {
  @ApiPropertyOptional({
    description:
      'Prompt de texto descrevendo o movimento do vídeo (máx 2500 chars)',
    example: 'the woman slowly turns and smiles at the camera',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2500)
  prompt?: string;

  @ApiProperty({
    description: 'Resolução do vídeo (Kling V3 Turbo suporta 720p e 1080p)',
    enum: ['RES_720P', 'RES_1080P'],
    example: 'RES_720P',
  })
  @IsIn(['RES_720P', 'RES_1080P'])
  resolution: Resolution;

  @ApiPropertyOptional({
    description:
      'Proporção do vídeo. Se omitido, é detectado a partir da imagem de entrada.',
    enum: ['9:16', '16:9', '1:1'],
    example: '9:16',
  })
  @IsOptional()
  @IsIn(['9:16', '16:9', '1:1'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description:
      'Gerar com áudio nativo (Kling V3 Turbo inclui áudio sem custo extra).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  generate_audio?: boolean;

  @ApiProperty({
    description: 'Duração do vídeo em segundos (3-15)',
    minimum: 3,
    maximum: 15,
    example: 5,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(3)
  @Max(15)
  duration_seconds: number;

  @ApiProperty({
    description: 'Imagem de entrada (primeiro frame) em base64 — Kling é image-to-video',
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
    description: 'Variante do modelo para cálculo de créditos (KLING_V3_TURBO)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
