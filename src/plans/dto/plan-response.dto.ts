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
  @ApiProperty({ description: 'Posição na vitrine e ordem de upgrade (plans.sort_order)' })
  sortOrder: number;
  @ApiProperty({ example: 'month', description: "'month' ou 'year' (anual: 12 meses, créditos mensais)" })
  billingInterval: string;
  @ApiPropertyOptional({ description: 'Nos anuais: slug do plano mensal irmão' })
  basePlanSlug?: string | null;
  @ApiPropertyOptional({ description: 'Link de checkout da assinatura mensal (Perfect Pay)' })
  checkoutUrl?: string | null;
}

export class CreditPackageResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() credits: number;
  @ApiProperty() priceCents: number;
  @ApiProperty({ example: 'BRL' }) currency: string;
}
