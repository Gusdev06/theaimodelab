import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Generation, Prisma } from '@prisma/client';
import { AvatarStatus, GenerationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditsService } from '../../credits/credits.service';
import { UploadsService } from '../../uploads/uploads.service';
import { HeyGenProvider } from '../providers/heygen.provider';
import { AvatarsService } from '../avatars.service';
import {
  GenerationFailureCode,
  IMAGE_SAFETY_BLOCKED_MESSAGE,
  classifyGenerationFailure,
} from '../../generations/errors/failure-reason';
import { ImageSafetyService } from '../../content-safety/image-safety/image-safety.service';
import { AvatarEventsService } from '../avatar-events.service';
import { actualAvatarVideoCost } from '../avatars.constants';

/** Prazo para baixar o vídeo pronto da HeyGen para a quarentena. */
const HEYGEN_VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/**
 * Trava da checagem do vídeo (safetyCheckedAt): o download (até 5 min) mais a régua por quadros. Dentro dela, o
 * reenvio da HeyGen ou o evento de sucesso duplicado não refaz nada (responde 503 para vir de novo); passada, um
 * webhook novo pode retomar.
 */
const HEYGEN_SCREEN_CLAIM_MS = 15 * 60_000;
const OPEN_GENERATION_STATUSES = [
  GenerationStatus.PENDING,
  GenerationStatus.PROCESSING,
];

/**
 * Outro webhook já baixa e checa o mesmo vídeo. Responde 503 (não 200) para a HeyGen reenviar depois, e o evento não
 * fica marcado como processado: se o 1º falhar e soltar a trava, o reenvio passa pela dedupe e refaz.
 */
export class HeyGenScreeningInProgressError extends ServiceUnavailableException {
  constructor() {
    super({
      code: 'HEYGEN_SCREENING_IN_PROGRESS',
      message: 'Vídeo já em checagem; reenviar depois.',
    });
  }
}

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
    private readonly imageSafety: ImageSafetyService,
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
      if (err instanceof HeyGenScreeningInProgressError) {
        this.logger.log(
          `[heygen-webhook] event_type=${event.event_type} externalId=${externalId}: vídeo em checagem por outro webhook — 503 para a HeyGen reenviar`,
        );
      } else {
        this.logger.error(
          `[heygen-webhook] handler failed event_type=${event.event_type} externalId=${externalId}: ${errorMessage}`,
        );
      }
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
    // failure), the webhook is a duplicate — drop it. Segurada pela checagem (IN_REVIEW) só sai pelo cron da
    // quarentena ou pelo revisor.
    if (
      generation.status === GenerationStatus.COMPLETED ||
      generation.status === GenerationStatus.FAILED ||
      generation.status === GenerationStatus.IN_REVIEW
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
      // o código da HeyGen fica no log; em `error_code` vai o nosso vocabulário,
      // que é o que o front usa pra dizer ao usuário o motivo real da falha
      const heygenCode = event.event_data.error?.code ?? null;
      const errorCode = classifyGenerationFailure(errorMessage);

      await this.prisma.generation.update({
        where: { id: generation.id },
        data: {
          status: GenerationStatus.FAILED,
          errorMessage: errorMessage.slice(0, 500),
          errorCode,
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
        `[heygen-webhook] video failed gen=${generation.id} code=${errorCode} heygenCode=${heygenCode ?? '-'} error="${errorMessage}"`,
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

    // Copy media to R2 so the URL survives HeyGen URL expirations. Com a checagem de imagem ligada, o vídeo passa
    // pela quarentena e pela régua por quadros antes de ser publicado
    let persistentUrl: string;
    if (this.imageSafety.imageEnabled) {
      // a checagem leva minutos com o POST aberto: só um webhook baixa e checa. A trava (safetyCheckedAt agora) também
      // tira a geração do cron de presas durante a checagem. Quem perde a trava não marca o evento como processado
      const claim = await this.claimForScreening(generation);
      if (!claim) throw new HeyGenScreeningInProgressError();
      let released: string | null;
      try {
        released = await this.screenVideo(generation, videoUrl, durationSeconds);
      } catch (err) {
        // download ou checagem falhou: solta a trava para o reenvio da HeyGen refazer
        await this.releaseScreeningClaim(generation, claim);
        throw err;
      }
      if (!released) return;
      persistentUrl = released;
    } else {
      persistentUrl = await this.uploadsService.uploadFromUrl(
        videoUrl,
        `generations/${generation.id}`,
        'output.mp4',
      );
    }
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

    // conclusão só com a geração ainda aberta: o cron de presas (FAILED com estorno) ou outro webhook pode ter chegado
    // antes, e aí nem a saída nem o ajuste de crédito entram (senão a cliente ficava com o vídeo e o estorno, ou com o
    // ajuste em dobro)
    const completed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.generation.updateMany({
        where: { id: generation.id, status: { in: OPEN_GENERATION_STATUSES } },
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
      if (count === 0) return false;
      await tx.generationOutput.create({
        data: {
          generationId: generation.id,
          url: persistentUrl,
          thumbnailUrl: persistentThumbnail ?? undefined,
          mimeType: 'video/mp4',
          order: 0,
        },
      });
      return true;
    });
    if (!completed) {
      await this.discardPublished(generation.id, [persistentUrl, persistentThumbnail]);
      this.logger.warn(
        `[heygen-webhook] generation=${generation.id}: encerrada por outro caminho durante a cópia do vídeo — nada concluído, cópia descartada`,
      );
      return;
    }

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

  /**
   * Checagem do vídeo pronto antes de publicar (camada 5), como no processor: o vídeo vai para a quarentena (privado)
   * e passa pela régua por quadros. Aprovado devolve a URL pública promovida; suspeito ou sem checagem fica IN_REVIEW
   * (o cron da quarentena ou o revisor concluem, nunca publicado antes); barrado encerra aqui com estorno e a mensagem
   * genérica. null = nada a publicar agora.
   */
  private async screenVideo(
    generation: Generation,
    videoUrl: string,
    durationSeconds: number | null,
  ): Promise<string | null> {
    const video = await this.downloadVideo(videoUrl, generation.id);
    const stagedUrl = await this.uploadsService.uploadBuffer(
      video.body,
      `generations/${generation.id}`,
      'output.mp4',
      video.contentType,
    );
    const outcome = await this.imageSafety.checkOutput(generation.id, [stagedUrl], {
      modelUsed: generation.modelUsed,
      provider: null,
      processingTimeMs: generation.processingStartedAt
        ? Date.now() - generation.processingStartedAt.getTime()
        : 0,
    });

    if (outcome.action === 'promote') {
      const [published] = outcome.outputs;
      if (published) return published;
      this.logger.error(`[heygen-webhook] gen=${generation.id}: checagem aprovou sem URL publicada`);
      return null;
    }

    if (outcome.action === 'held') {
      // a duração real fica gravada para a conclusão posterior (o crédito segue o estimado)
      if (typeof durationSeconds === 'number' && durationSeconds > 0) {
        await this.prisma.generation
          .updateMany({
            where: { id: generation.id, status: GenerationStatus.IN_REVIEW },
            data: { durationSeconds },
          })
          .catch(() => undefined);
      }
      this.logger.warn(`[heygen-webhook] gen=${generation.id}: vídeo segurado pela checagem de segurança`);
      return null;
    }

    const { count } = await this.prisma.generation.updateMany({
      where: {
        id: generation.id,
        status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING] },
      },
      data: {
        status: GenerationStatus.FAILED,
        errorMessage: IMAGE_SAFETY_BLOCKED_MESSAGE,
        errorCode: GenerationFailureCode.IMAGE_SAFETY_BLOCKED,
        completedAt: new Date(),
      },
    });
    if (count > 0) {
      await this.creditsService
        .refund(generation.userId, generation.creditsConsumed, generation.id)
        .catch((err) => {
          this.logger.error(
            `[heygen-webhook] refund failed for gen ${generation.id}: ${err instanceof Error ? err.message : err}`,
          );
        });
    }
    this.logger.warn(`[heygen-webhook] gen=${generation.id}: vídeo barrado pela checagem de segurança`);
    return null;
  }

  /**
   * Trava da checagem: só quem troca o safetyCheckedAt (vazio ou mais velho que a trava) para agora baixa e checa.
   * Devolve a hora gravada (para soltar depois) ou null quando outro webhook já está checando.
   */
  private async claimForScreening(generation: Generation): Promise<Date | null> {
    const now = new Date();
    const { count } = await this.prisma.generation.updateMany({
      where: {
        id: generation.id,
        status: { in: OPEN_GENERATION_STATUSES },
        OR: [
          { safetyCheckedAt: null },
          { safetyCheckedAt: { lt: new Date(now.getTime() - HEYGEN_SCREEN_CLAIM_MS) } },
        ],
      },
      data: { safetyCheckedAt: now },
    });
    return count > 0 ? now : null;
  }

  /** Solta a trava (volta o safetyCheckedAt de antes) quando a checagem não terminou. Nunca lança. */
  private async releaseScreeningClaim(generation: Generation, claim: Date): Promise<void> {
    await this.prisma.generation
      .updateMany({
        where: {
          id: generation.id,
          safetyCheckedAt: claim,
          status: { in: OPEN_GENERATION_STATUSES },
        },
        data: { safetyCheckedAt: generation.safetyCheckedAt },
      })
      .catch((err) =>
        this.logger.error(
          `[heygen-webhook] gen=${generation.id}: trava da checagem não solta (${err instanceof Error ? err.message : err}) — o reenvio espera ${HEYGEN_SCREEN_CLAIM_MS / 60_000} min`,
        ),
      );
  }

  /**
   * Cópias públicas de uma conclusão que perdeu a vez (chave nova a cada cópia: não são de mais ninguém). Nunca lança.
   */
  private async discardPublished(
    generationId: string,
    urls: ReadonlyArray<string | null>,
  ): Promise<void> {
    for (const url of urls) {
      const location = url ? this.uploadsService.locateStoredMedia(url) : null;
      if (location?.area !== 'public') continue;
      await this.uploadsService
        .deleteStoredObject('public', location.key)
        .catch((err) =>
          this.logger.error(
            `[heygen-webhook] gen=${generationId}: cópia ${location.key} não apagada (${err instanceof Error ? err.message : err}) — apagar à mão`,
          ),
        );
    }
  }

  /** Baixa o vídeo pronto (com prazo) para gravar na quarentena. */
  private async downloadVideo(
    videoUrl: string,
    generationId: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    const response = await fetch(videoUrl, {
      signal: AbortSignal.timeout(HEYGEN_VIDEO_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `Falha ao baixar o vídeo da HeyGen para gen=${generationId}: HTTP ${response.status}`,
      );
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: contentType.startsWith('video/') ? contentType : 'video/mp4',
    };
  }

  private buildExternalId(event: HeyGenWebhookEvent): string {
    const cb = event.event_data.callback_id ?? '';
    const av = event.event_data.avatar_group_id ?? event.event_data.avatar_id ?? '';
    const vd = event.event_data.video_id ?? '';
    return [cb, av, vd].filter(Boolean).join(':') || event.event_type;
  }

}
