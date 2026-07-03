import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListQueryDto {
  @ApiPropertyOptional({ description: 'Itens por página (1-100)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Cursor Stripe: pega itens depois deste ID' })
  @IsOptional()
  @IsString()
  starting_after?: string;

  @ApiPropertyOptional({ description: 'Cursor Stripe: pega itens antes deste ID' })
  @IsOptional()
  @IsString()
  ending_before?: string;
}

export class ChargeListQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Filtra por customer ID' })
  @IsOptional()
  @IsString()
  customer?: string;
}

export class CustomerListQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Busca exata por email' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ description: 'Query Stripe search (ex: email:"a@b.com")' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class ProductListQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Filtra por ativo/arquivado' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

export class PriceListQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ description: 'Filtra por product ID' })
  @IsOptional()
  @IsString()
  product?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

export class SubscriptionListQueryDto extends ListQueryDto {
  @ApiPropertyOptional({
    description: 'Status: active, canceled, past_due, trialing, paused, unpaid, incomplete, incomplete_expired, all',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Filtra por customer ID' })
  @IsOptional()
  @IsString()
  customer?: string;

  @ApiPropertyOptional({ description: 'Filtra por price ID' })
  @IsOptional()
  @IsString()
  priceId?: string;
}

export class InvoiceListQueryDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customer?: string;

  @ApiPropertyOptional({ description: 'Status: draft, open, paid, uncollectible, void' })
  @IsOptional()
  @IsString()
  status?: string;
}

export class PromotionCodeListQueryDto extends ListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coupon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}
