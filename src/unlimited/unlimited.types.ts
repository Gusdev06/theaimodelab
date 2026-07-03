import { Resolution } from '@prisma/client';

export interface PlanUnlimitedModel {
  modelVariant: string;
  resolutions: Resolution[];
}

export interface UnlimitedPlanContext {
  planId: string;
  planSlug: string;
  unlimitedPriority: number;
  models: PlanUnlimitedModel[];
}

export type UnlimitedDenyReason =
  | 'no_subscription'
  | 'plan_not_unlimited'
  | 'model_not_allowed'
  | 'hard_cap_reached'
  | 'lock_held';

export interface UnlimitedEligibility {
  allowed: boolean;
  reason?: UnlimitedDenyReason;
  planContext?: UnlimitedPlanContext;
  /** Delay em ms a aplicar no BullMQ job. 0 quando dentro do tier inicial. */
  delayMs: number;
  /** Gerações ilimitadas nas últimas 24h (sliding window). */
  usageCount: number;
}
