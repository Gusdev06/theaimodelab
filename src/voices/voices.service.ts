import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import {
  AiModelProvider,
  GenerationStatus,
  GenerationType,
  VoiceProfileStatus,
} from '@prisma/client';
import { CreateVoiceDto } from './dto/create-voice.dto';
import { RenameVoiceDto } from './dto/rename-voice.dto';
import {
  VoiceListResponseDto,
  VoiceResponseDto,
} from './dto/voice-response.dto';
import {
  FREE_PLAN_VOICE_QUOTA,
  VOICE_PROFILE_QUOTAS,
} from './voices.constants';

@Injectable()
export class VoicesService {
  private readonly logger = new Logger(VoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

  async list(userId: string): Promise<VoiceListResponseDto> {
    const [voices, quota] = await Promise.all([
      this.prisma.voiceProfile.findMany({
        where: { userId, isDeleted: false },
        orderBy: { createdAt: 'desc' },
      }),
      this.getQuota(userId),
    ]);

    return {
      voices: voices.map((v) => this.toResponse(v)),
      quota,
    };
  }

  async create(
    userId: string,
    dto: CreateVoiceDto,
  ): Promise<VoiceResponseDto> {
    const quota = await this.getQuota(userId);
    if (quota.used >= quota.limit) {
      throw new ForbiddenException(
        quota.limit === 0
          ? 'Seu plano atual não permite salvar vozes. Faça upgrade para criar uma.'
          : `Limite de vozes salvas atingido (${quota.limit}). Exclua uma voz ou faça upgrade do plano.`,
      );
    }

    const generation = await this.prisma.generation.findFirst({
      where: {
        id: dto.generationId,
        userId,
      },
      select: {
        id: true,
        type: true,
        status: true,
        prompt: true,
        parameters: true,
        outputs: {
          orderBy: { order: 'asc' },
          take: 1,
          select: { url: true, mimeType: true },
        },
      },
    });

    if (!generation) {
      throw new NotFoundException('Geração não encontrada.');
    }
    if (generation.type !== GenerationType.VOICE_CLONE) {
      throw new BadRequestException(
        'Só é possível salvar uma voz a partir de uma clonagem (voice-clone).',
      );
    }
    if (generation.status !== GenerationStatus.COMPLETED) {
      throw new BadRequestException(
        'A clonagem precisa ter sido concluída antes de ser salva como voz.',
      );
    }

    const params =
      generation.parameters && typeof generation.parameters === 'object'
        ? (generation.parameters as Record<string, unknown>)
        : {};
    const sampleUrl = typeof params.sampleUrl === 'string' ? params.sampleUrl : null;
    const sampleMime =
      typeof params.sampleMime === 'string' ? params.sampleMime : null;
    const language =
      typeof params.language === 'string' ? params.language : 'pt-BR';

    if (!sampleUrl) {
      throw new BadRequestException(
        'Sample da voz não está mais disponível. Refaça a clonagem para salvar.',
      );
    }

    // Copy sample from generation-scoped path to user-scoped persistent path
    const persistentUrl = await this.copySampleToPersistent(
      sampleUrl,
      sampleMime,
      userId,
    );

    // Copy the synthesized output (preview) to a persistent path so it survives
    // even if the user later deletes the source generation.
    const output = generation.outputs[0];
    let previewUrl: string | null = null;
    if (output?.url) {
      try {
        previewUrl = await this.copyPreviewToPersistent(
          output.url,
          output.mimeType,
          userId,
        );
      } catch (err) {
        this.logger.warn(
          `Could not persist preview audio for voice (gen ${generation.id}): ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    const voice = await this.prisma.voiceProfile.create({
      data: {
        userId,
        name: dto.name.trim(),
        provider: AiModelProvider.WAVESPEED,
        sampleUrl: persistentUrl,
        sampleMime: sampleMime ?? undefined,
        previewUrl: previewUrl ?? undefined,
        previewText: generation.prompt?.trim() || undefined,
        language,
        status: VoiceProfileStatus.READY,
      },
    });

    this.logger.log(
      `Voice profile ${voice.id} created for user ${userId} from generation ${generation.id}`,
    );

    return this.toResponse(voice);
  }

  async rename(
    userId: string,
    voiceId: string,
    dto: RenameVoiceDto,
  ): Promise<VoiceResponseDto> {
    const voice = await this.prisma.voiceProfile.findFirst({
      where: { id: voiceId, userId, isDeleted: false },
    });
    if (!voice) {
      throw new NotFoundException('Voz não encontrada.');
    }

    const updated = await this.prisma.voiceProfile.update({
      where: { id: voiceId },
      data: { name: dto.name.trim() },
    });
    return this.toResponse(updated);
  }

  async remove(userId: string, voiceId: string): Promise<void> {
    const voice = await this.prisma.voiceProfile.findFirst({
      where: { id: voiceId, userId, isDeleted: false },
    });
    if (!voice) {
      throw new NotFoundException('Voz não encontrada.');
    }

    await this.prisma.voiceProfile.update({
      where: { id: voiceId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
      },
    });
    this.logger.log(`Voice profile ${voiceId} soft-deleted for user ${userId}`);
  }

  /**
   * Resolves a voice profile for a given user. Used by generations.service
   * when routing TTS with a saved voice (voiceId prefixed with `clone:`).
   */
  async getForUse(
    userId: string,
    voiceId: string,
  ): Promise<{ id: string; sampleUrl: string; sampleMime: string | null; language: string } | null> {
    const voice = await this.prisma.voiceProfile.findFirst({
      where: {
        id: voiceId,
        userId,
        isDeleted: false,
        status: VoiceProfileStatus.READY,
      },
      select: {
        id: true,
        sampleUrl: true,
        sampleMime: true,
        language: true,
      },
    });
    return voice;
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async getQuota(
    userId: string,
  ): Promise<{ used: number; limit: number; planSlug: string }> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: { plan: { select: { slug: true } } },
    });

    const planSlug = subscription?.plan.slug ?? 'free';
    const limit = VOICE_PROFILE_QUOTAS[planSlug] ?? FREE_PLAN_VOICE_QUOTA;

    const used = await this.prisma.voiceProfile.count({
      where: { userId, isDeleted: false },
    });

    return { used, limit, planSlug };
  }

  private async copySampleToPersistent(
    sourceUrl: string,
    mimeType: string | null,
    userId: string,
  ): Promise<string> {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new BadRequestException(
        `Não foi possível ler o sample original (status ${response.status}).`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType =
      mimeType ?? response.headers.get('content-type') ?? 'audio/mpeg';
    const ext = this.extFromMime(contentType);

    return this.uploadsService.uploadBuffer(
      buffer,
      `voices/${userId}`,
      `sample.${ext}`,
      contentType,
    );
  }

  private async copyPreviewToPersistent(
    sourceUrl: string,
    mimeType: string | null,
    userId: string,
  ): Promise<string> {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`preview fetch failed (status ${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType =
      mimeType ?? response.headers.get('content-type') ?? 'audio/mpeg';
    const ext = this.extFromMime(contentType);

    return this.uploadsService.uploadBuffer(
      buffer,
      `voices/${userId}`,
      `preview.${ext}`,
      contentType,
    );
  }

  private extFromMime(mime: string): string {
    const subtype = mime.split('/')[1] ?? 'mpeg';
    if (subtype.includes('wav') || subtype === 'wave') return 'wav';
    if (subtype.includes('webm')) return 'webm';
    if (subtype.includes('ogg')) return 'ogg';
    if (subtype.includes('mp4')) return 'm4a';
    return 'mp3';
  }

  private toResponse(voice: {
    id: string;
    name: string;
    language: string;
    status: VoiceProfileStatus;
    sampleUrl: string;
    previewUrl: string | null;
    previewText: string | null;
    createdAt: Date;
  }): VoiceResponseDto {
    return {
      id: voice.id,
      name: voice.name,
      language: voice.language,
      status: voice.status,
      sampleUrl: voice.sampleUrl,
      previewUrl: voice.previewUrl,
      previewText: voice.previewText,
      createdAt: voice.createdAt,
    };
  }
}
