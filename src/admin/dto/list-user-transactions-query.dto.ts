import { IsEnum, IsISO8601, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreditTransactionType } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class ListUserTransactionsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: CreditTransactionType, description: 'Tipo de movimentação' })
  @IsOptional()
  @IsEnum(CreditTransactionType)
  type?: CreditTransactionType;

  @ApiPropertyOptional({
    description: 'A partir de (ISO 8601; só a data vale desde 00:00 UTC)',
    example: '2026-11-01',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Até (ISO 8601; só a data vale até 23:59:59 UTC)',
    example: '2026-11-06',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  endDate?: string;
}
