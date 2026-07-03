import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsIn,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateVeoKieImageToVideoDto {
  @ApiProperty({
    description: 'Prompt de texto para gerar o vídeo',
    example: 'A cinematic aerial shot of a coastal city at sunset',
  })
  @IsString()
  prompt: string;

  @ApiPropertyOptional({
    description: 'Modelo Kie Veo',
    enum: ['veo3', 'veo3_fast'],
    default: 'veo3_fast',
  })
  @IsOptional()
  @IsString()
  @IsIn(['veo3', 'veo3_fast'])
  model?: string;

  @ApiProperty({
    description: 'Resolução do vídeo',
    enum: ['RES_720P', 'RES_1080P', 'RES_4K'],
    example: 'RES_1080P',
  })
  @IsIn(['RES_720P', 'RES_1080P', 'RES_4K'])
  resolution: Resolution;

  @ApiPropertyOptional({
    description: 'Proporção do vídeo',
    enum: ['16:9', '9:16', 'Auto'],
    default: '16:9',
  })
  @IsOptional()
  @IsString()
  @IsIn(['16:9', '9:16', 'Auto'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'Gerar áudio junto com o vídeo',
    default: true,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  generate_audio?: boolean;

  @ApiPropertyOptional({
    description: 'Seed para reprodutibilidade (10000-99999)',
    example: 12345,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(10000)
  @Max(99999)
  seed?: number;

  @ApiProperty({
    description: 'Primeiro frame em base64 (imagem de input)',
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
    description: 'Último frame em base64 (opcional, para controle de início/fim)',
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
    description: 'Variante do modelo para cálculo de créditos (VEO_FAST, VEO_MAX)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
