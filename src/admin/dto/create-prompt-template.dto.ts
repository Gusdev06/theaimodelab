import { IsString, IsNotEmpty, IsOptional, IsInt, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePromptTemplateDto {
  @ApiProperty({
    description: 'ID of the category this template belongs to',
    example: 'clxyz123abc',
  })
  @IsString()
  @IsNotEmpty()
  categoryId: string;

  @ApiProperty({
    description: 'Display title of the prompt template',
    example: 'Foto de produto em estúdio',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({
    description: 'Generation type (e.g. text_to_image, image_to_image, text_to_video)',
    example: 'text_to_image',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  type: string;

  @ApiProperty({
    description: 'The prompt text',
    example: 'A professional studio photo of a product on a white background, soft lighting',
  })
  @IsString()
  @IsNotEmpty()
  prompt: string;

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
