import { ApiProperty } from '@nestjs/swagger';

export class GenerationsByStatusDto {
  @ApiProperty()
  pending: number;

  @ApiProperty()
  processing: number;

  @ApiProperty()
  completed: number;

  @ApiProperty()
  failed: number;
}

export class KieBreakdownDto {
  @ApiProperty({ description: 'Generations using Nano Banana 2' })
  nanoBanana2: number;

  @ApiProperty({ description: 'Generations using Nano Banana Pro' })
  nanoBananaPro: number;

  @ApiProperty({ description: 'Generations using Kling 2.6 Motion Control' })
  kling: number;
}

export class GenerationsByProviderDto {
  @ApiProperty({ description: 'Generations via The AI Model Lab provider (Gemini/Veo)' })
  theaimodelab: number;

  @ApiProperty({ description: 'Generations via KIE API (Nano Banana/Kling)' })
  kie: number;

  @ApiProperty({ description: 'Breakdown of KIE API generations by model' })
  kieBreakdown: KieBreakdownDto;
}

export class AdminStatsResponseDto {
  @ApiProperty()
  totalUsers: number;

  @ApiProperty()
  activeSubscriptions: number;

  @ApiProperty({ description: 'Total revenue in cents (BRL)' })
  totalRevenueCents: number;

  @ApiProperty()
  totalGenerations: number;

  @ApiProperty()
  generationsByStatus: GenerationsByStatusDto;

  @ApiProperty()
  generationsByProvider: GenerationsByProviderDto;
}
