import {
  IsString,
  IsOptional,
  IsIn,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  IsNumber,
  Min,
  Max,
  MinLength,
  MaxLength,
  IsEnum,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class SeedanceReferenceImageDto {
  @ApiProperty({ description: 'Imagem em base64' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'image/jpeg' })
  @IsOptional()
  @IsString()
  mime_type?: string;
}

export class SeedanceReferenceVideoDto {
  @ApiProperty({ description: 'Vídeo em base64 (máx 50MB, máx 15s)' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'video/mp4' })
  @IsOptional()
  @IsString()
  mime_type?: string;
}

export class SeedanceReferenceAudioDto {
  @ApiProperty({ description: 'Áudio em base64 (máx 15MB, máx 15s, mp3/wav)' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'audio/mpeg' })
  @IsOptional()
  @IsString()
  mime_type?: string;
}

export const SEEDANCE_DTO_MODELS = ['seedance-2', 'seedance-2-5'] as const;
export type SeedanceDtoModel = (typeof SEEDANCE_DTO_MODELS)[number];

export const SEEDANCE_ASPECT_RATIOS = [
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '21:9',
] as const;
/** Seedance 2.5 aceita também 'adaptive' (segue a proporção da referência). */
export const SEEDANCE_25_ASPECT_RATIOS = [
  ...SEEDANCE_ASPECT_RATIOS,
  'adaptive',
] as const;

/** Duração máxima por modelo (mín. 4s nos dois). O 2.5 aceita até 30s. */
export const SEEDANCE_MAX_DURATION: Record<SeedanceDtoModel, number> = {
  'seedance-2': 15,
  'seedance-2-5': 30,
};

export class GenerateSeedanceVideoDto {
  @ApiPropertyOptional({
    description:
      'Modelo Seedance: "seedance-2" (Seedance 2.0, default) ou "seedance-2-5" (Seedance 2.5 — duração até 30s, aspect "adaptive", first/last frame, web_search)',
    enum: SEEDANCE_DTO_MODELS,
    default: 'seedance-2',
  })
  @IsOptional()
  @IsString()
  @IsIn(SEEDANCE_DTO_MODELS)
  model?: SeedanceDtoModel;

  @ApiProperty({
    description: 'Prompt descrevendo o vídeo (3-20000 chars)',
    minLength: 3,
    maxLength: 20000,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(20000)
  prompt: string;

  @ApiProperty({
    description: 'Resolução do vídeo',
    enum: ['RES_480P', 'RES_720P', 'RES_1080P'],
  })
  @IsEnum(Resolution)
  @IsIn(['RES_480P', 'RES_720P', 'RES_1080P'])
  resolution: Resolution;

  @ApiProperty({
    description:
      'Duração do vídeo em segundos (4-15 no Seedance 2.0; 4-30 no Seedance 2.5). O limite por modelo é validado no service.',
    minimum: 4,
    maximum: 30,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(4)
  @Max(30)
  duration_seconds: number;

  @ApiPropertyOptional({
    description: 'Proporção do vídeo ("adaptive" só no Seedance 2.5)',
    enum: SEEDANCE_25_ASPECT_RATIOS,
    default: '16:9',
  })
  @IsOptional()
  @IsString()
  @IsIn(SEEDANCE_25_ASPECT_RATIOS)
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'Gerar áudio junto com o vídeo',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  generate_audio?: boolean;

  @ApiPropertyOptional({
    description: 'Imagens de referência (multimodal reference-to-video). Máx 6.',
    type: [SeedanceReferenceImageDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => SeedanceReferenceImageDto)
  reference_images?: SeedanceReferenceImageDto[];

  @ApiPropertyOptional({
    description: 'Vídeo de referência (multimodal). Quando presente ativa pricing "with video" (mais barato).',
    type: SeedanceReferenceVideoDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeedanceReferenceVideoDto)
  reference_video?: SeedanceReferenceVideoDto;

  @ApiPropertyOptional({
    description: 'Áudio de referência (multimodal). Não afeta pricing.',
    type: SeedanceReferenceAudioDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeedanceReferenceAudioDto)
  reference_audio?: SeedanceReferenceAudioDto;

  @ApiPropertyOptional({
    description:
      'Só Seedance 2.5: primeiro frame (image-to-video). Pode combinar com last_frame para interpolação.',
    type: SeedanceReferenceImageDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeedanceReferenceImageDto)
  first_frame?: SeedanceReferenceImageDto;

  @ApiPropertyOptional({
    description: 'Só Seedance 2.5: último frame (keyframe final).',
    type: SeedanceReferenceImageDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeedanceReferenceImageDto)
  last_frame?: SeedanceReferenceImageDto;

  @ApiPropertyOptional({
    description:
      'Só Seedance 2.5: habilita busca web para enriquecer o prompt.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  web_search?: boolean;

  @ApiPropertyOptional({
    description:
      'Variante do modelo para cálculo de créditos. Informativo: o service deriva a variante do campo "model" (SEEDANCE_2 / SEEDANCE_2_5).',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
