import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AffiliateDiscountScope } from '@prisma/client';

export class CreateAffiliateDto {
  @ApiProperty({ example: 'Maria Silva', description: 'Nome do afiliado' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'MARIA30', description: 'Código único do afiliado (será convertido para uppercase)' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiPropertyOptional({ example: 30, description: 'Percentual de comissão (padrão: 30)' })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  commissionPercent?: number;

  @ApiPropertyOptional({ description: 'ID do usuário associado (opcional)' })
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiPropertyOptional({
    example: 10,
    description: 'Percentual de desconto para quem se registra pelo link (opcional).',
  })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  discountPercent?: number;

  @ApiPropertyOptional({
    enum: AffiliateDiscountScope,
    description: 'Quando o desconto se aplica: FIRST_PURCHASE (só primeira compra) ou ALL_PURCHASES (todas).',
  })
  @IsEnum(AffiliateDiscountScope)
  @IsOptional()
  discountAppliesTo?: AffiliateDiscountScope;
}
