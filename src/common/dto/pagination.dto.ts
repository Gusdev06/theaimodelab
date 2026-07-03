import { IsOptional, IsInt, Min, Max, IsString, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PaginationDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Sort field and direction (e.g. created_at:desc)',
    example: 'created_at:desc',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_]+:(asc|desc)$/, {
    message: 'Sort must be in format field:asc or field:desc',
  })
  sort?: string;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}
