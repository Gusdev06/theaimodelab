import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const VALID_REASONS = [
  'expensive',
  'not_using',
  'quality',
  'competitor',
  'temporary',
  'other',
] as const;

export class AcceptOfferDto {
  @ApiProperty({
    description: 'Motivo selecionado pelo usuario',
    enum: VALID_REASONS,
  })
  @IsString()
  @IsIn(VALID_REASONS)
  reason: string;
}
