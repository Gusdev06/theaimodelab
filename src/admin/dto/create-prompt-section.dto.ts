import { IsString, IsNotEmpty, IsOptional, IsInt, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePromptSectionDto {
  @ApiProperty({
    description: 'Unique slug for the section',
    example: 'fashion',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  slug: string;

  @ApiProperty({
    description: 'Display title of the section',
    example: 'Moda & Estilo',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiPropertyOptional({
    description: 'Section description',
    example: 'Prompts para criação de conteúdo de moda',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Icon identifier for the section',
    example: 'shirt',
  })
  @IsString()
  @IsOptional()
  @MaxLength(50)
  icon?: string;

  @ApiPropertyOptional({
    description: 'Sort order for display',
    example: 0,
  })
  @IsInt()
  @IsOptional()
  sortOrder?: number;
}
