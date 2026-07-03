import { IsEnum, IsInt, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { FreeGenerationType } from '@prisma/client';

export class AdjustFreeGenerationsDto {
  @ApiProperty({
    enum: FreeGenerationType,
    description: 'Tipo de geração grátis a ajustar',
  })
  @IsEnum(FreeGenerationType)
  type: FreeGenerationType;

  @ApiProperty({
    description: 'Quantidade (valor absoluto) de gerações grátis a definir',
    example: 1,
  })
  @IsInt()
  @Min(0)
  amount: number;
}
