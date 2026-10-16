import { IsString, IsOptional, IsIn, IsBoolean } from 'class-validator';
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

  @ApiPropertyOptional({
    description:
      'Variante do modelo. SEM_CENSURA ativa o modo Unlocked (NSFW), que roda o face swap pelo modelo sem censura.',
    enum: ['SEM_CENSURA'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['SEM_CENSURA'])
  model_variant?: string;

  @ApiPropertyOptional({
    description:
      'Atestado obrigatório (ContentSafetyInterceptor): a foto do rosto é de uma pessoa gerada por IA ou de um adulto que autorizou o uso da própria imagem. Sem true, a troca de rosto é recusada (CONSENT_REQUIRED).',
  })
  @IsOptional()
  @IsBoolean()
  consent_confirmed?: boolean;
}
