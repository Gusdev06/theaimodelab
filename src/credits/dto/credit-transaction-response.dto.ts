import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreditTransactionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  type: string;

  @ApiProperty({ description: 'Positive = credit, negative = debit' })
  amount: number;

  @ApiProperty({ description: 'plan or bonus' })
  source: string;

  @ApiPropertyOptional()
  description: string | null;

  @ApiPropertyOptional()
  generationId: string | null;

  @ApiPropertyOptional()
  paymentId: string | null;

  @ApiProperty()
  createdAt: Date;
}
