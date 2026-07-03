import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GenerationType, GenerationStatus, Resolution, GenerationImageRole } from '@prisma/client';

export class GenerationOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  url: string;

  @ApiPropertyOptional()
  thumbnailUrl?: string;

  @ApiPropertyOptional()
  mimeType?: string;

  @ApiProperty()
  order: number;
}

export class GenerationInputImageDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: GenerationImageRole })
  role: GenerationImageRole;

  @ApiPropertyOptional()
  mimeType?: string;

  @ApiProperty()
  order: number;

  @ApiPropertyOptional({ description: "'asset' | 'style' — apenas para videos com referencia" })
  referenceType?: string;

  @ApiPropertyOptional({ description: 'S3 URL da imagem, se disponivel' })
  url?: string;
}

export class GenerationFolderDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;
}

export class GenerationResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: GenerationType })
  type: GenerationType;

  @ApiProperty({ enum: GenerationStatus })
  status: GenerationStatus;

  @ApiPropertyOptional()
  prompt?: string;

  @ApiPropertyOptional()
  negativePrompt?: string;

  @ApiProperty({ enum: Resolution })
  resolution: Resolution;

  @ApiPropertyOptional()
  durationSeconds?: number;

  @ApiProperty()
  hasAudio: boolean;

  @ApiPropertyOptional()
  modelUsed?: string;

  @ApiPropertyOptional()
  parameters?: Record<string, unknown>;

  @ApiProperty({ type: [GenerationOutputDto] })
  outputs: GenerationOutputDto[];

  @ApiProperty({ type: [GenerationInputImageDto] })
  inputImages: GenerationInputImageDto[];

  @ApiProperty()
  hasWatermark: boolean;

  @ApiProperty()
  creditsConsumed: number;

  @ApiPropertyOptional()
  processingTimeMs?: number;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiPropertyOptional()
  errorCode?: string;

  @ApiPropertyOptional({ type: GenerationFolderDto, description: 'Pasta onde a geração está, se houver' })
  folder?: GenerationFolderDto;

  @ApiProperty()
  isFavorited: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional()
  completedAt?: Date;
}

export class CreateGenerationResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: GenerationStatus })
  status: GenerationStatus;

  @ApiProperty()
  creditsConsumed: number;
}
