import { IsNumber, IsPositive, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateFxDto {
  @ApiProperty({
    description: 'Câmbio USD→BRL usado nas estatísticas consolidadas (maior que 0 e menor que 100)',
    example: 5.4,
  })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 })
  @IsPositive()
  @Max(99.9999)
  fxUsdBrl: number;
}
