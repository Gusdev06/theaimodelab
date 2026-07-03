/**
 * Maximum number of saved voice profiles per plan slug.
 * Plans not listed here fall back to 0.
 */
export const VOICE_PROFILE_QUOTAS: Record<string, number> = {
  free: 0,
  'ultra-basic': 1,
  starter: 3,
  basic: 5,
  creator: 8,
  pro: 12,
  advanced: 15,
  studio: 15,
};

export const FREE_PLAN_VOICE_QUOTA = VOICE_PROFILE_QUOTAS.free;

export const VOICE_NAME_MIN_LENGTH = 1;
export const VOICE_NAME_MAX_LENGTH = 40;
