import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class BrandReferenceAssetDto {
  @ApiProperty()
  url!: string;

  @ApiProperty()
  type!: string;

  @ApiPropertyOptional({
    description: 'Análise individual desta referência (observações + key_elements)',
    type: 'object',
    additionalProperties: true,
  })
  analysis?: Record<string, unknown>;
}

export class BrandResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({
    description:
      'Perfil de identidade sintetizado (palette, visual_style, tone, etc.) — null se sem referências',
    type: 'object',
    additionalProperties: true,
  })
  identityProfile?: Record<string, unknown> | null;

  @ApiProperty({ type: [BrandReferenceAssetDto] })
  referenceAssets!: BrandReferenceAssetDto[];

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
