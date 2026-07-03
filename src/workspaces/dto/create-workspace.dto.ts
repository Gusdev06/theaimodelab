import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWorkspaceDto {
  @ApiPropertyOptional({ description: 'Nome do workspace' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    description:
      'Nós do canvas (react-flow) — usado na importação do canvas legado',
  })
  @IsOptional()
  @IsArray()
  nodes?: unknown[];

  @ApiPropertyOptional({ description: 'Arestas do canvas (react-flow)' })
  @IsOptional()
  @IsArray()
  edges?: unknown[];

  @ApiPropertyOptional({ description: 'Viewport do canvas (x, y, zoom)' })
  @IsOptional()
  @IsObject()
  viewport?: Record<string, unknown>;
}
