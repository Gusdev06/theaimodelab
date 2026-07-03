export const EMAIL_BROADCAST_QUEUE = 'email-broadcast';

export enum EmailBroadcastJobName {
  SEND = 'send',
}

export interface EmailBroadcastJobData {
  broadcastId: string;
}

export const EMAIL_BROADCAST_BATCH_SIZE = 100;
export const EMAIL_BROADCAST_BATCH_DELAY_MS = 250;
