import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateFaceSwapDto {
  @ApiProperty({ description: 'Imagem do rosto (source) em base64' })
  @IsString()
  source_image: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem source',
    enum: ['image/jpeg', 'image/png', 'image/webp'],
    default: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  source_image_mime_type?: string;

  @ApiProperty({ description: 'Imagem alvo (cena/corpo) em base64' })
  @IsString()
  target_image: string;

  @ApiPropertyOptional({
    description: 'MIME type da imagem target',
    enum: ['image/jpeg', 'image/png', 'image/webp'],
    default: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  target_image_mime_type?: string;

  @ApiPropertyOptional({
    description: 'Resolução da imagem gerada',
    enum: ['1K', '2K', '4K'],
    default: '2K',
  })
  @IsOptional()
  @IsString()
  @IsIn(['1K', '2K', '4K'])
  resolution?: string;
}
