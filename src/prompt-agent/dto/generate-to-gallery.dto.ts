import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateToGalleryDto {
  @ApiProperty({ description: 'Imagem de referência: data URL (base64) ou URL http(s)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  image!: string;

  @ApiPropertyOptional({ description: 'Legenda do post na galeria' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  caption?: string;

  @ApiPropertyOptional({
    description: 'Slug customizado (gerado a partir do prompt se omitido)',
  })
  @IsString()
  @IsOptional()
  @MaxLength(80)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug deve conter apenas letras minúsculas, números e hífens',
  })
  slug?: string;
}
