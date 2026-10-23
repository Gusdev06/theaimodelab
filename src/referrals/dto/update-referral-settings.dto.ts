import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_REFERRAL_REWARD_CREDITS } from '../referrals.service';

export class UpdateReferralSettingsDto {
  /** Créditos por indicação paga; 0 desliga (e o link deixa de atribuir). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_REFERRAL_REWARD_CREDITS)
  rewardCredits?: number;

  /** Indicações pagas por indicador antes de as próximas irem para revisão; 0 = todas para revisão. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  maxRewardsPerReferrer?: number;

  /** Indicações pagas por indicador em 24 h; o excedente espera o dia seguinte. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  maxRewardsPerDay?: number;

  /** Indicações pagas na plataforma em 24 h; acima disso, revisão. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxRewardsGlobalPerDay?: number;
}
