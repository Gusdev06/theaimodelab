export const AVATAR_QUEUE = 'avatar';

export enum AvatarJobName {
  SUBMIT_TRAINING = 'submit-training',
  GENERATE_VIDEO = 'generate-video',
}

export interface SubmitTrainingJobData {
  userAvatarId: string;
  /** Determines which HeyGen endpoint to call. Defaults to 'photo' for backwards compat. */
  avatarType?: 'photo' | 'digital_twin';
}

/**
 * Generates a video using a trained avatar. The worker submits to HeyGen,
 * stores the returned video_id, and returns — completion is driven by the
 * HeyGen webhook (see HeyGenWebhookService.handleVideoEvent).
 * StuckGenerationsService is the safety net for missed webhook deliveries.
 */
export interface GenerateVideoJobData {
  userAvatarId: string;
  generationId: string;
  userId: string;
  creditsConsumed: number;
}

export type AvatarJobData = SubmitTrainingJobData | GenerateVideoJobData;
