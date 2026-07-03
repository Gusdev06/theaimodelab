import { IsString, IsOptional, IsInt, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePromptTemplateDto {
  @ApiPropertyOptional({
    description: 'ID of the category this template belongs to',
    example: 'clxyz123abc',
  })
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Display title of the prompt template',
    example: 'Foto de produto em estúdio',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({
    description: 'Generation type (e.g. text_to_image, image_to_image, text_to_video)',
    example: 'text_to_image',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({
    description: 'The prompt text',
    example: 'A professional studio photo of a product on a white background, soft lighting',
  })
  @IsString()
  @IsOptional()
  prompt?: string;

  @ApiPropertyOptional({
    description: 'Preview image URL for the template',
    example: 'https://cdn.theaimodelab.com/prompts/studio-product.webp',
  })
  @IsString()
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional({
    description: 'Recommended AI model for this prompt',
    example: 'nano-banana-2',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  aiModel?: string;

  @ApiPropertyOptional({
    description: 'Sort order for display',
    example: 0,
  })
  @IsInt()
  @IsOptional()
  sortOrder?: number;
}
