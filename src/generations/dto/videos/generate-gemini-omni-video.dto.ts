import {
  IsString,
  IsOptional,
  IsIn,
  IsArray,
  ArrayMaxSize,
  ArrayMinSize,
  ValidateNested,
  IsNumber,
  Min,
  MaxLength,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class OmniImageInputDto {
  @ApiProperty({ description: 'Imagem em base64' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'image/jpeg' })
  @IsOptional()
  @IsString()
  mime_type?: string;
}

export class OmniVideoInputDto {
  @ApiProperty({ description: 'Vídeo em base64 (máx 100MB, máx 30s)' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({ default: 'video/mp4' })
  @IsOptional()
  @IsString()
  mime_type?: string;

  @ApiPropertyOptional({
    description:
      'Duração real do vídeo em segundos (usada para auto-calcular ends=min(duration, 10)). Se omitido, usa 10s.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  duration_seconds?: number;
}

export class GenerateGeminiOmniVideoDto {
  @ApiProperty({
    description: 'Prompt descrevendo o vídeo desejado (máx 20000 chars)',
    example:
      'A couple of doors open to the right one by one randomly and stay open, to show the inside.',
  })
  @IsString()
  @MaxLength(20000)
  prompt: string;

  @ApiProperty({
    description: 'Resolução do vídeo',
    enum: ['RES_720P', 'RES_1080P', 'RES_4K'],
  })
  @IsEnum(Resolution)
  @IsIn(['RES_720P', 'RES_1080P', 'RES_4K'])
  resolution: Resolution;

  @ApiProperty({
    description: 'Duração do vídeo em segundos (4, 6, 8, 10). Ignorado quando há vídeo de input.',
    enum: [4, 6, 8, 10],
  })
  @Type(() => Number)
  @IsNumber()
  @IsIn([4, 6, 8, 10])
  duration_seconds: number;

  @ApiPropertyOptional({
    description: 'Proporção do vídeo',
    enum: ['16:9', '9:16'],
    default: '16:9',
  })
  @IsOptional()
  @IsString()
  @IsIn(['16:9', '9:16'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'Imagens de referência em base64 (máx 7)',
    type: [OmniImageInputDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OmniImageInputDto)
  images?: OmniImageInputDto[];

  @ApiPropertyOptional({
    description: 'Vídeo de referência (máx 1)',
    type: OmniVideoInputDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => OmniVideoInputDto)
  video?: OmniVideoInputDto;

  @ApiPropertyOptional({
    description: 'Variante do modelo (GEMINI_OMNI)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
