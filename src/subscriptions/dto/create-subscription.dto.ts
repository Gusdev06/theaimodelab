import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSubscriptionDto {
  @ApiProperty({ example: 'starter' })
  @IsString()
  @IsNotEmpty()
  planSlug: string;

  @ApiPropertyOptional({ example: 'BRL', enum: ['BRL', 'USD', 'EUR'] })
  @IsOptional()
  @IsIn(['BRL', 'USD', 'EUR'])
  currency?: string;

  /**
   * Cupom da campanha de recuperação de churn (link de email).
   * Whitelistado server-side — usuário comum não pode injetar promo arbitrário.
   * Para cupons digitados pelo user, o Stripe Checkout já aceita via
   * allow_promotion_codes (configurado no createSubscriptionCheckout).
   */
  @ApiPropertyOptional({ example: 'RECOVERY20', description: 'Cupom de recuperação aplicado via link de email' })
  @IsOptional()
  @IsString()
  @IsIn(['RECOVERY20'])
  recoveryPromoCode?: string;
}
