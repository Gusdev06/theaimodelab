import { IsString, IsOptional, IsInt, Min, Max, IsEnum, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AffiliateDiscountScope } from '@prisma/client';

export class UpdateAffiliateDto {
  @ApiPropertyOptional({ example: 'Maria Silva', description: 'Nome do afiliado' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 30, description: 'Percentual de comissão' })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  commissionPercent?: number;

  @ApiPropertyOptional({ description: 'ID do usuário associado (null para remover)' })
  @IsString()
  @IsOptional()
  userId?: string | null;

  @ApiPropertyOptional({
    example: 10,
    description: 'Percentual de desconto para quem se registra pelo link. Envie null para remover.',
    nullable: true,
  })
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  discountPercent?: number | null;

  @ApiPropertyOptional({
    enum: AffiliateDiscountScope,
    description: 'Quando o desconto se aplica.',
  })
  @IsEnum(AffiliateDiscountScope)
  @IsOptional()
  discountAppliesTo?: AffiliateDiscountScope;
}
