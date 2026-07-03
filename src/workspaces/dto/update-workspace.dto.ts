import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateWorkspaceDto {
  @ApiPropertyOptional({ description: 'Nome do workspace' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Marcar/desmarcar favorito' })
  @IsOptional()
  @IsBoolean()
  favorite?: boolean;

  @ApiPropertyOptional({ description: 'Nós do canvas (react-flow) — autosave' })
  @IsOptional()
  @IsArray()
  nodes?: unknown[];

  @ApiPropertyOptional({
    description: 'Arestas do canvas (react-flow) — autosave',
  })
  @IsOptional()
  @IsArray()
  edges?: unknown[];

  @ApiPropertyOptional({ description: 'Viewport do canvas (x, y, zoom)' })
  @IsOptional()
  @IsObject()
  viewport?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Thumbnail do workspace' })
  @IsOptional()
  @IsString()
  thumbnailUrl?: string;
}
