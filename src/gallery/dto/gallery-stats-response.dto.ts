import { ApiProperty } from '@nestjs/swagger';

export class GenerationsByTypeDto {
  @ApiProperty()
  TEXT_TO_IMAGE: number;

  @ApiProperty()
  IMAGE_TO_IMAGE: number;

  @ApiProperty()
  TEXT_TO_VIDEO: number;

  @ApiProperty()
  IMAGE_TO_VIDEO: number;

  @ApiProperty()
  MOTION_CONTROL: number;
}

export class GalleryStatsResponseDto {
  @ApiProperty()
  totalGenerations: number;

  @ApiProperty()
  totalCreditsUsed: number;

  @ApiProperty({ type: GenerationsByTypeDto })
  generationsByType: GenerationsByTypeDto;

  @ApiProperty()
  favoriteCount: number;
}
