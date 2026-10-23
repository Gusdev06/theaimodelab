import {
  IsString,
  IsInt,
  IsOptional,
  Min,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddClipDto {
  @ApiProperty({
    description:
      'URL de um video gerado na propria conta (a mesma da galeria). URL externa, de outra conta ou em revisao = 400',
  })
  @IsString()
  @IsUrl()
  @MaxLength(2048)
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

  @ApiPropertyOptional({
    description:
      'Ignorado: a miniatura do clip e a do proprio resultado (aceito so para nao quebrar clientes antigos)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  thumbnailUrl?: string;
}
