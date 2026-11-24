import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MAX_EPISODES, MIN_EPISODES } from '../scene-series.logic';

export class SeriesLocalizedTextDto {
  @ApiPropertyOptional({ example: 'A vizinha da piscina' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  'pt-BR'?: string;

  @ApiPropertyOptional({ example: 'La vecina de la piscina' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  es?: string;

  @ApiPropertyOptional({ example: 'The pool neighbor' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  en?: string;

  @ApiPropertyOptional({ example: 'La vicina della piscina' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  it?: string;
}

export class SceneSeriesEpisodeDto {
  @ApiProperty({ description: 'id da cena no acervo (prompt_templates.id)' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sceneId!: string;

  @ApiPropertyOptional({
    description: 'título do episódio; sem ele vale o título da cena',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ type: SeriesLocalizedTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeriesLocalizedTextDto)
  titleI18n?: SeriesLocalizedTextDto;

  @ApiPropertyOptional({
    description:
      'imagem JÁ borrada do episódio trancado; sem ela o servidor borra o 1º quadro',
  })
  @IsOptional()
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(2000)
  teaserUrl?: string;
}

export class UpsertSceneSeriesDto {
  @ApiProperty({ example: 'A vizinha da piscina' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional({ type: SeriesLocalizedTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeriesLocalizedTextDto)
  titleI18n?: SeriesLocalizedTextDto;

  @ApiPropertyOptional({
    description: 'nome da modelo de exemplo que faz todos os episódios',
    example: 'Mia',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  modelName?: string;

  @ApiPropertyOptional({
    description: 'capa da série; sem ela vale o 1º quadro do ep. 1',
  })
  @IsOptional()
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(2000)
  coverUrl?: string;

  @ApiPropertyOptional({
    description: 'episódios abertos para quem não assina (padrão 2)',
    example: 2,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_EPISODES - 1)
  freeEpisodes?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(-1000)
  @Max(1000)
  sortOrder?: number;

  @ApiProperty({
    type: [SceneSeriesEpisodeDto],
    description: `${MIN_EPISODES} a ${MAX_EPISODES} episódios, na ordem`,
  })
  @IsArray()
  @ArrayMinSize(MIN_EPISODES)
  @ArrayMaxSize(MAX_EPISODES)
  @ValidateNested({ each: true })
  @Type(() => SceneSeriesEpisodeDto)
  episodes!: SceneSeriesEpisodeDto[];

  @ApiPropertyOptional({
    description:
      'true = os episódios trancados saem da parede pública (prompt_templates.is_active=false) e só aparecem pela série',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  lockInLibrary?: boolean;
}
