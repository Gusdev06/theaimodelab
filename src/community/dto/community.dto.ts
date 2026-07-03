import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitCommunityPostDto {
  @ApiProperty({ description: 'Geração (concluída) que vira o post' })
  @IsString()
  generationId: string;

  @ApiPropertyOptional({
    description: 'Output específico da geração (default: primeiro output)',
  })
  @IsOptional()
  @IsString()
  outputUrl?: string;
}

export class CreateAdminCommunityPostDto {
  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  kind: 'image' | 'video';

  @ApiProperty({ description: 'URL pública da mídia (já enviada ao R2)' })
  @IsString()
  mediaUrl: string;

  @ApiPropertyOptional({ description: 'Thumbnail (recomendado para vídeo)' })
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Prompt/legenda exibido no post' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  prompt?: string;
}

export class RejectCommunityPostDto {
  @ApiPropertyOptional({ description: 'Motivo exibido ao autor' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
