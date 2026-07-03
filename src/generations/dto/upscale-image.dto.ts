import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpscaleImageDto {
  @ApiProperty({ description: 'Imagem em base64 a ser feita upscale' })
  @IsString()
  image: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem de entrada',
    default: 'image/png',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png'])
  mime_type?: string;

  @ApiProperty({
    description: 'Modelo Gemini a utilizar',
    enum: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'],
  })
  @IsString()
  @IsIn(['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'])
  model: string;

  @ApiPropertyOptional({ description: 'Variante do modelo (NB2, NBP)' })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
