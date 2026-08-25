import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  OnboardingContentMix,
  OnboardingFirstRun,
  OnboardingModelStatus,
  OnboardingPlanSlug,
  OnboardingPlatform,
  OnboardingRole,
  OnboardingSegment,
  OnboardingWeeklyVolume,
} from '../onboarding.constants';

export class StarterKitItemDto {
  @ApiProperty({ description: 'Tipo de geração grátis concedido.' })
  type: string;

  @ApiProperty() amount: number;
}

export class OnboardingProfileResponseDto {
  @ApiProperty() completed: boolean;

  @ApiProperty({ description: 'Última pergunta alcançada (0 = nem começou).' })
  lastStepReached: number;

  @ApiProperty() totalSteps: number;

  @ApiPropertyOptional() role?: OnboardingRole | null;
  @ApiPropertyOptional() platform?: OnboardingPlatform | null;
  @ApiPropertyOptional() modelStatus?: OnboardingModelStatus | null;
  @ApiPropertyOptional() contentMix?: OnboardingContentMix | null;
  @ApiPropertyOptional() weeklyVolume?: OnboardingWeeklyVolume | null;

  @ApiPropertyOptional() segment?: OnboardingSegment | null;

  @ApiPropertyOptional({
    description: 'Rota de ativação: o que o app abre ao fechar o quiz.',
  })
  firstRun?: OnboardingFirstRun | null;

  @ApiPropertyOptional() recommendedPlan?: OnboardingPlanSlug | null;
  @ApiPropertyOptional() estimatedMonthlyCredits?: number | null;

  @ApiPropertyOptional({
    description:
      'Volume declarado excede o maior plano; exige pacotes avulsos.',
  })
  exceedsTopPlan?: boolean;

  @ApiProperty({ type: [StarterKitItemDto] })
  starterKit: StarterKitItemDto[];

  @ApiProperty({ description: 'Kit já foi concedido a este usuário.' })
  starterKitGranted: boolean;

  @ApiPropertyOptional() activatedAt?: string | null;
}
