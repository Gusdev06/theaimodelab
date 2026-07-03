import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AvatarStatus, UserAvatar } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditsService } from '../../credits/credits.service';
import { HeyGenProvider } from '../providers/heygen.provider';
import { AvatarsService } from '../avatars.service';
import { AvatarEventsService } from '../avatar-events.service';
import { DEFAULT_AVATAR_TRAINING_TIMEOUT_MIN } from '../avatars.constants';

/**
 * Reconciliation cron — covers two failure modes the webhook can't handle:
 *   1. Webhook never arrives (delivery failure on HeyGen's side)
 *   2. Worker crashed mid-submit, leaving avatar stuck in SUBMITTING
 *
 * Runs every 5 min. For each avatar in SUBMITTING / PENDING_CONSENT / TRAINING:
 *   - If stuck for less than HARD_TIMEOUT, polls HeyGen and reconciles state
 *   - If stuck for more than HARD_TIMEOUT, marks FAILED + refunds credits
 */
@Injectable()
export class StuckAvatarsService {
  private readonly logger = new Logger(StuckAvatarsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditsService: CreditsService,
    private readonly heygen: HeyGenProvider,
    private readonly avatars: AvatarsService,
    private readonly events: AvatarEventsService,
    private readonly configService: ConfigService,
  ) {}

  @Cron('* * * * *') // every minute
  async handleStuckAvatars(): Promise<void> {
    try {
      const hardTimeoutMin = this.getHardTimeoutMin();
      const hardThreshold = new Date(Date.now() - hardTimeoutMin * 60_000);
      // Start polling 30s after submission — Photo Avatar finishes in seconds,
      // Digital Twin in minutes. Aggressive polling to keep UX snappy.
      const pollThreshold = new Date(Date.now() - 30_000);

      const stuck = await this.prisma.userAvatar.findMany({
        where: {
          isDeleted: false,
          status: { in: [AvatarStatus.SUBMITTING, AvatarStatus.TRAINING] },
          OR: [
            { trainingStartedAt: { lt: pollThreshold } },
            { trainingStartedAt: null, createdAt: { lt: pollThreshold } },
          ],
        },
      });

      this.logger.log(`[stuck-avatars] tick — found ${stuck.length} avatar(s) to poll`);

      if (stuck.length === 0) return;

      for (const avatar of stuck) {
        try {
          const startedAt = avatar.trainingStartedAt ?? avatar.createdAt;
          if (startedAt < hardThreshold) {
            await this.failAndRefund(avatar, 'Treinamento expirou por timeout (90 min).');
            continue;
          }
          await this.reconcile(avatar);
        } catch (err) {
          this.logger.error(
            `[stuck-avatars] failed to reconcile ${avatar.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `[stuck-avatars] cron failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async reconcile(avatar: UserAvatar): Promise<void> {
    if (!avatar.heygenGroupId) {
      // Stuck before HeyGen ever responded — likely worker crashed pre-call.
      // Cron alone can't recover this; we leave it to hard timeout to refund.
      this.logger.log(
        `[stuck-avatars] ${avatar.id} has no heygenGroupId yet, skipping until hard timeout`,
      );
      return;
    }

    const snapshot = await this.heygen.getAvatarGroup(avatar.heygenGroupId);

    this.logger.log(
      `[stuck-avatars] snapshot avatar=${avatar.id} group=${avatar.heygenGroupId} status=${snapshot.status} consent=${snapshot.consentStatus} looks=${snapshot.looks.length}`,
    );

    if (snapshot.status === 'failed' || snapshot.errorCode) {
      await this.failAndRefund(
        avatar,
        snapshot.errorMessage ?? 'Treinamento falhou na HeyGen.',
        snapshot.errorCode ?? null,
      );
      return;
    }

    if (snapshot.status === 'completed') {
      const primaryLook =
        snapshot.looks.find((l) => l.lookId === avatar.heygenLookId) ?? snapshot.looks[0] ?? null;

      // The id returned by POST /v3/avatars can be a placeholder until the
      // look finishes rendering. Once we have a real look from /v3/avatars/looks,
      // overwrite heygenLookId so POST /v3/videos receives the correct id.
      const resolvedLookId = primaryLook?.lookId ?? avatar.heygenLookId;
      if (primaryLook && primaryLook.lookId !== avatar.heygenLookId) {
        this.logger.log(
          `[stuck-avatars] resolving heygenLookId for ${avatar.id}: ${avatar.heygenLookId} → ${primaryLook.lookId}`,
        );
      }

      const updated = await this.prisma.userAvatar.update({
        where: { id: avatar.id },
        data: {
          status: AvatarStatus.READY,
          trainingCompletedAt: new Date(),
          heygenLookId: resolvedLookId,
          // Group-level fields are used as fallback because the per-look
          // payload from /v3/avatars/looks can come back with null voice
          // for newly-trained photo/digital_twin avatars, while the group
          // itself carries default_voice_id and preview_image_url.
          previewImageUrl:
            primaryLook?.previewImageUrl ??
            snapshot.groupPreviewImageUrl ??
            avatar.previewImageUrl,
          previewVideoUrl: primaryLook?.previewVideoUrl ?? avatar.previewVideoUrl,
          defaultVoiceId:
            primaryLook?.defaultVoiceId ??
            snapshot.groupDefaultVoiceId ??
            avatar.defaultVoiceId,
          supportedEngines: primaryLook?.supportedEngines ?? avatar.supportedEngines,
        },
      });
      this.events.emit({
        userId: avatar.userId,
        userAvatarId: avatar.id,
        status: AvatarStatus.READY,
        consentStatus: updated.consentStatus,
      });
      this.logger.log(`[stuck-avatars] recovered ${avatar.id} as READY`);
      return;
    }

    // Still processing — make sure our local status reflects TRAINING
    if (avatar.status !== AvatarStatus.TRAINING) {
      await this.prisma.userAvatar.update({
        where: { id: avatar.id },
        data: { status: AvatarStatus.TRAINING },
      });
      this.events.emit({
        userId: avatar.userId,
        userAvatarId: avatar.id,
        status: AvatarStatus.TRAINING,
        consentStatus: avatar.consentStatus,
      });
    }
  }

  private async failAndRefund(
    avatar: UserAvatar,
    errorMessage: string,
    errorCode: string | null = null,
  ): Promise<void> {
    await this.prisma.userAvatar.update({
      where: { id: avatar.id },
      data: {
        status: AvatarStatus.FAILED,
        errorMessage: errorMessage.slice(0, 500),
        errorCode: errorCode?.slice(0, 100),
      },
    });
    await this.creditsService
      .refundForAvatar(avatar.userId, avatar.id, avatar.creditsConsumed)
      .catch((err) => {
        this.logger.error(
          `[stuck-avatars] refund failed for ${avatar.id}: ${err instanceof Error ? err.message : err}`,
        );
      });
    this.events.emit({
      userId: avatar.userId,
      userAvatarId: avatar.id,
      status: AvatarStatus.FAILED,
      data: { errorMessage, errorCode },
    });
    this.logger.warn(`[stuck-avatars] marked ${avatar.id} FAILED + refunded ${avatar.creditsConsumed}cr`);
  }

  private getHardTimeoutMin(): number {
    const raw = this.configService.get<string>('AVATAR_TRAINING_TIMEOUT_MIN');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AVATAR_TRAINING_TIMEOUT_MIN;
  }

}
