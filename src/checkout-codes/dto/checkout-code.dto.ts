import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BRAND_KEYS } from '../../brand/brand';
import { CHECKOUT_CURRENCIES, CHECKOUT_GATEWAYS } from '../checkout-codes';

export class CreateCheckoutCodeDto {
  @ApiProperty({ enum: CHECKOUT_GATEWAYS })
  @IsIn(CHECKOUT_GATEWAYS as unknown as string[])
  gateway: string;

  @ApiProperty({
    description:
      'Código que chega no webhook. Perfect Pay: plan.code do postback (ex.: PPLQQPTQU) ou o código do link; Cakto: a oferta. Aceita o link inteiro.',
    example: 'PPLQQPTQU',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  code: string;

  @ApiPropertyOptional({ enum: BRAND_KEYS, default: 'taml' })
  @IsOptional()
  @IsIn(BRAND_KEYS as unknown as string[])
  brand?: string;

  @ApiProperty({ enum: CHECKOUT_CURRENCIES, description: 'USD/EUR = planos na Perfect Pay; BRL = Cakto' })
  @IsIn(CHECKOUT_CURRENCIES as unknown as string[])
  currency: string;

  @ApiPropertyOptional({ description: 'Link da vitrine da marca (https). Vazio = só reconhece a venda.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  checkoutUrl?: string | null;

  @ApiPropertyOptional({ example: 'cnpj-brain2' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  account?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string | null;

  @ApiPropertyOptional({ description: 'Plano (informe plano OU pacote)' })
  @IsOptional()
  @IsString()
  planId?: string;

  @ApiPropertyOptional({ description: 'Pacote de créditos (informe plano OU pacote)' })
  @IsOptional()
  @IsString()
  creditPackageId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Gateway, código e alvo não mudam: para trocar, apague e crie outro. */
export class UpdateCheckoutCodeDto {
  @ApiPropertyOptional({ enum: BRAND_KEYS })
  @IsOptional()
  @IsIn(BRAND_KEYS as unknown as string[])
  brand?: string;

  @ApiPropertyOptional({ enum: CHECKOUT_CURRENCIES })
  @IsOptional()
  @IsIn(CHECKOUT_CURRENCIES as unknown as string[])
  currency?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  checkoutUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  account?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
