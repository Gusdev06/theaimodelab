import {
  IsString,
  IsOptional,
  IsEnum,
  IsIn,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateVirtualTryOnDto {
  @ApiProperty({
    description: 'Imagem da influencer de IA em base64',
    example: '<base64 da foto da influencer>',
  })
  @IsString()
  influencer_image: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem da influencer',
    default: 'image/png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  influencer_image_mime_type?: string;

  @ApiProperty({
    description: 'Imagem da roupa em base64',
    example: '<base64 da foto da roupa>',
  })
  @IsString()
  clothing_image: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem da roupa',
    default: 'image/png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  clothing_image_mime_type?: string;

  @ApiPropertyOptional({
    description:
      'Instruções adicionais para a geração (ex: "foto em ambiente externo", "iluminação natural")',
    example: 'foto profissional em estúdio com fundo branco',
  })
  @IsOptional()
  @IsString()
  additional_instructions?: string;

  @ApiProperty({
    description: 'Modelo Gemini a utilizar',
    enum: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'],
    default: 'gemini-3.1-flash-image-preview',
  })
  @IsOptional()
  @IsString()
  @IsIn(['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'])
  model?: string;

  @ApiProperty({ enum: Resolution, default: 'RES_2K' })
  @IsOptional()
  @IsEnum(Resolution)
  resolution?: Resolution;

  @ApiPropertyOptional({
    description: 'Proporção da imagem de saída',
    enum: ['1:1', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'],
    default: '3:4',
  })
  @IsOptional()
  @IsString()
  @IsIn(['1:1', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'])
  aspect_ratio?: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem de saída',
    default: 'image/png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/png', 'image/jpeg'])
  output_mime_type?: string;

  @ApiPropertyOptional({
    description: 'Variante do modelo (NB2, NBP)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
