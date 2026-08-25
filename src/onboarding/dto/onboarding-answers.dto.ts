import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ONBOARDING_CONTENT_MIX,
  ONBOARDING_MODEL_STATUS,
  ONBOARDING_PLATFORMS,
  ONBOARDING_ROLES,
  ONBOARDING_TOTAL_STEPS,
  ONBOARDING_WEEKLY_VOLUME,
  type OnboardingContentMix,
  type OnboardingModelStatus,
  type OnboardingPlatform,
  type OnboardingRole,
  type OnboardingWeeklyVolume,
} from '../onboarding.constants';

/**
 * Progresso parcial: gravado a cada resposta para medir drop-off por pergunta
 * e permitir retomar de onde parou depois de um refresh.
 */
export class SaveOnboardingProgressDto {
  @ApiPropertyOptional({ enum: ONBOARDING_ROLES })
  @IsOptional()
  @IsIn(ONBOARDING_ROLES)
  role?: OnboardingRole;

  @ApiPropertyOptional({ enum: ONBOARDING_PLATFORMS })
  @IsOptional()
  @IsIn(ONBOARDING_PLATFORMS)
  platform?: OnboardingPlatform;

  @ApiPropertyOptional({ enum: ONBOARDING_MODEL_STATUS })
  @IsOptional()
  @IsIn(ONBOARDING_MODEL_STATUS)
  modelStatus?: OnboardingModelStatus;

  @ApiPropertyOptional({ enum: ONBOARDING_CONTENT_MIX })
  @IsOptional()
  @IsIn(ONBOARDING_CONTENT_MIX)
  contentMix?: OnboardingContentMix;

  @ApiPropertyOptional({ enum: ONBOARDING_WEEKLY_VOLUME })
  @IsOptional()
  @IsIn(ONBOARDING_WEEKLY_VOLUME)
  weeklyVolume?: OnboardingWeeklyVolume;

  @ApiPropertyOptional({ minimum: 0, maximum: ONBOARDING_TOTAL_STEPS })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(ONBOARDING_TOTAL_STEPS)
  step?: number;
}

/** Conclusão: as cinco respostas são obrigatórias. */
export class CompleteOnboardingQuizDto {
  @ApiProperty({ enum: ONBOARDING_ROLES })
  @IsIn(ONBOARDING_ROLES)
  role: OnboardingRole;

  @ApiProperty({ enum: ONBOARDING_PLATFORMS })
  @IsIn(ONBOARDING_PLATFORMS)
  platform: OnboardingPlatform;

  @ApiProperty({ enum: ONBOARDING_MODEL_STATUS })
  @IsIn(ONBOARDING_MODEL_STATUS)
  modelStatus: OnboardingModelStatus;

  @ApiProperty({ enum: ONBOARDING_CONTENT_MIX })
  @IsIn(ONBOARDING_CONTENT_MIX)
  contentMix: OnboardingContentMix;

  @ApiProperty({ enum: ONBOARDING_WEEKLY_VOLUME })
  @IsIn(ONBOARDING_WEEKLY_VOLUME)
  weeklyVolume: OnboardingWeeklyVolume;
}
