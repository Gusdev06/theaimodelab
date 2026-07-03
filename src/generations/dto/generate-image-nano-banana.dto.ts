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

export class NanoBananaImageInputDto {
  @ApiProperty({ description: 'Imagem em base64' })
  @IsString()
  base64: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem',
    default: 'image/png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  mime_type?: string;
}

export class GenerateImageNanoBananaDto {
  @ApiPropertyOptional({
    description:
      'Modelo a ser utilizado. nano-banana-pro = gemini-3-pro-image-preview, nano-banana-2 = gemini-3.1-flash-image-preview',
    enum: ['nano-banana-pro', 'nano-banana-2'],
    default: 'nano-banana-2',
  })
  @IsOptional()
  @IsString()
  @IsIn(['nano-banana-pro', 'nano-banana-2'])
  model?: string;

  @ApiProperty({
    description: 'Prompt de texto para gerar/editar a imagem',
    example: 'A futuristic cityscape at sunset, cyberpunk style',
  })
  @IsString()
  prompt: string;

  @ApiProperty({
    description: 'Resolução da imagem',
    enum: [Resolution.RES_1K, Resolution.RES_2K, Resolution.RES_4K],
  })
  @IsEnum(Resolution)
  @IsIn([Resolution.RES_1K, Resolution.RES_2K, Resolution.RES_4K])
  resolution: Resolution;

  @ApiPropertyOptional({
    description: 'Proporção da imagem',
    enum: [
      '1:1',
      '1:4',
      '1:8',
      '2:3',
      '3:2',
      '3:4',
      '4:1',
      '4:3',
      '4:5',
      '5:4',
      '8:1',
      '9:16',
      '16:9',
      '21:9',
      'auto',
    ],
    default: 'auto',
  })
  @IsOptional()
  @IsString()
  @IsIn([
    '1:1',
    '1:4',
    '1:8',
    '2:3',
    '3:2',
    '3:4',
    '4:1',
    '4:3',
    '4:5',
    '5:4',
    '8:1',
    '9:16',
    '16:9',
    '21:9',
    'auto',
  ])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'Formato da imagem de saída',
    enum: ['jpg', 'png'],
    default: 'png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['jpg', 'png'])
  output_format?: string;

  @ApiPropertyOptional({
    description: 'Usar Google Search para gerar imagens baseadas em informações em tempo real',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  google_search?: boolean;

  @ApiPropertyOptional({
    description:
      'Imagens de input para edição/referência (até 14). Se presente, o tipo será IMAGE_TO_IMAGE.',
    type: [NanoBananaImageInputDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NanoBananaImageInputDto)
  images?: NanoBananaImageInputDto[];

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
