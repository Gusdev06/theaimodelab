import {
  IsString,
  IsOptional,
  IsInt,
  IsIn,
  IsArray,
  ArrayMaxSize,
  Min,
  Max,
  MinLength,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class MinimaxH3ReferenceImageDto {
  @ApiProperty({ description: 'Imagem em base64' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'image/jpeg' })
  @IsOptional()
  @IsString()
  mime_type?: string;
}

export class MinimaxH3ReferenceVideoDto {
  @ApiProperty({ description: 'Vídeo em base64 (480p, ≤15s)' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'video/mp4' })
  @IsOptional()
  @IsString()
  mime_type?: string;
}

export class MinimaxH3ReferenceAudioDto {
  @ApiProperty({ description: 'Áudio em base64 (≤15s, mp3/wav)' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'audio/mpeg' })
  @IsOptional()
  @IsString()
  mime_type?: string;
}

export class GenerateMinimaxH3ReferenceToVideoDto {
  @ApiProperty({
    description:
      'Prompt do vídeo. Refira as referências como <Picture 1>..<Picture 9>, <Video 1>..<Video 3>, <Audio 1>..<Audio 3>. (3-2500 chars)',
    example: 'a portrait of <Picture 1> walking through a forest, ambient nature sounds',
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
    description: 'Imagens de referência (máx 9). Ao menos uma referência é obrigatória.',
    type: [MinimaxH3ReferenceImageDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @ValidateNested({ each: true })
  @Type(() => MinimaxH3ReferenceImageDto)
  reference_images?: MinimaxH3ReferenceImageDto[];

  @ApiPropertyOptional({
    description: 'Vídeos de referência (máx 3, 480p, total ≤15s).',
    type: [MinimaxH3ReferenceVideoDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => MinimaxH3ReferenceVideoDto)
  reference_videos?: MinimaxH3ReferenceVideoDto[];

  @ApiPropertyOptional({
    description: 'Áudios de referência (máx 3, ≤15s cada).',
    type: [MinimaxH3ReferenceAudioDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => MinimaxH3ReferenceAudioDto)
  reference_audios?: MinimaxH3ReferenceAudioDto[];

  @ApiPropertyOptional({
    description: 'Variante do modelo para cálculo de créditos (WAVESPEED_MINIMAX_H3)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
