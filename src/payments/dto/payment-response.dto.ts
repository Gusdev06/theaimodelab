import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PaymentResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty() type: string;
  @ApiProperty() amountCents: number;
  @ApiProperty() currency: string;
  @ApiProperty() status: string;
  @ApiProperty() provider: string;
  @ApiPropertyOptional() externalPaymentId: string | null;
  @ApiPropertyOptional() externalInvoiceId: string | null;
  @ApiPropertyOptional() subscriptionId: string | null;
  @ApiPropertyOptional() creditPackageId: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
