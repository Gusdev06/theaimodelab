import {
  IsString,
  IsOptional,
  IsNumber,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Resolution } from '@prisma/client';

export class GenerateComfyDeployImageToVideoDto {
  @ApiProperty({
    description: 'Prompt de texto descrevendo o movimento do vídeo (máx 2500 chars)',
    example: 'gentle camera push-in, subtle motion',
  })
  @IsString()
  @MaxLength(2500)
  prompt: string;

  @ApiPropertyOptional({
    description:
      'Resolução nominal (ComfyDeploy WAN roda em resolução fixa do workflow; usada apenas para pricing)',
    enum: ['RES_480P', 'RES_720P'],
    default: 'RES_720P',
  })
  @IsOptional()
  @IsIn(['RES_480P', 'RES_720P'])
  resolution?: Resolution;

  @ApiProperty({
    description:
      'Duração do vídeo em segundos — apenas 2 (gif) ou 5. Convertida internamente em frames (16fps, formato 4n+1).',
    enum: [2, 5],
    example: 5,
  })
  @Type(() => Number)
  @IsNumber()
  @IsIn([2, 5])
  duration_seconds: number;

  @ApiProperty({
    description: 'Imagem de entrada (primeiro frame) em base64 — WAN é image-to-video',
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
    description: 'Variante do modelo para cálculo de créditos (COMFYDEPLOY_WAN)',
  })
  @IsOptional()
  @IsString()
  model_variant?: string;
}
