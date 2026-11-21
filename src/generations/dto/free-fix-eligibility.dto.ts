import { ApiProperty } from '@nestjs/swagger';
import type { FreeFixReason } from '../../credits/free-fix.service';

export class FreeFixEligibilityResponseDto {
  @ApiProperty({
    description: 'A correção desta foto no Unlocked sai grátis (1ª correção)',
  })
  eligible: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Motivo quando não sai grátis (disabled, not_found, origin_not_completed, origin_not_unlocked, origin_not_image, origin_too_old, origin_not_paid, origin_already_fixed, daily_limit, annual_plan, monthly_cap); null quando sai.',
  })
  reason: FreeFixReason | null;
}
