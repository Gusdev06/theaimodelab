import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min, NotEquals } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdjustCreditsDto {
  @ApiProperty({
    description: 'Amount to adjust (positive to add, negative to remove)',
    example: 100,
  })
  @IsInt()
  @IsNotEmpty()
  @NotEquals(0)
  // Teto por ajuste = 1 mês do maior plano (Agency, 200 mil). Mais que isso é
  // erro de digitação ou abuso (TKT-106).
  @Min(-200_000)
  @Max(200_000)
  amount: number;

  @ApiProperty({
    description: 'Reason for the adjustment',
    example: 'Compensação por erro na geração',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;
}
