import { IsOptional, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateClipDto {
  @ApiPropertyOptional({ description: 'Inicio do corte em milissegundos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  startMs?: number;

  @ApiPropertyOptional({ description: 'Fim do corte em milissegundos' })
  @IsOptional()
  @IsInt()
  @Min(0)
  endMs?: number;
}
