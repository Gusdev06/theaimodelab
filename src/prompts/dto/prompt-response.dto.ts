import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PromptTemplateDto {
  @ApiProperty({ description: 'ID do prompt template' })
  id: string;

  @ApiProperty({ description: 'Titulo do prompt' })
  title: string;

  @ApiProperty({ description: 'Tipo de geracao (ex: text_to_image, text_to_video)' })
  type: string;

  @ApiProperty({ description: 'Conteudo do prompt' })
  prompt: string;

  @ApiPropertyOptional({ description: 'URL da imagem de preview (original)' })
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'URL da thumbnail otimizada (WebP)' })
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Modelo de IA recomendado' })
  aiModel?: string;
}

export class PromptCategoryDto {
  @ApiProperty({ description: 'ID da categoria' })
  id: string;

  @ApiProperty({ description: 'Titulo da categoria' })
  title: string;

  @ApiProperty({
    description: 'Prompts da categoria',
    type: [PromptTemplateDto],
  })
  prompts: PromptTemplateDto[];
}

export class PromptSectionDto {
  @ApiProperty({ description: 'ID da secao' })
  id: string;

  @ApiProperty({ description: 'Slug unico da secao' })
  slug: string;

  @ApiProperty({ description: 'Titulo da secao' })
  title: string;

  @ApiPropertyOptional({ description: 'Descricao da secao' })
  description?: string;

  @ApiPropertyOptional({ description: 'Icone da secao' })
  icon?: string;

  @ApiProperty({
    description: 'Categorias da secao',
    type: [PromptCategoryDto],
  })
  categories: PromptCategoryDto[];
}

export class PromptSectionsResponseDto {
  @ApiProperty({
    description: 'Lista de secoes com categorias e prompts',
    type: [PromptSectionDto],
  })
  sections: PromptSectionDto[];
}
