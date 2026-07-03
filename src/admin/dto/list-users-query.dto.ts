import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ListUsersQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Search by name or email (case-insensitive)',
    example: 'joao',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
