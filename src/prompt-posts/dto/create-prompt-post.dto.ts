import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsArray,
  ArrayMinSize,
  ValidateNested,
  MaxLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GenerationType } from '@prisma/client';

export class PromptPostSlideInputDto {
  @ApiProperty({ description: 'Texto do prompt usado para essa imagem' })
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @ApiProperty({ description: 'URL pública da imagem (S3/R2)' })
  @IsString()
  @IsNotEmpty()
  imageUrl: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  thumbnailUrl?: string;

  @ApiPropertyOptional({ description: 'Aspect ratio (ex: 1:1, 9:16)' })
  @IsString()
  @IsOptional()
  @MaxLength(10)
  aspectRatio?: string;

  @ApiPropertyOptional({ enum: GenerationType, default: GenerationType.TEXT_TO_IMAGE })
  @IsEnum(GenerationType)
  @IsOptional()
  generationType?: GenerationType;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(100)
  aiModel?: string;
}

export class CreatePromptPostDto {
  @ApiProperty({
    description: 'Lista de slides do post (mínimo 1, ordem do array vira a ordem)',
    type: [PromptPostSlideInputDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PromptPostSlideInputDto)
  slides: PromptPostSlideInputDto[];

  @ApiPropertyOptional({
    description: 'Slug customizado para a URL pública (gerado a partir do primeiro prompt se omitido)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug deve conter apenas letras minúsculas, números e hífens',
  })
  slug?: string;

  @ApiPropertyOptional({ description: 'Legenda do post (mostrada acima do prompt do slide)' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  caption?: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isPublished?: boolean;
}
