import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VideoProjectStatus } from '@prisma/client';

export class ClipResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  sourceUrl: string;

  @ApiPropertyOptional()
  thumbnailUrl?: string;

  @ApiProperty()
  order: number;

  @ApiProperty()
  startMs: number;

  @ApiPropertyOptional()
  endMs?: number;

  @ApiProperty()
  durationMs: number;

  @ApiProperty()
  createdAt: Date;
}

export class ProjectResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: VideoProjectStatus })
  status: VideoProjectStatus;

  @ApiPropertyOptional()
  outputUrl?: string;

  @ApiPropertyOptional()
  outputThumbnailUrl?: string;

  @ApiPropertyOptional()
  durationMs?: number;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiPropertyOptional({ type: [ClipResponseDto] })
  clips?: ClipResponseDto[];
}
