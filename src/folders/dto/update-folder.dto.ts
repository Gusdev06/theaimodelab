import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFolderDto {
  @ApiPropertyOptional({ description: 'Nome da pasta', example: 'Meus favoritos' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Descricao da pasta' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
