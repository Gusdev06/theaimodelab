import { IsString, IsOptional, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFolderDto {
  @ApiProperty({ description: 'Nome da pasta', example: 'Meus favoritos' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ description: 'Descricao da pasta' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
