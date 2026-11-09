import { IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ListUserPaymentsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PaymentStatus, description: 'Status do pagamento' })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;
}
