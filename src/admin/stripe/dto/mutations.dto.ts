import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class RefundChargeDto {
  @ApiPropertyOptional({ description: 'Valor parcial em centavos. Omitir = reembolso total' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  amount?: number;

  @ApiPropertyOptional({ description: 'duplicate | fraudulent | requested_by_customer' })
  @IsOptional()
  @IsIn(['duplicate', 'fraudulent', 'requested_by_customer'])
  reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
}

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class UpdateProductDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class PriceRecurringDto {
  @ApiProperty({ enum: ['day', 'week', 'month', 'year'] })
  @IsIn(['day', 'week', 'month', 'year'])
  interval!: 'day' | 'week' | 'month' | 'year';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  intervalCount?: number;
}

export class CreatePriceDto {
  @ApiProperty({ description: 'ID do produto Stripe' })
  @IsString()
  product!: string;

  @ApiProperty({ description: 'Valor em centavos' })
  @IsInt()
  @IsPositive()
  unitAmount!: number;

  @ApiProperty({ description: 'Moeda ISO (ex: brl, usd)' })
  @IsString()
  currency!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nickname?: string;

  @ApiPropertyOptional({ type: PriceRecurringDto, description: 'Omitir = one-time' })
  @IsOptional()
  @ValidateNested()
  @Type(() => PriceRecurringDto)
  recurring?: PriceRecurringDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class CreateCouponDto {
  @ApiPropertyOptional({ description: 'ID customizado (vira o código)' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'Percentual 1-100' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  percentOff?: number;

  @ApiPropertyOptional({ description: 'Valor em centavos' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  amountOff?: number;

  @ApiPropertyOptional({ description: 'Obrigatório para amountOff' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ enum: ['once', 'repeating', 'forever'] })
  @IsIn(['once', 'repeating', 'forever'])
  duration!: 'once' | 'repeating' | 'forever';

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  durationInMonths?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  maxRedemptions?: number;

  @ApiPropertyOptional({ description: 'Unix timestamp (segundos)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  redeemBy?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class CreatePromotionCodeDto {
  @ApiProperty({ description: 'ID do coupon associado' })
  @IsString()
  coupon!: string;

  @ApiPropertyOptional({ description: 'Código que o cliente digita' })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  maxRedemptions?: number;

  @ApiPropertyOptional({ description: 'Unix timestamp' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  expiresAt?: number;

  @ApiPropertyOptional({ description: 'Só para clientes sem compra anterior' })
  @IsOptional()
  @IsBoolean()
  firstTimeTransaction?: boolean;

  @ApiPropertyOptional({ description: 'Valor mínimo em centavos' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  minimumAmount?: number;

  @ApiPropertyOptional({ description: 'Moeda do minimumAmount (default: brl)' })
  @IsOptional()
  @IsString()
  minimumAmountCurrency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class TogglePromotionCodeDto {
  @ApiProperty()
  @IsBoolean()
  active!: boolean;
}

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ default: true, description: 'true=cancelar no fim do período; false=imediato' })
  @IsOptional()
  @IsBoolean()
  atPeriodEnd?: boolean;
}
