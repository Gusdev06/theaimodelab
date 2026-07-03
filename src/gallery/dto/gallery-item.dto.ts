import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  GenerationType,
  GenerationStatus,
  Resolution,
} from '@prisma/client';

export class GalleryItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: GenerationType })
  type: GenerationType;

  @ApiProperty({ enum: GenerationStatus })
  status: GenerationStatus;

  @ApiPropertyOptional({ description: 'Thumbnail URL (imagem) ou primeiro output (video)' })
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Tiny blurred base64 placeholder for instant loading' })
  blurDataUrl?: string;

  @ApiPropertyOptional({ description: 'URL do primeiro output' })
  outputUrl?: string;

  @ApiPropertyOptional()
  prompt?: string;

  @ApiProperty({ enum: Resolution })
  resolution: Resolution;

  @ApiPropertyOptional()
  durationSeconds?: number;

  @ApiProperty()
  hasAudio: boolean;

  @ApiProperty()
  hasWatermark: boolean;

  @ApiProperty()
  creditsConsumed: number;

  @ApiProperty()
  isFavorited: boolean;

  @ApiProperty()
  outputCount: number;

  @ApiPropertyOptional({
    description: 'Pasta onde a geração está, se houver',
  })
  folder?: { id: string; name: string };

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional()
  completedAt?: Date;
}
