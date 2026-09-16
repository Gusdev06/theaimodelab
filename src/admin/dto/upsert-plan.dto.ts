import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const PLAN_PRICE_CURRENCIES = ['USD', 'BRL', 'EUR'] as const;
export type PlanPriceCurrency = (typeof PLAN_PRICE_CURRENCIES)[number];

/** Modelo liberado no modo ilimitado: variante + resoluções. */
export class PlanUnlimitedModelDto {
  @ApiProperty({ example: 'NB2' })
  @IsString()
  @IsNotEmpty()
  modelVariant: string;

  @ApiProperty({ example: ['RES_1K', 'RES_2K'] })
  @IsArray()
  @IsString({ each: true })
  resolutions: string[];
}

/**
 * Preço do plano numa moeda. USD/EUR usam o checkoutUrl do próprio plano
 * (Perfect Pay); BRL precisa do link da Cakto aqui — sem ele o plano não
 * aparece na vitrine /pt-br.
 */
export class PlanPriceInputDto {
  @ApiProperty({ enum: PLAN_PRICE_CURRENCIES })
  @IsIn(PLAN_PRICE_CURRENCIES)
  currency: PlanPriceCurrency;

  @ApiProperty({ description: 'Centavos' })
  @IsInt()
  @Min(0)
  priceCents: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsString()
  @MaxLength(500)
  checkoutUrl?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpsertPlanDto {
  @ApiPropertyOptional({ description: 'Só na criação. kebab-case.', example: 'agency' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug deve ser kebab-case (a-z, 0-9, hífen)' })
  @MaxLength(40)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ApiPropertyOptional({ description: 'Preço base (BRL) em centavos — legado, o que vale na vitrine é plan_prices' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  creditsPerMonth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxConcurrentGenerations?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasWatermark?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'null = galeria ilimitada' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(1)
  galleryRetentionDays?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasApiAccess?: boolean;

  @ApiPropertyOptional({ description: 'false = plano morto pra vendas novas E renovação (cuidado)' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'false = some da vitrine, assinante antigo continua' })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ enum: ['month', 'year'], description: "Anual = cobrança 1x/ano, 12 meses, créditos liberados mês a mês" })
  @IsOptional()
  @IsIn(['month', 'year'])
  billingInterval?: 'month' | 'year';

  @ApiPropertyOptional({ nullable: true, description: 'Nos anuais: slug do plano mensal irmão (pareia na vitrine e herda o visual)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  basePlanSlug?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Link recorrente da Perfect Pay (vitrine USD/EUR)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  checkoutUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'plan.code que vem no POSTBACK da Perfect Pay (não é o code do link)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(60)
  perfectpayPlanCode?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'short-code da oferta Cakto (segmento de pay.cakto.com.br/<code>)' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(60)
  caktoOfferCode?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  avatarCloneEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  avatarCloneLimit?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  voiceCloneLimit?: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Prioridade na fila ilimitada: 0 passa na frente de todos; null = sem modo ilimitado' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  unlimitedPriority?: number | null;

  @ApiPropertyOptional({ type: [PlanUnlimitedModelDto], nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanUnlimitedModelDto)
  unlimitedModels?: PlanUnlimitedModelDto[] | null;

  @ApiPropertyOptional({ type: [PlanPriceInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanPriceInputDto)
  prices?: PlanPriceInputDto[];
}
