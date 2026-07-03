import { IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { GenerationType, GenerationStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class GenerationFiltersDto extends PaginationDto {
  @ApiPropertyOptional({ enum: GenerationType })
  @IsOptional()
  @IsEnum(GenerationType)
  type?: GenerationType;

  @ApiPropertyOptional({ enum: GenerationStatus })
  @IsOptional()
  @IsEnum(GenerationStatus)
  status?: GenerationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  favorited?: boolean;
}
