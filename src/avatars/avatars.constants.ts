/**
 * Default training cost in credits by avatar type.
 *  - photo: faster + cheaper to create on HeyGen (single image).
 *  - digital_twin: requires video footage; HeyGen charges more.
 *
 * Overridable via AVATAR_TRAINING_CREDITS_PHOTO / AVATAR_TRAINING_CREDITS_DIGITAL_TWIN.
 */
export const DEFAULT_AVATAR_TRAINING_CREDITS: Record<'photo' | 'digital_twin', number> = {
  photo: 1250,
  digital_twin: 2000,
};

/**
 * Hard timeout (minutes) for an avatar in TRAINING/PENDING_CONSENT before the
 * cron marks it FAILED and refunds. Should comfortably exceed HeyGen's typical SLA.
 */
export const DEFAULT_AVATAR_TRAINING_TIMEOUT_MIN = 90;

/**
 * Min/max source video duration accepted at upload time.
 * HeyGen accepts footage between 15s and 10min; we use 20s-5min as our window.
 */
export const AVATAR_SOURCE_MIN_DURATION_S = 20;
export const AVATAR_SOURCE_MAX_DURATION_S = 300;

/**
 * Max source video size (bytes). HeyGen accepts larger but we cap to keep
 * upload fast and reduce R2 cost.
 */
export const AVATAR_SOURCE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

/**
 * Per-second credit rates for avatar→video, by output resolution. Same rate
 * applies to both avatar_iv and avatar_v engines (HeyGen charges similarly).
 *
 * Pricing target: ~30% margin even on the cheapest plan (Studio), based on
 * HeyGen self-serve ($0.05–$0.0833/sec) at R$5,67/USD.
 */
export const AVATAR_VIDEO_CREDITS_PER_SECOND: Record<string, number> = {
  '720p': 50,
  '1080p': 70,
  '4k': 90,
};

/**
 * Effective characters-per-second when computing the upfront estimate from
 * the script length. PT-BR voices typically speak at ~12.5 cps; we divide by
 * a slightly slower value to bake in a safety buffer (~15%) so the estimate
 * tends to be HIGHER than reality. The webhook reconciles to the exact cost
 * once HeyGen reports the real duration.
 */
export const AVATAR_VIDEO_ESTIMATE_CHARS_PER_SEC = 11;

/** Minimum billable duration in seconds — guards against 1-2 word scripts. */
export const AVATAR_VIDEO_MIN_DURATION_SEC = 3;

/**
 * Compute the credit estimate at submit time, based on script length.
 * Returns an integer (always rounded up).
 */
export function estimateAvatarVideoCost(resolution: string, scriptLength: number): number {
  const rate = AVATAR_VIDEO_CREDITS_PER_SECOND[resolution] ?? AVATAR_VIDEO_CREDITS_PER_SECOND['1080p'];
  const seconds = Math.max(
    AVATAR_VIDEO_MIN_DURATION_SEC,
    Math.ceil(scriptLength / AVATAR_VIDEO_ESTIMATE_CHARS_PER_SEC),
  );
  return Math.ceil(seconds * rate);
}

/**
 * Compute the actual credit cost after the real duration is known (from the
 * HeyGen webhook). Used for reconciliation.
 */
export function actualAvatarVideoCost(resolution: string, durationSeconds: number): number {
  const rate = AVATAR_VIDEO_CREDITS_PER_SECOND[resolution] ?? AVATAR_VIDEO_CREDITS_PER_SECOND['1080p'];
  const billed = Math.max(AVATAR_VIDEO_MIN_DURATION_SEC, Math.ceil(durationSeconds));
  return Math.ceil(billed * rate);
}
