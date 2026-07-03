import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PurchaseCreditsDto {
  @ApiProperty({ description: 'ID of the credit package to purchase' })
  @IsString()
  @IsNotEmpty()
  packageId: string;

  @ApiPropertyOptional({ example: 'BRL', enum: ['BRL', 'USD', 'EUR'] })
  @IsOptional()
  @IsIn(['BRL', 'USD', 'EUR'])
  currency?: string;
}
