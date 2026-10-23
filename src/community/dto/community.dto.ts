import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitCommunityPostDto {
  @ApiProperty({ description: 'Geração (concluída) que vira o post' })
  @IsString()
  @MaxLength(64)
  generationId: string;

  @ApiPropertyOptional({
    description:
      'Output específico da geração (default: primeiro output). Só saída no bucket público, fora de revisão',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  outputUrl?: string;
}

export class CreateAdminCommunityPostDto {
  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  kind: 'image' | 'video';

  @ApiProperty({
    description:
      'URL pública da mídia, no nosso bucket (já enviada ao R2); URL de outro host = 400',
  })
  @IsString()
  @MaxLength(2048)
  mediaUrl: string;

  @ApiPropertyOptional({
    description:
      'Thumbnail (recomendado para vídeo); fora do nosso bucket é descartada',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
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
