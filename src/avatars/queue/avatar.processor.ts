import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import {
  AvatarConsentStatus,
  AvatarStatus,
  GenerationStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditsService } from '../../credits/credits.service';
import { UploadsService } from '../../uploads/uploads.service';
import { HeyGenProvider } from '../providers/heygen.provider';
import { AvatarEventsService } from '../avatar-events.service';
import { WavespeedAudioProvider } from '../../generations/providers/wavespeed-audio.provider';
import {
  AVATAR_QUEUE,
  AvatarJobName,
  GenerateVideoJobData,
  SubmitTrainingJobData,
} from './avatar-queue.constants';

@Processor(AVATAR_QUEUE, {
  // Two job types share this queue:
  //   - generate-video: fire-and-forget (webhook drives completion). Sub-2min.
  //   - submit-training: digital twins upload via HeyGen /v1/asset, which can
  //     take several minutes for large videos (200–500MB).
  // Lock window is sized for the worst case (asset upload). The 15-min
  // stuck-generations cron is the safety net if a worker hangs longer.
  concurrency: 10,
  lockDuration: 10 * 60 * 1000, // 10 min
})
export class AvatarProcessor extends WorkerHost {
  private readonly logger = new Logger(AvatarProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditsService: CreditsService,
    private readonly uploadsService: UploadsService,
    private readonly heygen: HeyGenProvider,
    private readonly events: AvatarEventsService,
    private readonly configService: ConfigService,
    private readonly wavespeed: WavespeedAudioProvider,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing job ${job.id} [${job.name}] data=${JSON.stringify(job.data)}`);

    switch (job.name) {
      case AvatarJobName.SUBMIT_TRAINING:
        return this.processSubmitTraining(job.data as SubmitTrainingJobData);
      case AvatarJobName.GENERATE_VIDEO:
        return this.processGenerateVideo(job.data as GenerateVideoJobData);
      default:
        throw new Error(`Unknown avatar job name: ${job.name}`);
    }
  }

  // ─── Job: submit-training ──────────────────────────────────────────────────

  private async processSubmitTraining(data: SubmitTrainingJobData): Promise<void> {
    const avatar = await this.prisma.userAvatar.findUnique({
      where: { id: data.userAvatarId },
    });
    if (!avatar || avatar.isDeleted) {
      this.logger.warn(`submit-training: avatar ${data.userAvatarId} not found / deleted, skipping`);
      return;
    }
    if (avatar.status !== AvatarStatus.PENDING) {
      this.logger.warn(
        `submit-training: avatar ${avatar.id} already in status=${avatar.status}, skipping`,
      );
      return;
    }

    const avatarType = data.avatarType ?? 'photo';

    try {
      await this.prisma.userAvatar.update({
        where: { id: avatar.id },
        data: {
          status: AvatarStatus.SUBMITTING,
          trainingStartedAt: new Date(),
        },
      });
      this.events.emit({
        userId: avatar.userId,
        userAvatarId: avatar.id,
        status: AvatarStatus.SUBMITTING,
      });

      // 1. Create avatar on HeyGen — branch by type
      const created =
        avatarType === 'digital_twin'
          ? await this.heygen.createDigitalTwin({
              name: avatar.name,
              fileUrl: avatar.sourceVideoUrl,
            })
          : await this.heygen.createPhotoAvatar({
              name: avatar.name,
              fileUrl: avatar.sourceVideoUrl,
            });

      // 2. Persist HeyGen ids and move to TRAINING. Cron + webhook will flip
      // to READY when HeyGen finishes processing.
      const updated = await this.prisma.userAvatar.update({
        where: { id: avatar.id },
        data: {
          heygenLookId: created.lookId,
          heygenGroupId: created.groupId,
          consentStatus: AvatarConsentStatus.NOT_REQUIRED,
          consentUrl: null,
          status: AvatarStatus.TRAINING,
        },
      });

      this.logger.log(
        `[AVATAR_FLOW] ✅ persisted avatar=${avatar.id} type=${avatarType} group_id=${created.groupId} look_id=${created.lookId}`,
      );

      this.events.emit({
        userId: avatar.userId,
        userAvatarId: avatar.id,
        status: AvatarStatus.TRAINING,
        consentStatus: updated.consentStatus,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`submit-training failed for ${avatar.id}: ${errorMessage}`);
      await this.markFailedAndRefund(avatar.id, avatar.userId, avatar.creditsConsumed, errorMessage);
      // Re-throw so BullMQ counts the attempt; queue is configured with attempts=2
      throw err;
    }
  }

  // ─── Job: generate-video (user-initiated avatar→video) ─────────────────────

  private async processGenerateVideo(data: GenerateVideoJobData): Promise<void> {
    const generation = await this.prisma.generation.findUnique({
      where: { id: data.generationId },
    });
    if (!generation) {
      this.logger.warn(`generate-video: generation ${data.generationId} missing, skipping`);
      return;
    }

    const avatar = await this.prisma.userAvatar.findUnique({
      where: { id: data.userAvatarId },
    });
    if (!avatar?.heygenLookId) {
      await this.failGeneration(generation.id, generation.userId, generation.creditsConsumed, 'Avatar inválido ou removido.');
      return;
    }

    try {
      await this.prisma.generation.update({
        where: { id: generation.id },
        data: {
          status: GenerationStatus.PROCESSING,
          processingStartedAt: new Date(),
        },
      });

      const params =
        generation.parameters && typeof generation.parameters === 'object'
          ? (generation.parameters as Record<string, any>)
          : {};

      const script = typeof params.script === 'string' ? params.script : (generation.prompt ?? '');
      const voiceProfileId =
        typeof params.voiceProfileId === 'string' ? params.voiceProfileId : null;
      const inworldVoiceId =
        typeof params.inworldVoiceId === 'string' ? params.inworldVoiceId : null;
      const customAudioUrl =
        typeof params.customAudioUrl === 'string' ? params.customAudioUrl : null;

      // Audio source priority:
      //  1. customAudioUrl  → user-uploaded/recorded audio; no synthesis
      //  2. voiceProfileId  → synthesize with their cloned voice (OmniVoice)
      //  3. inworldVoiceId  → synthesize with Inworld TTS via Wavespeed
      //  4. fall through    → let HeyGen do its own TTS with voice_id
      let audioUrl: string | undefined;
      if (customAudioUrl) {
        audioUrl = customAudioUrl;
        this.logger.log(
          `[AVATAR_FLOW] gen=${generation.id} using custom audio URL (skip TTS)`,
        );
      } else if (voiceProfileId) {
        audioUrl = await this.synthesizeClonedAudio(
          generation.userId,
          generation.id,
          script,
          voiceProfileId,
        );
      } else if (inworldVoiceId) {
        audioUrl = await this.synthesizeInworldAudio(
          generation.id,
          script,
          inworldVoiceId,
        );
      }

      // Resolution downgrade: the client may send '4k' (billed at the 4K
      // per-second rate) but HeyGen's avatar_iv engine doesn't render true 4K
      // today, so we downgrade to 1080p before the API call. The user is
      // already billed at 4K — see AVATAR_VIDEO_CREDITS_PER_SECOND.
      const requestedResolution =
        typeof params.resolution === 'string'
          ? (params.resolution as '720p' | '1080p' | '4k')
          : '1080p';
      const heygenResolution: '720p' | '1080p' =
        requestedResolution === '4k' ? '1080p' : requestedResolution;

      // Resolve voice_id. Priority:
      //   1. Explicit voiceId from params
      //   2. avatar.defaultVoiceId saved in our DB
      //   3. Live fallback: fetch the group from HeyGen — Digital Twin avatars
      //      carry default_voice_id at the group level even when individual looks
      //      don't (covers older avatars created before the cron started saving
      //      this into our DB).
      //   4. Global default from HEYGEN_DEFAULT_VOICE_ID env — required for
      //      Photo Avatars, which have no default voice anywhere in HeyGen.
      const paramVoiceId = typeof params.voiceId === 'string' ? params.voiceId : null;
      let resolvedVoiceId: string | undefined = audioUrl
        ? undefined
        : paramVoiceId ?? avatar.defaultVoiceId ?? undefined;
      if (!audioUrl && !resolvedVoiceId && avatar.heygenGroupId) {
        try {
          const snapshot = await this.heygen.getAvatarGroup(avatar.heygenGroupId);
          if (snapshot.groupDefaultVoiceId) {
            resolvedVoiceId = snapshot.groupDefaultVoiceId;
            // Persist for next time — avoids the extra fetch on subsequent renders
            await this.prisma.userAvatar
              .update({
                where: { id: avatar.id },
                data: { defaultVoiceId: snapshot.groupDefaultVoiceId },
              })
              .catch(() => {});
            this.logger.log(
              `[avatar.processor] backfilled defaultVoiceId for ${avatar.id} from group ${avatar.heygenGroupId}`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `[avatar.processor] failed to fetch group voice fallback for ${avatar.id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      if (!audioUrl && !resolvedVoiceId) {
        // Last-resort: a system-wide default voice (typically a neutral PT-BR voice
        // from HeyGen's public catalog). Set this in env when running Photo Avatar
        // flows so users don't need to clone a voice just to try the product.
        const envFallback = this.configService.get<string>('HEYGEN_DEFAULT_VOICE_ID');
        if (envFallback) {
          resolvedVoiceId = envFallback;
          this.logger.log(
            `[avatar.processor] using HEYGEN_DEFAULT_VOICE_ID fallback for ${avatar.id}`,
          );
        }
      }
      if (!audioUrl && !resolvedVoiceId) {
        // No voice anywhere — fail with a user-friendly message so the credit
        // refund kicks in and the user knows what to do.
        throw new Error(
          'Este avatar não tem voz padrão configurada. Clone uma voz na seção "Minhas Vozes" e selecione-a antes de gerar o vídeo.',
        );
      }

      const created = await this.heygen.createAvatarVideo({
        avatarId: avatar.heygenLookId,
        // When using audio_url, script + voice_id are mutually exclusive — omit them
        script: audioUrl ? undefined : script,
        voiceId: resolvedVoiceId,
        audioUrl,
        engine: typeof params.engine === 'string' ? params.engine as 'avatar_iv' | 'avatar_v' : undefined,
        resolution: heygenResolution,
        aspectRatio: typeof params.aspectRatio === 'string' ? params.aspectRatio as '16:9' | '9:16' : '9:16',
        background:
          typeof params.backgroundColor === 'string'
            ? { type: 'color', value: params.backgroundColor }
            : typeof params.backgroundImageUrl === 'string'
              ? { type: 'image', url: params.backgroundImageUrl }
              : undefined,
        // callback_id is echoed back in the webhook payload — useful for logs/debug
        callbackId: generation.id,
        title: `${avatar.name} — ${new Date().toISOString()}`,
      });

      // Save the HeyGen video_id so the webhook can find this Generation when
      // the render completes. Worker returns immediately — no polling.
      await this.prisma.generation.update({
        where: { id: generation.id },
        data: { heygenVideoId: created.videoId },
      });

      this.logger.log(
        `generate-video submitted generation=${generation.id} avatar=${avatar.id} heygen_video=${created.videoId} — awaiting webhook`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`generate-video failed gen=${generation.id}: ${message}`);
      await this.failGeneration(generation.id, generation.userId, data.creditsConsumed, message);
      throw err;
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Generates audio using the user's cloned voice (Wavespeed/OmniVoice) and
   * persists it to R2 so HeyGen can lip-sync to it. Returns the public URL.
   */
  private async synthesizeClonedAudio(
    userId: string,
    generationId: string,
    text: string,
    voiceProfileId: string,
  ): Promise<string> {
    const voice = await this.prisma.voiceProfile.findFirst({
      where: { id: voiceProfileId, userId, isDeleted: false },
      select: { sampleUrl: true, language: true },
    });
    if (!voice) {
      throw new Error('Voz clonada não encontrada.');
    }

    this.logger.log(`[AVATAR_TTS] gen=${generationId} voiceProfile=${voiceProfileId} cloning…`);

    // generateVoiceClone uploads the resulting mp3 to R2 under generations/<id>/
    // and returns the public URL — exactly what HeyGen needs for audio_url.
    const result = await this.wavespeed.generateVoiceClone({
      id: generationId,
      text,
      audioUrl: voice.sampleUrl,
      language: voice.language ?? 'pt',
    });

    const audioUrl = result.outputUrls[0];
    if (!audioUrl) {
      throw new Error('Falha ao gerar áudio com a voz clonada.');
    }
    return audioUrl;
  }

  /**
   * Generates audio using a public voice from the Inworld catalog (proxied via
   * Wavespeed's Inworld 1.5 Max TTS) and persists it to R2 so HeyGen can
   * lip-sync. Returns the public URL.
   */
  private async synthesizeInworldAudio(
    generationId: string,
    text: string,
    inworldVoiceId: string,
  ): Promise<string> {
    this.logger.log(
      `[AVATAR_TTS] gen=${generationId} inworldVoice=${inworldVoiceId} synthesizing…`,
    );

    // The WavespeedAudioProvider routes voiceIds prefixed with "inworld:" to
    // Inworld 1.5 Max. The output is uploaded to R2 — exactly what HeyGen wants.
    const result = await this.wavespeed.generateTextToSpeech({
      id: generationId,
      text,
      voiceId: `inworld:${inworldVoiceId}`,
    });

    const audioUrl = result.outputUrls[0];
    if (!audioUrl) {
      throw new Error('Falha ao gerar áudio com a voz Inworld.');
    }
    return audioUrl;
  }

  private async markFailedAndRefund(
    userAvatarId: string,
    userId: string,
    creditsConsumed: number,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.userAvatar.update({
      where: { id: userAvatarId },
      data: {
        status: AvatarStatus.FAILED,
        errorMessage: errorMessage.slice(0, 500),
      },
    });
    await this.creditsService.refundForAvatar(userId, userAvatarId, creditsConsumed).catch((err) => {
      this.logger.error(`refund failed for avatar ${userAvatarId}: ${err instanceof Error ? err.message : err}`);
    });
    this.events.emit({
      userId,
      userAvatarId,
      status: AvatarStatus.FAILED,
      data: { errorMessage },
    });
  }

  private async failGeneration(
    generationId: string,
    userId: string,
    creditsConsumed: number,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.generation.update({
      where: { id: generationId },
      data: {
        status: GenerationStatus.FAILED,
        errorMessage: errorMessage.slice(0, 500),
        completedAt: new Date(),
      },
    });
    await this.creditsService.refund(userId, creditsConsumed, generationId).catch((err) => {
      this.logger.error(
        `refund failed for generation ${generationId}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

}
