import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AvatarStatus, GenerationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditsService } from '../../credits/credits.service';
import { UploadsService } from '../../uploads/uploads.service';
import { HeyGenProvider } from '../providers/heygen.provider';
import { AvatarsService } from '../avatars.service';
import { AvatarEventsService } from '../avatar-events.service';
import { actualAvatarVideoCost } from '../avatars.constants';

/**
 * HeyGen v3 webhook event payloads. Shape based on docs.heygen.com — extra
 * fields are tolerated (we only read what we use).
 */
export interface HeyGenWebhookEvent {
  event_type: string;
  event_data: {
    avatar_id?: string;
    avatar_group_id?: string;
    video_id?: string;
    callback_id?: string;
    status?: string;
    msg?: string;
    error?: { code?: string; message?: string };
    video_url?: string;
    thumbnail_url?: string;
    duration?: number;
  };
}

@Injectable()
export class HeyGenWebhookService {
  private readonly logger = new Logger(HeyGenWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditsService: CreditsService,
    private readonly uploadsService: UploadsService,
    private readonly heygen: HeyGenProvider,
    private readonly avatarsService: AvatarsService,
    private readonly events: AvatarEventsService,
  ) {}

  /**
   * Idempotent webhook handler.
   *  - Persists raw event in WebhookLog (unique on externalId+event_type via app-level dedupe)
   *  - Routes to the right reducer
   *  - Always returns silently — caller should respond 200 to HeyGen
   */
  async handle(event: HeyGenWebhookEvent, rawPayload: unknown): Promise<void> {
    const externalId = this.buildExternalId(event);

    // App-level idempotency: skip if we've already processed this exact event
    const existing = await this.prisma.webhookLog.findFirst({
      where: { provider: 'heygen', eventType: event.event_type, externalId, processed: true },
      select: { id: true },
    });
    if (existing) {
      this.logger.log(`[heygen-webhook] duplicate event_type=${event.event_type} externalId=${externalId}, skipping`);
      return;
    }

    const log = await this.prisma.webhookLog.create({
      data: {
        provider: 'heygen',
        eventType: event.event_type,
        externalId,
        payload: rawPayload as Prisma.InputJsonValue,
      },
    });

    try {
      await this.route(event);
      await this.prisma.webhookLog.update({
        where: { id: log.id },
        data: { processed: true },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[heygen-webhook] handler failed event_type=${event.event_type} externalId=${externalId}: ${errorMessage}`,
      );
      await this.prisma.webhookLog
        .update({
          where: { id: log.id },
          data: { error: errorMessage.slice(0, 1000) },
        })
        .catch(() => {});
      throw err;
    }
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  private async route(event: HeyGenWebhookEvent): Promise<void> {
    const type = event.event_type;

    // Avatar lifecycle — HeyGen splits this into several event families:
    //   - instant_avatar.*           → Digital Twin (video-trained avatar)
    //   - photo_avatar_train.*       → Photo Avatar training step
    //   - photo_avatar_generation.*  → Photo Avatar initial generation
    //   - avatar.* / digital_twin    → legacy/generic, kept for safety
    if (
      type.startsWith('instant_avatar.') ||
      type.startsWith('photo_avatar_train.') ||
      type.startsWith('photo_avatar_generation.') ||
      type.startsWith('avatar.') ||
      type.includes('digital_twin')
    ) {
      return this.handleAvatarEvent(event);
    }

    // Video generation lifecycle (avatar_video.success / .fail)
    if (type.startsWith('avatar_video.') || type.startsWith('video.')) {
      return this.handleVideoEvent(event);
    }

    this.logger.warn(`[heygen-webhook] unhandled event_type=${type}`);
  }

  private async handleAvatarEvent(event: HeyGenWebhookEvent): Promise<void> {
    const groupId = event.event_data.avatar_group_id ?? event.event_data.avatar_id;
    if (!groupId) {
      this.logger.warn('[heygen-webhook] avatar event without avatar_group_id/avatar_id, skipping');
      return;
    }

    const avatar = await this.prisma.userAvatar.findFirst({
      where: { OR: [{ heygenGroupId: groupId }, { heygenLookId: groupId }] },
    });
    if (!avatar) {
      this.logger.warn(`[heygen-webhook] avatar not found for groupId=${groupId}`);
      return;
    }

    const isFailure =
      event.event_type.includes('fail') || event.event_data.status === 'failed';
    const isSuccess =
      event.event_type.includes('success') ||
      event.event_type.includes('complete') ||
      event.event_data.status === 'completed';

    if (isFailure) {
      const errorMessage =
        event.event_data.error?.message ?? event.event_data.msg ?? 'Treinamento falhou na HeyGen.';
      const errorCode = event.event_data.error?.code ?? null;

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
            `refund failed for avatar ${avatar.id}: ${err instanceof Error ? err.message : err}`,
          );
        });
      this.events.emit({
        userId: avatar.userId,
        userAvatarId: avatar.id,
        status: AvatarStatus.FAILED,
        data: { errorMessage, errorCode },
      });
      return;
    }

    if (isSuccess && avatar.heygenGroupId) {
      // Pull authoritative snapshot from HeyGen — webhook payloads sometimes
      // omit look details, and we want the engines/voice cached.
      const snapshot = await this.heygen.getAvatarGroup(avatar.heygenGroupId).catch((err) => {
        this.logger.warn(
          `[heygen-webhook] getAvatarGroup failed for ${avatar.heygenGroupId}: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });

      const primaryLook = snapshot?.looks.find((l) => l.lookId === avatar.heygenLookId)
        ?? snapshot?.looks[0]
        ?? null;

      // The id we saved at create time can be a placeholder until the look
      // finishes rendering — overwrite with the real one once we have it.
      const resolvedLookId = primaryLook?.lookId ?? avatar.heygenLookId;

      const updated = await this.prisma.userAvatar.update({
        where: { id: avatar.id },
        data: {
          status: AvatarStatus.READY,
          trainingCompletedAt: new Date(),
          heygenLookId: resolvedLookId,
          // Group-level fields fall back when the look returns nulls (common
          // for newly-trained photo/digital_twin avatars).
          previewImageUrl:
            primaryLook?.previewImageUrl ??
            snapshot?.groupPreviewImageUrl ??
            avatar.previewImageUrl,
          previewVideoUrl: primaryLook?.previewVideoUrl ?? avatar.previewVideoUrl,
          defaultVoiceId:
            primaryLook?.defaultVoiceId ??
            snapshot?.groupDefaultVoiceId ??
            avatar.defaultVoiceId,
          supportedEngines: primaryLook?.supportedEngines ?? avatar.supportedEngines,
        },
      });

      this.events.emit({
        userId: avatar.userId,
        userAvatarId: avatar.id,
        status: AvatarStatus.READY,
        consentStatus: updated.consentStatus,
        data: { previewImageUrl: updated.previewImageUrl },
      });
    }
  }

  private async handleVideoEvent(event: HeyGenWebhookEvent): Promise<void> {
    const videoId = event.event_data.video_id;
    const callbackId = event.event_data.callback_id;
    if (!videoId && !callbackId) {
      this.logger.warn('[heygen-webhook] video event without video_id/callback_id, skipping');
      return;
    }

    // Locate the Generation either by heygen video_id (primary) or by the
    // callback_id we echoed back (== generation.id, fallback).
    const generation = videoId
      ? await this.prisma.generation.findUnique({ where: { heygenVideoId: videoId } })
      : callbackId
        ? await this.prisma.generation.findUnique({ where: { id: callbackId } })
        : null;

    if (!generation) {
      this.logger.warn(
        `[heygen-webhook] generation not found video_id=${videoId} callback_id=${callbackId}`,
      );
      return;
    }

    // Idempotency guard: if we already finished this Generation (success or
    // failure), the webhook is a duplicate — drop it.
    if (
      generation.status === GenerationStatus.COMPLETED ||
      generation.status === GenerationStatus.FAILED
    ) {
      this.logger.log(
        `[heygen-webhook] generation=${generation.id} already ${generation.status}, skipping`,
      );
      return;
    }

    const isFailure =
      event.event_type.includes('fail') || event.event_data.status === 'failed';
    const isSuccess =
      event.event_type.includes('success') ||
      event.event_type.includes('complete') ||
      event.event_data.status === 'completed';

    if (isFailure) {
      const errorMessage =
        event.event_data.error?.message ??
        event.event_data.msg ??
        'A HeyGen retornou o vídeo com falha.';
      const errorCode = event.event_data.error?.code ?? null;

      await this.prisma.generation.update({
        where: { id: generation.id },
        data: {
          status: GenerationStatus.FAILED,
          errorMessage: errorMessage.slice(0, 500),
          errorCode: errorCode?.slice(0, 100),
          completedAt: new Date(),
        },
      });
      await this.creditsService
        .refund(generation.userId, generation.creditsConsumed, generation.id)
        .catch((err) => {
          this.logger.error(
            `[heygen-webhook] refund failed for gen ${generation.id}: ${err instanceof Error ? err.message : err}`,
          );
        });
      this.logger.warn(
        `[heygen-webhook] video failed gen=${generation.id} error="${errorMessage}"`,
      );
      return;
    }

    if (!isSuccess) {
      this.logger.log(
        `[heygen-webhook] video intermediate event gen=${generation.id} type=${event.event_type} status=${event.event_data.status}`,
      );
      return;
    }

    // Success — payload may include video_url/thumbnail_url. If missing, fetch
    // the full video record from HeyGen as a fallback (some event payloads only
    // carry the ID).
    let videoUrl = event.event_data.video_url ?? null;
    let thumbnailUrl = event.event_data.thumbnail_url ?? null;
    let durationSeconds = event.event_data.duration ?? null;

    if (!videoUrl && videoId) {
      try {
        const status = await this.heygen.getVideoStatus(videoId);
        videoUrl = status.videoUrl;
        thumbnailUrl = status.thumbnailUrl;
        durationSeconds = status.durationSeconds;
      } catch (err) {
        this.logger.warn(
          `[heygen-webhook] getVideoStatus fallback failed for video=${videoId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (!videoUrl) {
      throw new Error(
        `Video success event arrived without a usable video_url for gen=${generation.id}`,
      );
    }

    // Copy media to R2 so the URL survives HeyGen URL expirations
    const persistentUrl = await this.uploadsService.uploadFromUrl(
      videoUrl,
      `generations/${generation.id}`,
      'output.mp4',
    );
    const persistentThumbnail = thumbnailUrl
      ? await this.uploadsService
          .uploadFromUrl(thumbnailUrl, `generations/${generation.id}`, 'thumb.jpg')
          .catch(() => null)
      : null;

    // Reconcile credits against the actual rendered duration. The initial debit
    // was an estimate based on script length; here we know the real duration.
    let realCost: number | null = null;
    if (typeof durationSeconds === 'number' && durationSeconds > 0) {
      const params =
        generation.parameters && typeof generation.parameters === 'object'
          ? (generation.parameters as Record<string, any>)
          : {};
      const resolution =
        typeof params.resolution === 'string' ? params.resolution : '1080p';
      realCost = actualAvatarVideoCost(resolution, durationSeconds);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.generationOutput.create({
        data: {
          generationId: generation.id,
          url: persistentUrl,
          thumbnailUrl: persistentThumbnail ?? undefined,
          mimeType: 'video/mp4',
          order: 0,
        },
      });
      await tx.generation.update({
        where: { id: generation.id },
        data: {
          status: GenerationStatus.COMPLETED,
          completedAt: new Date(),
          durationSeconds: durationSeconds ?? undefined,
          processingTimeMs: generation.processingStartedAt
            ? Date.now() - generation.processingStartedAt.getTime()
            : undefined,
          // Persist the reconciled (real) cost so the gallery + admin views
          // show the actual amount charged, not the upfront estimate.
          ...(realCost !== null && { creditsConsumed: realCost }),
        },
      });
    });

    if (realCost !== null) {
      const delta = generation.creditsConsumed - realCost; // positive = refund, negative = extra debit
      if (delta !== 0) {
        await this.creditsService
          .adjustGenerationCost(
            generation.userId,
            generation.id,
            delta,
            `Ajuste de duração (${durationSeconds!.toFixed(1)}s reais)`,
          )
          .catch((err) => {
            this.logger.error(
              `[heygen-webhook] credit reconcile failed gen=${generation.id}: ${err instanceof Error ? err.message : err}`,
            );
          });
        this.logger.log(
          `[heygen-webhook] reconciled gen=${generation.id} estimate=${generation.creditsConsumed} real=${realCost} delta=${delta}`,
        );
      }
    }

    this.logger.log(
      `[heygen-webhook] video done gen=${generation.id} video_id=${videoId} duration=${durationSeconds ?? '?'}s cost=${realCost ?? generation.creditsConsumed}`,
    );
  }

  private buildExternalId(event: HeyGenWebhookEvent): string {
    const cb = event.event_data.callback_id ?? '';
    const av = event.event_data.avatar_group_id ?? event.event_data.avatar_id ?? '';
    const vd = event.event_data.video_id ?? '';
    return [cb, av, vd].filter(Boolean).join(':') || event.event_type;
  }

}
