import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiPropertyOptional({ description: 'Nome do projeto', example: 'Meu video' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
