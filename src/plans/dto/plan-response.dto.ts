import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PlanResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional() description: string | null;
  @ApiProperty({ description: 'Preço em centavos na moeda resolvida' })
  priceCents: number;
  @ApiProperty({ example: 'BRL' }) currency: string;
  @ApiProperty() creditsPerMonth: number;
  @ApiProperty() maxConcurrentGenerations: number;
  @ApiProperty() hasWatermark: boolean;
  @ApiPropertyOptional() galleryRetentionDays: number | null;
  @ApiProperty() hasApiAccess: boolean;
}

export class CreditPackageResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() credits: number;
  @ApiProperty() priceCents: number;
  @ApiProperty({ example: 'BRL' }) currency: string;
}
