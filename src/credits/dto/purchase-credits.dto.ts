import { Type } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional, IsIn, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MetaEventContextDto } from '../../meta/meta-event-context.dto';

export class PurchaseCreditsDto {
  @ApiProperty({ description: 'ID of the credit package to purchase' })
  @IsString()
  @IsNotEmpty()
  packageId: string;

  @ApiPropertyOptional({ example: 'BRL', enum: ['BRL', 'USD', 'EUR'] })
  @IsOptional()
  @IsIn(['BRL', 'USD', 'EUR'])
  currency?: string;

  @ApiPropertyOptional({ description: 'Meta browser event context for InitiateCheckout deduplication' })
  @IsOptional()
  @ValidateNested()
  @Type(() => MetaEventContextDto)
  meta?: MetaEventContextDto;
}
