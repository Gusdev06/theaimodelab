import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePixAutoSubscriptionDto {
  @ApiProperty({ description: 'Slug do plano (ex: starter, pro)' })
  @IsString()
  @IsNotEmpty()
  planSlug: string;

  @ApiPropertyOptional({
    description:
      'CPF (11 dígitos) ou CNPJ (14 dígitos) do pagador, sem máscara. Obrigatório apenas na PRIMEIRA compra PIX do usuário.',
    example: '12345678909',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{11}$|^\d{14}$/, {
    message: 'taxId deve conter 11 (CPF) ou 14 (CNPJ) dígitos numéricos',
  })
  taxId?: string;
}
