import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum BrandReferenceType {
  LOGO = 'logo',
  PRODUCT_PHOTO = 'product_photo',
  REFERENCE_AD = 'reference_ad',
  IDENTITY = 'identity',
}

export class BrandReferenceInputDto {
  @ApiProperty({ description: 'URL pública (S3) da imagem de referência' })
  @IsString()
  @IsUrl({ require_tld: false })
  url!: string;

  @ApiProperty({ enum: BrandReferenceType })
  @IsEnum(BrandReferenceType)
  type!: BrandReferenceType;
}

export class CreateBrandDto {
  @ApiProperty({ description: 'Nome da marca', minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Referências visuais. Se enviadas, dispara Visual Analyzer síncrono para extrair identity_profile.',
    type: [BrandReferenceInputDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BrandReferenceInputDto)
  references?: BrandReferenceInputDto[];
}
