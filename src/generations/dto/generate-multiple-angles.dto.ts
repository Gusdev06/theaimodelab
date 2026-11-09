import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MULTIPLE_ANGLES_DISTANCE,
  MULTIPLE_ANGLES_HORIZONTAL,
  MULTIPLE_ANGLES_VERTICAL,
} from '../multiple-angles.constants';

/**
 * Rota POST /generations/multiple-angles: uma foto pronta da conta vista de outro ângulo (Qwen Multiple Angles na
 * WaveSpeed). Não recebe foto nem texto: só o id da geração de origem e o ângulo (multiple-angles.constants.ts).
 */
export class GenerateMultipleAnglesDto {
  @ApiProperty({ description: 'Id de uma geração de imagem PRONTA desta conta, de linhagem limpa (a modelo de IA feita aqui)' })
  @IsString()
  @Matches(/^[a-z0-9]{20,40}$/i, { message: 'source_generation_id inválido' })
  source_generation_id: string;

  @ApiPropertyOptional({ description: 'Qual saída da geração de origem (0 a 3)', minimum: 0, maximum: 3, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3)
  source_output?: number;

  @ApiProperty({ description: 'Giro da câmera em graus (0 = de frente, 90 = lado, 180 = de costas)', enum: MULTIPLE_ANGLES_HORIZONTAL })
  @Type(() => Number)
  @IsInt()
  @IsIn([...MULTIPLE_ANGLES_HORIZONTAL])
  horizontal_angle: number;

  @ApiPropertyOptional({ description: 'Altura da câmera (-30 = de baixo, 0 = olhos, 30/60 = de cima)', enum: MULTIPLE_ANGLES_VERTICAL, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([...MULTIPLE_ANGLES_VERTICAL])
  vertical_angle?: number;

  @ApiPropertyOptional({ description: 'Distância (0 = close, 1 = médio, 2 = aberto)', enum: MULTIPLE_ANGLES_DISTANCE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([...MULTIPLE_ANGLES_DISTANCE])
  distance?: number;
}
