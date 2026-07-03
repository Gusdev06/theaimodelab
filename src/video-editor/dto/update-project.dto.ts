import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProjectDto {
  @ApiPropertyOptional({ description: 'Nome do projeto', example: 'Meu video editado' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
