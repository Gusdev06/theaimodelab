import { IsString, IsInt, IsOptional, Min, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddClipDto {
  @ApiProperty({ description: 'URL do video de origem' })
  @IsString()
  @IsUrl()
  sourceUrl: string;

  @ApiPropertyOptional({ description: 'Ordem do clip na timeline', example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @ApiPropertyOptional({ description: 'Inicio do corte em milissegundos', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  startMs?: number;

  @ApiPropertyOptional({ description: 'Fim do corte em milissegundos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  endMs?: number;

  @ApiProperty({ description: 'Duracao total do clip em milissegundos' })
  @IsInt()
  @Min(1)
  durationMs: number;

  @ApiPropertyOptional({ description: 'URL da thumbnail do clip' })
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;
}
