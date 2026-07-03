import { IsOptional, IsBoolean, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { GenerationType } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class GalleryFiltersDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Comma-separated generation types (e.g. TEXT_TO_IMAGE,IMAGE_TO_IMAGE)',
    example: 'TEXT_TO_IMAGE,IMAGE_TO_IMAGE',
  })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  favorited?: boolean;

  @ApiPropertyOptional({ description: 'Filter by folder ID' })
  @IsOptional()
  @IsString()
  folderId?: string;

  get typeArray(): GenerationType[] | undefined {
    if (!this.type) return undefined;
    return this.type.split(',').map((t) => t.trim()) as GenerationType[];
  }
}
