import {
  IsString,
  IsOptional,
  IsEnum,
  IsIn,
  IsArray,
  IsBoolean,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class ImageInputDto {
  @ApiProperty({ description: 'Imagem em base64' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem',
    default: 'image/png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png'])
  mime_type?: string;
}

export class GenerateImageDto {
  @ApiProperty({
    description: 'Prompt de texto para gerar/editar a imagem',
    example: 'A futuristic cityscape at sunset, cyberpunk style',
  })
  @IsString()
  prompt: string;

  @ApiProperty({
    description: 'Modelo a utilizar',
    enum: [
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image-preview',
      'sem-censura',
      'gpt-image-2',
      'seedream-5-lite',
    ],
  })
  @IsString()
  @IsIn([
    'gemini-3-pro-image-preview',
    'gemini-3.1-flash-image-preview',
    'sem-censura',
    'gpt-image-2',
    'seedream-5-lite',
  ])
  model: string;

  @ApiProperty({ enum: Resolution })
  @IsEnum(Resolution)
  resolution: Resolution;

  @ApiPropertyOptional({
    description: 'Proporcao da imagem',
    enum: [
      '1:1',
      '3:2',
      '2:3',
      '3:4',
      '4:3',
      '4:5',
      '5:4',
      '9:16',
      '16:9',
      '21:9',
    ],
  })
  @IsOptional()
  @IsString()
  @IsIn([
    '1:1',
    '3:2',
    '2:3',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9',
  ])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem de saida',
    example: 'image/png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/png', 'image/jpeg'])
  mime_type?: string;

  @ApiPropertyOptional({
    description:
      'Imagens de input para edicao/referencia. Se presente, o tipo sera IMAGE_TO_IMAGE.',
    type: [ImageInputDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImageInputDto)
  images?: ImageInputDto[];

  @ApiPropertyOptional({
    description: 'Variante do modelo (NB2, NBP)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;

  @ApiPropertyOptional({
    description:
      'Se true, processa a geração no modo ilimitado (sem consumir créditos). Requer plano com modo ilimitado habilitado para o modelo/resolução.',
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unlimited?: boolean;
}
