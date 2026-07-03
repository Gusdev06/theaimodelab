import { IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdjustCreditsDto {
  @ApiProperty({
    description: 'Amount to adjust (positive to add, negative to remove)',
    example: 100,
  })
  @IsInt()
  @IsNotEmpty()
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
