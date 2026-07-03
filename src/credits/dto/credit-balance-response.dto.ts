import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FreeGenerationType } from '@prisma/client';

export type FreeGenerationsMap = Record<FreeGenerationType, number>;

export class CreditBalanceResponseDto {
  @ApiProperty()
  planCreditsRemaining: number;

  @ApiProperty()
  bonusCreditsRemaining: number;

  @ApiProperty()
  totalCreditsAvailable: number;

  @ApiProperty()
  planCreditsUsed: number;

  @ApiProperty({
    description: 'Gerações gratuitas disponíveis por tipo',
    example: {
      NB2: 1,
      NB_PRO: 1,
      FACE_SWAP: 1,
      VIRTUAL_TRY_ON: 1,
      THEAIMODELAB_FAST: 1,
      UPSCALE: 1,
    },
  })
  freeGenerations: FreeGenerationsMap;

  @ApiPropertyOptional()
  periodStart: Date | null;

  @ApiPropertyOptional()
  periodEnd: Date | null;
}
