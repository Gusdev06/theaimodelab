import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreditsService,
  resolveFreeGenerationType,
} from '../credits/credits.service';
import { PlansService } from '../plans/plans.service';
import { ModelsService } from '../models/models.service';
import { VoicesService } from '../voices/voices.service';
import {
  AiModelType,
  FreeGenerationType,
  GenerationType,
  GenerationStatus,
  CreditTransactionType,
  Resolution,
  GenerationImageRole,
} from '@prisma/client';
import { GenerationFiltersDto } from './dto/generation-filters.dto';
import {
  GenerationResponseDto,
  CreateGenerationResponseDto,
} from './dto/generation-response.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { UploadsService } from '../uploads/uploads.service';
import { GenerateVideoTextToVideoDto } from './dto/videos/generate-video-text-to-video.dto';
import { GenerateVideoImageToVideoDto } from './dto/videos/generate-video-image-to-video.dto';
import { GenerateVideoWithReferencesDto } from './dto/videos/generate-video-with-references.dto';
import { GenerateMotionControlDto } from './dto/videos/generate-motion-control.dto';
import { getVideoDurationSeconds } from './utils/video-duration.util';
import { GenerateImageDto } from './dto/generate-image.dto';
import { UpscaleImageDto } from './dto/upscale-image.dto';
import { GenerateImageNanoBananaDto } from './dto/generate-image-nano-banana.dto';
import { GenerateVirtualTryOnDto } from './dto/generate-virtual-try-on.dto';
import { GenerateFaceSwapDto } from './dto/generate-face-swap.dto';
import { GenerateVeoKieTextToVideoDto } from './dto/videos/generate-veo-kie-text-to-video.dto';
import { GenerateVeoKieImageToVideoDto } from './dto/videos/generate-veo-kie-image-to-video.dto';
import { GenerateVeoKieReferenceToVideoDto } from './dto/videos/generate-veo-kie-reference-to-video.dto';
import { GenerateGrokImagineImageToVideoDto } from './dto/videos/generate-grok-imagine-image-to-video.dto';
import { GenerateGrokImagineTextToVideoDto } from './dto/videos/generate-grok-imagine-text-to-video.dto';
import { GenerateGeminiOmniVideoDto } from './dto/videos/generate-gemini-omni-video.dto';
import { GenerateSeedanceVideoDto } from './dto/videos/generate-seedance-video.dto';
import { GenerateTextToSpeechDto } from './dto/generate-text-to-speech.dto';
import { GenerateVoiceCloneDto } from './dto/generate-voice-clone.dto';
import { containsNsfwContent } from './utils/nsfw-blocklist';

/**
 * Mapeia o nome do modelo da API para o modelVariant usado na tabela credit_costs.
 * NBP = gemini-3-pro-image-preview (Nano Banana Pro)
 * NB2 = gemini-3.1-flash-image-preview (Nano Banana 2)
 * THEAIMODELAB_FAST = theaimodelab-fast (theaimodelab-provider)
 * THEAIMODELAB_QUALITY = theaimodelab-quality (theaimodelab-provider)
 * VEO_FAST = veo3_fast (KIE API)
 * VEO_MAX = veo3 (KIE API)
 */
function getModelVariant(model: string | undefined | null): string | null {
  if (!model) return null;
  const MODEL_TO_VARIANT: Record<string, string> = {
    // Images
    'gemini-3-pro-image-preview': 'NBP',
    'gemini-3.1-flash-image-preview': 'NB2',
    'nano-banana-pro': 'NBP',
    'nano-banana-2': 'NB2',
    // Sem censura
    'sem-censura': 'SEM_CENSURA',
    // GPT Image 2 (Kie API)
    'gpt-image-2': 'GPT_IMAGE_2',
    // The AI Model Lab provider (video)
    'theaimodelab-fast': 'THEAIMODELAB_FAST',
    'theaimodelab-quality': 'THEAIMODELAB_QUALITY',
    'veo-3.1-fast-generate-001': 'THEAIMODELAB_FAST', // backward compat
    'veo-3.1-generate-001': 'THEAIMODELAB_QUALITY', // backward compat
    // KIE API (Veo 3.1)
    veo3_fast: 'VEO_FAST',
    veo3: 'VEO_MAX',
    // KIE API (Grok Imagine)
    'grok-imagine': 'GROK_IMAGINE',
    // KIE API (Gemini Omni Video)
    'gemini-omni-video': 'GEMINI_OMNI',
    // KIE API (Bytedance Seedance 2.0)
    'bytedance-seedance-2': 'SEEDANCE_2',
    // KIE API (Seedream Lite) — unificado: T2I se sem images, I2I se com images
    'seedream-5-lite': 'SEEDREAM_LITE',
  };
  return MODEL_TO_VARIANT[model] ?? null;
}

/**
 * Normaliza nomes legados de modelos para os slugs atuais do banco (tabela ai_models).
 * Necessário porque alguns DTOs ainda aceitam nomes antigos do Vertex AI.
 */
function normalizeVideoModelSlug(model: string): string {
  const LEGACY_SLUG_MAP: Record<string, string> = {
    'veo-3.1-fast-generate-001': 'theaimodelab-fast',
    'veo-3.1-generate-001': 'theaimodelab-quality',
  };
  return LEGACY_SLUG_MAP[model] ?? model;
}

/**
 * Para modelos The AI Model Lab (THEAIMODELAB_FAST / THEAIMODELAB_QUALITY), a resolução 4K
 * é gerada internamente como 1080p no provider, mas cobrada como 4K.
 * O registro no banco mantém RES_4K para exibição no frontend.
 */
function effectiveVideoResolution(
  resolution: Resolution,
  modelVariant: string | null,
): Resolution {
  const isTheaimodelab =
    modelVariant === 'THEAIMODELAB_FAST' || modelVariant === 'THEAIMODELAB_QUALITY';
  if (isTheaimodelab && resolution === Resolution.RES_4K) {
    return Resolution.RES_1080P;
  }
  return resolution;
}
import { GenerationProcessor } from './queue/generation.processor';
import {
  GENERATION_QUEUE,
  GENERATION_UNLIMITED_QUEUE,
  GenerationJobName,
  ImageJobData,
  ImageNanoBananaJobData,
  TextToVideoJobData,
  ImageToVideoJobData,
  ReferenceVideoJobData,
  MotionControlJobData,
  VirtualTryOnJobData,
  FaceSwapJobData,
  TextToVideoKieJobData,
  ImageToVideoKieJobData,
  ReferenceToVideoKieJobData,
  ImageToVideoGrokJobData,
  TextToVideoGrokJobData,
  OmniVideoJobData,
  OmniVideoClipData,
  SeedanceVideoJobData,
  TextToSpeechJobData,
  VoiceCloneJobData,
} from './queue/generation-queue.constants';
import { UnlimitedService } from '../unlimited/unlimited.service';
import { UnlimitedEligibility } from '../unlimited/unlimited.types';

type GenerationWithRelations = {
  id: string;
  type: GenerationType;
  status: GenerationStatus;
  prompt: string | null;
  negativePrompt: string | null;
  resolution: Resolution;
  durationSeconds: number | null;
  hasAudio: boolean;
  modelUsed: string;
  parameters: unknown;
  hasWatermark: boolean;
  creditsConsumed: number;
  processingTimeMs: number | null;
  errorMessage: string | null;
  errorCode: string | null;
  isFavorited: boolean;
  createdAt: Date;
  completedAt: Date | null;
  outputs: Array<{
    id: string;
    url: string;
    thumbnailUrl: string | null;
    mimeType: string | null;
    order: number;
  }>;
};

@Injectable()
export class GenerationsService {
  private readonly logger = new Logger(GenerationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditsService: CreditsService,
    private readonly plansService: PlansService,
    private readonly uploadsService: UploadsService,
    private readonly modelsService: ModelsService,
    private readonly voicesService: VoicesService,
    @InjectQueue(GENERATION_QUEUE) private readonly generationQueue: Queue,
    @InjectQueue(GENERATION_UNLIMITED_QUEUE)
    private readonly unlimitedQueue: Queue,
    private readonly generationProcessor: GenerationProcessor,
    private readonly unlimitedService: UnlimitedService,
  ) {}

  private isSeedream(model: string | undefined | null): boolean {
    return model === 'sem-censura';
  }

  private runSeedreamDirectly(data: ImageJobData): void {
    this.generationProcessor
      .runImageJobDirectly(data)
      .catch((err) =>
        this.logger.error(
          `Seedream direct run failed for ${data.generationId}: ${(err as Error).message}`,
          (err as Error).stack,
        ),
      );
  }

  private runTextToSpeechDirectly(data: TextToSpeechJobData): void {
    this.generationProcessor
      .runTextToSpeechDirectly(data)
      .catch((err) =>
        this.logger.error(
          `TTS direct run failed for ${data.generationId}: ${(err as Error).message}`,
          (err as Error).stack,
        ),
      );
  }

  private runVoiceCloneDirectly(data: VoiceCloneJobData): void {
    this.generationProcessor
      .runVoiceCloneDirectly(data)
      .catch((err) =>
        this.logger.error(
          `Voice clone direct run failed for ${data.generationId}: ${(err as Error).message}`,
          (err as Error).stack,
        ),
      );
  }

  // ─── Unlimited mode: status público ───────────────────────────

  async getUnlimitedStatus(userId: string) {
    const planContext = await this.unlimitedService.getPlanContext(userId);
    if (!planContext) {
      return {
        eligible: false,
        planSlug: null as string | null,
        models: [],
        usageCount: 0,
        hasActiveJob: false,
      };
    }

    const [usageCount, hasActiveJob] = await Promise.all([
      this.unlimitedService.countUsageWindow(userId),
      this.unlimitedService.isLocked(userId),
    ]);

    return {
      eligible: true,
      planSlug: planContext.planSlug,
      models: planContext.models,
      usageCount,
      hasActiveJob,
    };
  }

  // ─── Unlimited mode helpers ───────────────────────────────────

  /**
   * Valida elegibilidade do usuário para o modo ilimitado. Throws com HTTP
   * apropriado quando bloqueado, retorna `UnlimitedEligibility` quando ok.
   */
  private async validateUnlimitedOrThrow(
    userId: string,
    modelVariant: string | null,
    resolution: Resolution,
  ): Promise<UnlimitedEligibility> {
    if (!modelVariant) {
      throw new BadRequestException({
        code: 'UNLIMITED_MODEL_NOT_ALLOWED',
        message: 'Este modelo não está disponível no modo ilimitado.',
      });
    }

    const eligibility = await this.unlimitedService.checkEligibility(
      userId,
      modelVariant,
      resolution,
    );

    if (eligibility.allowed) return eligibility;

    switch (eligibility.reason) {
      case 'plan_not_unlimited':
        throw new ForbiddenException({
          code: 'UNLIMITED_PLAN_REQUIRED',
          message:
            'Seu plano atual não inclui o modo ilimitado. Faça upgrade para Creator, Pro, Advanced ou Studio.',
        });
      case 'model_not_allowed':
        throw new ForbiddenException({
          code: 'UNLIMITED_MODEL_NOT_ALLOWED',
          message:
            'Este modelo/resolução não está disponível no modo ilimitado do seu plano.',
        });
      case 'hard_cap_reached':
        throw new HttpException(
          {
            code: 'UNLIMITED_DAILY_CAP_REACHED',
            message:
              'Nossos servidores estão sobrecarregados no momento. Tente novamente em alguns minutos.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      default:
        throw new ForbiddenException({
          code: 'UNLIMITED_NOT_ALLOWED',
          message: 'Geração ilimitada indisponível.',
        });
    }
  }

  /**
   * Combina elegibilidade + acquire lock numa única chamada. Garante que o
   * lock é adquirido ANTES de qualquer escrita no banco (Generation), evitando
   * registros órfãos em PROCESSING quando há concorrência (2 cliques rápidos,
   * 2 abas, etc.).
   */
  private async reserveUnlimitedOrThrow(
    userId: string,
    modelVariant: string | null,
    resolution: Resolution,
  ): Promise<UnlimitedEligibility> {
    const eligibility = await this.validateUnlimitedOrThrow(
      userId,
      modelVariant,
      resolution,
    );
    const locked = await this.unlimitedService.acquireLock(userId);
    if (!locked) {
      throw new HttpException(
        {
          code: 'UNLIMITED_LOCK_HELD',
          message:
            'Você já tem uma geração ilimitada em andamento. Aguarde ela terminar antes de iniciar outra.',
        },
        HttpStatus.CONFLICT,
      );
    }
    return eligibility;
  }

  /**
   * Registra o uso e enfileira o job na queue ilimitada. **Pré-condição:**
   * o lock já foi adquirido (via `reserveUnlimitedOrThrow`). Em caso de erro
   * aqui, libera o lock pro usuário não ficar preso até o TTL expirar.
   * O worker libera o lock no completed/failed normal.
   */
  private async enqueueUnlimitedJob(
    eligibility: UnlimitedEligibility,
    args: {
      userId: string;
      generationId: string;
      modelVariant: string;
      resolution: Resolution;
      jobName: string;
      jobData: object;
    },
  ): Promise<void> {
    try {
      await this.unlimitedService.recordUsage({
        userId: args.userId,
        generationId: args.generationId,
        modelVariant: args.modelVariant,
        resolution: args.resolution,
      });

      await this.unlimitedQueue.add(args.jobName, args.jobData, {
        priority: eligibility.planContext!.unlimitedPriority,
        delay: eligibility.delayMs,
      });
    } catch (err) {
      await this.unlimitedService
        .releaseLock(args.userId)
        .catch(() => undefined);
      throw err;
    }
  }

  // ─── Image generation (text-to-image / image-to-image) ────

  async generateImage(
    userId: string,
    dto: GenerateImageDto,
  ): Promise<CreateGenerationResponseDto> {
    if (
      dto.model === 'sem-censura' &&
      dto.resolution !== Resolution.RES_2K &&
      dto.resolution !== Resolution.RES_4K
    ) {
      throw new BadRequestException(
        'Este modelo suporta apenas resoluções 2K ou 4K.',
      );
    }

    if (dto.model === 'sem-censura' && containsNsfwContent(dto.prompt)) {
      throw new BadRequestException(
        'Seu prompt contém termos não permitidos neste modelo. Remova-os e tente novamente.',
      );
    }

    if (dto.model === 'sem-censura') {
      await this.modelsService.assertActiveBySlug(dto.model, AiModelType.IMAGE);
    }

    if (dto.model === 'gpt-image-2') {
      if (dto.aspect_ratio === '1:1' && dto.resolution === Resolution.RES_4K) {
        throw new BadRequestException(
          'GPT Image 2 não suporta 4K com proporção 1:1. Use 2K ou outra proporção.',
        );
      }
    }

    const type = dto.images?.length
      ? GenerationType.IMAGE_TO_IMAGE
      : GenerationType.TEXT_TO_IMAGE;

    const modelVariant = dto.model_variant ?? getModelVariant(dto.model);
    const isUnlimited = dto.unlimited === true;

    await this.checkConcurrentLimit(userId);

    let eligibility: UnlimitedEligibility | undefined;
    let creditsRequired = 0;
    let isFreeGeneration = false;
    let freeGenType: FreeGenerationType | null = null;

    if (isUnlimited) {
      eligibility = await this.reserveUnlimitedOrThrow(
        userId,
        modelVariant,
        dto.resolution,
      );
    } else {
      freeGenType = await this.resolveFreeGenForRequest(
        userId,
        type,
        modelVariant,
      );
      isFreeGeneration = freeGenType !== null;
      creditsRequired = isFreeGeneration
        ? 0
        : await this.plansService.calculateGenerationCost(
            type,
            dto.resolution,
            undefined,
            false,
            1,
            modelVariant,
          );
      if (!isFreeGeneration) {
        await this.ensureSufficientBalance(userId, creditsRequired);
      }
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: dto.model,
        resolution: dto.resolution,
        aspectRatio: dto.aspect_ratio,
        hasAudio: false,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: {
          mimeType: dto.mime_type,
          ...(isUnlimited ? { unlimited: true } : {}),
        },
      },
    });

    if (dto.images?.length) {
      const uploadedUrls = await Promise.all(
        dto.images.map((img) =>
          this.uploadBase64Image(
            img.base64,
            img.mime_type ?? 'image/png',
            generation.id,
          ),
        ),
      );
      await this.prisma.generationInputImage.createMany({
        data: dto.images.map((img, i) => ({
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: img.mime_type ?? 'image/png',
          order: i,
          url: uploadedUrls[i],
        })),
      });
    }

    if (!isUnlimited) {
      if (isFreeGeneration && freeGenType) {
        await this.creditsService.consumeFreeGeneration(
          userId,
          generation.id,
          freeGenType,
        );
      } else {
        await this.debitCredits(
          userId,
          creditsRequired,
          generation.id,
          type,
          dto.resolution,
        );
      }
    }

    const jobData: ImageJobData = {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model: dto.model,
      resolution: dto.resolution,
      aspectRatio: dto.aspect_ratio,
      mimeType: dto.mime_type,
      hasInputImages: !!dto.images?.length,
    };

    if (isUnlimited) {
      await this.enqueueUnlimitedJob(eligibility!, {
        userId,
        generationId: generation.id,
        modelVariant: modelVariant!,
        resolution: dto.resolution,
        jobName: GenerationJobName.IMAGE,
        jobData,
      });
    } else if (this.isSeedream(dto.model)) {
      this.runSeedreamDirectly(jobData);
    } else {
      await this.generationQueue.add(GenerationJobName.IMAGE, jobData);
    }

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Upscale (image-to-image com prompt fixo, resolução fixa 2K) ──

  async generateUpscale(
    userId: string,
    dto: UpscaleImageDto,
  ): Promise<CreateGenerationResponseDto> {
    const UPSCALE_PROMPT =
      'Enhance image resolution to 4K quality while preserving all original details exactly. Improve sharpness, reduce compression artifacts, and enhance clarity without changing any visual elements. Maintain the exact same composition, colors, lighting, and all details.';

    return this.generateImageWithFallback(
      userId,
      {
        prompt: UPSCALE_PROMPT,
        model: dto.model,
        resolution: Resolution.RES_2K,
        mime_type: dto.mime_type ?? 'image/png',
        model_variant: dto.model_variant,
        images: [
          {
            base64: dto.image,
            mime_type: dto.mime_type ?? 'image/png',
          },
        ],
      } as GenerateImageDto,
      FreeGenerationType.UPSCALE,
    );
  }

  // ─── Image generation with fallback (theaimodelab → nano-banana) ─

  async generateImageWithFallback(
    userId: string,
    dto: GenerateImageDto,
    freeGenerationTypeOverride?: FreeGenerationType,
  ): Promise<CreateGenerationResponseDto> {
    const type = dto.images?.length
      ? GenerationType.IMAGE_TO_IMAGE
      : GenerationType.TEXT_TO_IMAGE;

    const modelVariant = dto.model_variant ?? getModelVariant(dto.model);
    const isUnlimited = dto.unlimited === true;

    await this.checkConcurrentLimit(userId);

    let eligibility: UnlimitedEligibility | undefined;
    let creditsRequired = 0;
    let isFreeGeneration = false;
    let freeGenType: FreeGenerationType | null = null;

    if (isUnlimited) {
      eligibility = await this.reserveUnlimitedOrThrow(
        userId,
        modelVariant,
        dto.resolution,
      );
    } else {
      freeGenType = await this.resolveFreeGenForRequest(
        userId,
        type,
        modelVariant,
        freeGenerationTypeOverride,
      );
      isFreeGeneration = freeGenType !== null;
      creditsRequired = isFreeGeneration
        ? 0
        : await this.plansService.calculateGenerationCost(
            type,
            dto.resolution,
            undefined,
            false,
            1,
            modelVariant,
          );
      if (!isFreeGeneration) {
        await this.ensureSufficientBalance(userId, creditsRequired);
      }
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: dto.model,
        resolution: dto.resolution,
        aspectRatio: dto.aspect_ratio,
        hasAudio: false,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: {
          mimeType: dto.mime_type,
          provider: 'theaimodelab',
          ...(isUnlimited ? { unlimited: true } : {}),
        },
      },
    });

    if (dto.images?.length) {
      const uploadedUrls = await Promise.all(
        dto.images.map((img) =>
          this.uploadBase64Image(
            img.base64,
            img.mime_type ?? 'image/png',
            generation.id,
          ),
        ),
      );
      await this.prisma.generationInputImage.createMany({
        data: dto.images.map((img, i) => ({
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: img.mime_type ?? 'image/png',
          order: i,
          url: uploadedUrls[i],
        })),
      });
    }

    if (!isUnlimited) {
      if (isFreeGeneration && freeGenType) {
        await this.creditsService.consumeFreeGeneration(
          userId,
          generation.id,
          freeGenType,
        );
      } else {
        await this.debitCredits(
          userId,
          creditsRequired,
          generation.id,
          type,
          dto.resolution,
        );
      }
    }

    const jobDataFallback: ImageJobData = {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model: dto.model,
      resolution: dto.resolution,
      aspectRatio: dto.aspect_ratio,
      mimeType: dto.mime_type,
      hasInputImages: !!dto.images?.length,
    };

    if (isUnlimited) {
      await this.enqueueUnlimitedJob(eligibility!, {
        userId,
        generationId: generation.id,
        modelVariant: modelVariant!,
        resolution: dto.resolution,
        jobName: GenerationJobName.IMAGE_WITH_FALLBACK,
        jobData: jobDataFallback,
      });
    } else if (this.isSeedream(dto.model)) {
      this.runSeedreamDirectly(jobDataFallback);
    } else {
      await this.generationQueue.add(
        GenerationJobName.IMAGE_WITH_FALLBACK,
        jobDataFallback,
      );
    }

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Image generation via Nano Banana 2 (kie-api) ────────

  async generateImageNanoBanana(
    userId: string,
    dto: GenerateImageNanoBananaDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = dto.images?.length
      ? GenerationType.IMAGE_TO_IMAGE
      : GenerationType.TEXT_TO_IMAGE;

    const modelVariant =
      dto.model_variant ?? getModelVariant(dto.model ?? 'nano-banana-2');
    const isUnlimited = dto.unlimited === true;

    await this.checkConcurrentLimit(userId);

    let eligibility: UnlimitedEligibility | undefined;
    let creditsRequired = 0;
    let isFreeGeneration = false;
    let freeGenType: FreeGenerationType | null = null;

    if (isUnlimited) {
      eligibility = await this.reserveUnlimitedOrThrow(
        userId,
        modelVariant,
        dto.resolution,
      );
    } else {
      freeGenType = await this.resolveFreeGenForRequest(
        userId,
        type,
        modelVariant,
      );
      isFreeGeneration = freeGenType !== null;
      creditsRequired = isFreeGeneration
        ? 0
        : await this.plansService.calculateGenerationCost(
            type,
            dto.resolution,
            undefined,
            false,
            1,
            modelVariant,
          );
      if (!isFreeGeneration) {
        await this.ensureSufficientBalance(userId, creditsRequired);
      }
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: dto.model ?? 'nano-banana-2',
        resolution: dto.resolution,
        aspectRatio: dto.aspect_ratio,
        hasAudio: false,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: {
          output_format: dto.output_format,
          google_search: dto.google_search,
          ...(isUnlimited ? { unlimited: true } : {}),
        },
      },
    });

    let imageUrls: string[] | undefined;
    if (dto.images?.length) {
      const uploadedUrls = await Promise.all(
        dto.images.map((img) =>
          this.uploadBase64Image(
            img.base64,
            img.mime_type ?? 'image/png',
            generation.id,
          ),
        ),
      );
      await this.prisma.generationInputImage.createMany({
        data: dto.images.map((img, i) => ({
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: img.mime_type ?? 'image/png',
          order: i,
          url: uploadedUrls[i],
        })),
      });
      imageUrls = uploadedUrls;
    }

    if (!isUnlimited) {
      if (isFreeGeneration && freeGenType) {
        await this.creditsService.consumeFreeGeneration(
          userId,
          generation.id,
          freeGenType,
        );
      } else {
        await this.debitCredits(
          userId,
          creditsRequired,
          generation.id,
          type,
          dto.resolution,
        );
      }
    }

    const jobData: ImageNanoBananaJobData = {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model: dto.model ?? 'nano-banana-2',
      resolution: dto.resolution,
      aspectRatio: dto.aspect_ratio,
      outputFormat: dto.output_format,
      googleSearch: dto.google_search,
      imageUrls,
    };

    if (isUnlimited) {
      await this.enqueueUnlimitedJob(eligibility!, {
        userId,
        generationId: generation.id,
        modelVariant: modelVariant!,
        resolution: dto.resolution,
        jobName: GenerationJobName.IMAGE_NANO_BANANA,
        jobData,
      });
    } else {
      await this.generationQueue.add(
        GenerationJobName.IMAGE_NANO_BANANA,
        jobData,
      );
    }

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Text to Video ────────────────────────────────────────

  async generateTextToVideo(
    userId: string,
    dto: GenerateVideoTextToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.TEXT_TO_VIDEO;
    const hasAudio = dto.generate_audio ?? true;

    const sampleCount = dto.unlimited === true ? 1 : (dto.sample_count ?? 1);

    const modelVariant = dto.model_variant ?? getModelVariant(dto.model);
    const isUnlimited = dto.unlimited === true;

    await this.modelsService.assertActiveBySlug(
      normalizeVideoModelSlug(dto.model),
      AiModelType.VIDEO,
    );

    // The AI Model Lab models: 4K is generated as 1080p internally, but charged at 4K
    const providerResolution = effectiveVideoResolution(
      dto.resolution,
      modelVariant,
    );

    await this.checkConcurrentLimit(userId);

    let eligibility: UnlimitedEligibility | undefined;
    let creditsRequired = 0;
    let isFreeGeneration = false;

    if (isUnlimited) {
      eligibility = await this.reserveUnlimitedOrThrow(
        userId,
        modelVariant,
        dto.resolution,
      );
    } else {
      const veoAccess = await this.checkVeoAccess(userId, modelVariant);
      isFreeGeneration = veoAccess === 'free_generation';
      creditsRequired = isFreeGeneration
        ? 0
        : await this.plansService.calculateGenerationCost(
            type,
            dto.resolution,
            dto.duration_seconds,
            hasAudio,
            sampleCount,
            modelVariant,
          );
      if (!isFreeGeneration) {
        await this.ensureSufficientBalance(userId, creditsRequired);
      }
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        negativePrompt: dto.negative_prompt,
        modelUsed: dto.model,
        resolution: dto.resolution,
        durationSeconds: dto.duration_seconds,
        hasAudio,
        aspectRatio: dto.aspect_ratio,
        quantity: sampleCount,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        ...(isUnlimited ? { parameters: { unlimited: true } } : {}),
      },
    });

    if (!isUnlimited) {
      if (isFreeGeneration) {
        await this.creditsService.consumeFreeGeneration(
          userId,
          generation.id,
          FreeGenerationType.THEAIMODELAB_FAST,
        );
      } else {
        await this.debitCredits(
          userId,
          creditsRequired,
          generation.id,
          type,
          dto.resolution,
        );
      }
    }

    const jobData: TextToVideoJobData = {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model: dto.model,
      resolution: providerResolution, // The AI Model Lab 4K → 1080p for actual generation
      durationSeconds: dto.duration_seconds,
      aspectRatio: dto.aspect_ratio,
      generateAudio: hasAudio,
      sampleCount,
      negativePrompt: dto.negative_prompt,
    };

    if (isUnlimited) {
      await this.enqueueUnlimitedJob(eligibility!, {
        userId,
        generationId: generation.id,
        modelVariant: modelVariant!,
        resolution: dto.resolution,
        jobName: GenerationJobName.TEXT_TO_VIDEO,
        jobData,
      });
    } else {
      await this.generationQueue.add(GenerationJobName.TEXT_TO_VIDEO, jobData);
    }

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Image to Video ───────────────────────────────────────

  async generateImageToVideo(
    userId: string,
    dto: GenerateVideoImageToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.IMAGE_TO_VIDEO;
    const model = dto.model ?? 'veo-3.1-generate-001';
    const hasAudio = dto.generate_audio ?? true;

    const sampleCount = dto.unlimited === true ? 1 : (dto.sample_count ?? 1);

    const modelVariant = dto.model_variant ?? getModelVariant(model);
    const isUnlimited = dto.unlimited === true;

    await this.modelsService.assertActiveBySlug(
      normalizeVideoModelSlug(model),
      AiModelType.VIDEO,
    );

    // The AI Model Lab models: 4K is generated as 1080p internally, but charged at 4K
    const providerResolution = effectiveVideoResolution(
      dto.resolution,
      modelVariant,
    );

    await this.checkConcurrentLimit(userId);

    let eligibility: UnlimitedEligibility | undefined;
    let creditsRequired = 0;
    let isFreeGeneration = false;

    if (isUnlimited) {
      eligibility = await this.reserveUnlimitedOrThrow(
        userId,
        modelVariant,
        dto.resolution,
      );
    } else {
      const veoAccess = await this.checkVeoAccess(userId, modelVariant);
      isFreeGeneration = veoAccess === 'free_generation';
      creditsRequired = isFreeGeneration
        ? 0
        : await this.plansService.calculateGenerationCost(
            type,
            dto.resolution,
            dto.duration_seconds,
            hasAudio,
            sampleCount,
            modelVariant,
          );
      if (!isFreeGeneration) {
        await this.ensureSufficientBalance(userId, creditsRequired);
      }
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        negativePrompt: dto.negative_prompt,
        modelUsed: model,
        resolution: dto.resolution,
        durationSeconds: dto.duration_seconds,
        hasAudio,
        aspectRatio: dto.aspect_ratio,
        quantity: sampleCount,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        ...(isUnlimited ? { parameters: { unlimited: true } } : {}),
      },
    });

    const firstFrameUrl = await this.uploadBase64Image(
      dto.first_frame,
      dto.first_frame_mime_type ?? 'image/jpeg',
      generation.id,
    );
    const inputImageData: Array<{
      generationId: string;
      role: GenerationImageRole;
      mimeType: string;
      order: number;
      url: string;
    }> = [
      {
        generationId: generation.id,
        role: GenerationImageRole.FIRST_FRAME,
        mimeType: dto.first_frame_mime_type ?? 'image/jpeg',
        order: 0,
        url: firstFrameUrl,
      },
    ];
    if (dto.last_frame) {
      const lastFrameUrl = await this.uploadBase64Image(
        dto.last_frame,
        dto.last_frame_mime_type ?? 'image/jpeg',
        generation.id,
      );
      inputImageData.push({
        generationId: generation.id,
        role: GenerationImageRole.LAST_FRAME,
        mimeType: dto.last_frame_mime_type ?? 'image/jpeg',
        order: 1,
        url: lastFrameUrl,
      });
    }
    await this.prisma.generationInputImage.createMany({ data: inputImageData });

    if (!isUnlimited) {
      if (isFreeGeneration) {
        await this.creditsService.consumeFreeGeneration(
          userId,
          generation.id,
          FreeGenerationType.THEAIMODELAB_FAST,
        );
      } else {
        await this.debitCredits(
          userId,
          creditsRequired,
          generation.id,
          type,
          dto.resolution,
        );
      }
    }

    const jobData: ImageToVideoJobData = {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model: dto.model ?? model,
      resolution: providerResolution, // The AI Model Lab 4K → 1080p for actual generation
      durationSeconds: dto.duration_seconds,
      aspectRatio: dto.aspect_ratio,
      generateAudio: hasAudio,
      sampleCount,
      negativePrompt: dto.negative_prompt,
      resolvedModel: model,
    };

    if (isUnlimited) {
      await this.enqueueUnlimitedJob(eligibility!, {
        userId,
        generationId: generation.id,
        modelVariant: modelVariant!,
        resolution: dto.resolution,
        jobName: GenerationJobName.IMAGE_TO_VIDEO,
        jobData,
      });
    } else {
      await this.generationQueue.add(GenerationJobName.IMAGE_TO_VIDEO, jobData);
    }

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Video with References ────────────────────────────────

  async generateVideoWithReferences(
    userId: string,
    dto: GenerateVideoWithReferencesDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.REFERENCE_VIDEO;
    const model = dto.model ?? 'veo-3.1-generate-001';
    const hasAudio = dto.generate_audio ?? true;

    const sampleCount = dto.unlimited === true ? 1 : (dto.sample_count ?? 1);

    const modelVariant = dto.model_variant ?? getModelVariant(model);
    const isUnlimited = dto.unlimited === true;

    await this.modelsService.assertActiveBySlug(
      normalizeVideoModelSlug(model),
      AiModelType.VIDEO,
    );

    // The AI Model Lab models: 4K is generated as 1080p internally, but charged at 4K
    const providerResolution = effectiveVideoResolution(
      dto.resolution,
      modelVariant,
    );

    await this.checkConcurrentLimit(userId);

    let eligibility: UnlimitedEligibility | undefined;
    let creditsRequired = 0;
    let isFreeGeneration = false;

    if (isUnlimited) {
      eligibility = await this.reserveUnlimitedOrThrow(
        userId,
        modelVariant,
        dto.resolution,
      );
    } else {
      const veoAccess = await this.checkVeoAccess(userId, modelVariant);
      isFreeGeneration = veoAccess === 'free_generation';
      creditsRequired = isFreeGeneration
        ? 0
        : await this.plansService.calculateGenerationCost(
            type,
            dto.resolution,
            dto.duration_seconds,
            hasAudio,
            sampleCount,
            modelVariant,
          );
      if (!isFreeGeneration) {
        await this.ensureSufficientBalance(userId, creditsRequired);
      }
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        negativePrompt: dto.negative_prompt,
        modelUsed: model,
        resolution: dto.resolution,
        durationSeconds: dto.duration_seconds,
        hasAudio,
        aspectRatio: dto.aspect_ratio,
        quantity: sampleCount,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        ...(isUnlimited ? { parameters: { unlimited: true } } : {}),
      },
    });

    if (dto.reference_images?.length) {
      const uploadedUrls = await Promise.all(
        dto.reference_images.map((ref) =>
          this.uploadBase64Image(
            ref.base64,
            ref.mime_type ?? 'image/jpeg',
            generation.id,
          ),
        ),
      );
      await this.prisma.generationInputImage.createMany({
        data: dto.reference_images.map((ref, i) => ({
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: ref.mime_type ?? 'image/jpeg',
          order: i,
          referenceType: ref.reference_type,
          url: uploadedUrls[i],
        })),
      });
    }

    if (!isUnlimited) {
      if (isFreeGeneration) {
        await this.creditsService.consumeFreeGeneration(
          userId,
          generation.id,
          FreeGenerationType.THEAIMODELAB_FAST,
        );
      } else {
        await this.debitCredits(
          userId,
          creditsRequired,
          generation.id,
          type,
          dto.resolution,
        );
      }
    }

    const jobData: ReferenceVideoJobData = {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model: dto.model ?? model,
      resolution: providerResolution, // The AI Model Lab 4K → 1080p for actual generation
      durationSeconds: dto.duration_seconds,
      aspectRatio: dto.aspect_ratio,
      generateAudio: hasAudio,
      sampleCount,
      negativePrompt: dto.negative_prompt,
      resolvedModel: model,
    };

    if (isUnlimited) {
      await this.enqueueUnlimitedJob(eligibility!, {
        userId,
        generationId: generation.id,
        modelVariant: modelVariant!,
        resolution: dto.resolution,
        jobName: GenerationJobName.REFERENCE_VIDEO,
        jobData,
      });
    } else {
      await this.generationQueue.add(
        GenerationJobName.REFERENCE_VIDEO,
        jobData,
      );
    }

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Motion Control (Kling 2.6) ───────────────────────────

  async generateMotionControl(
    userId: string,
    dto: GenerateMotionControlDto,
  ): Promise<CreateGenerationResponseDto> {
    // Feature gate — admin can disable motion control via /admin/modelos.
    await this.modelsService.assertActiveBySlug(
      'motion-control',
      AiModelType.VIDEO,
    );

    const type = GenerationType.MOTION_CONTROL;
    const resolution = dto.resolution ?? '720p';
    const dbResolution =
      resolution === '1080p' ? Resolution.RES_1080P : Resolution.RES_720P;

    const videoBuffer = Buffer.from(dto.video, 'base64');
    const durationSeconds = getVideoDurationSeconds(videoBuffer);

    const creditsRequired = await this.plansService.calculateGenerationCost(
      type,
      dbResolution,
      durationSeconds,
      false,
    );

    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, creditsRequired);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        modelUsed: 'kling-2.6/motion-control',
        resolution: dbResolution,
        durationSeconds,
        hasAudio: false,
        creditsConsumed: creditsRequired,
        parameters: { resolution },
      },
    });

    // Upload video to S3 — public URL for Wan API, signed URL for internal display
    const videoMime = dto.video_mime_type ?? 'video/mp4';
    const videoExt =
      videoMime === 'video/quicktime'
        ? 'mov'
        : videoMime === 'video/x-matroska'
          ? 'mkv'
          : 'mp4';
    const { publicUrl: videoPublicUrl, signedUrl: videoSignedUrl } =
      await this.uploadsService.uploadBufferPublic(
        videoBuffer,
        `inputs/${generation.id}`,
        `input_video.${videoExt}`,
        videoMime,
      );

    // Upload image to S3 — public URL for Wan API, signed URL for internal display
    const imageMime = dto.image_mime_type ?? 'image/jpeg';
    const imageExt =
      imageMime === 'image/png'
        ? 'png'
        : imageMime === 'image/webp'
          ? 'webp'
          : 'jpg';
    const imageBuffer = Buffer.from(dto.image, 'base64');
    const { publicUrl: imagePublicUrl, signedUrl: imageSignedUrl } =
      await this.uploadsService.uploadBufferPublic(
        imageBuffer,
        `inputs/${generation.id}`,
        `input_image.${imageExt}`,
        imageMime,
      );

    // Save input images for reference (signed URLs for internal display)
    await this.prisma.generationInputImage.createMany({
      data: [
        {
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: videoMime,
          order: 0,
          url: videoSignedUrl,
        },
        {
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: imageMime,
          order: 1,
          url: imageSignedUrl,
        },
      ],
    });

    await this.debitCredits(
      userId,
      creditsRequired,
      generation.id,
      type,
      dbResolution,
    );

    await this.generationQueue.add(GenerationJobName.MOTION_CONTROL, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      videoUrl: videoPublicUrl,
      imageUrl: imagePublicUrl,
      resolution,
    } satisfies MotionControlJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Virtual Try-On ──────────────────────────────────────

  async generateVirtualTryOn(
    userId: string,
    dto: GenerateVirtualTryOnDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.VIRTUAL_TRY_ON;
    const model = dto.model ?? 'gemini-3.1-flash-image-preview';
    const resolution = dto.resolution ?? Resolution.RES_2K;

    const modelVariant = dto.model_variant ?? getModelVariant(model);

    const freeGenType = await this.resolveFreeGenForRequest(
      userId,
      type,
      modelVariant,
    );
    const isFreeGeneration = freeGenType !== null;

    const creditsRequired = isFreeGeneration
      ? 0
      : await this.plansService.calculateGenerationCost(
          type,
          resolution,
          undefined,
          false,
          1,
          modelVariant,
        );

    await this.checkConcurrentLimit(userId);
    if (!isFreeGeneration) {
      await this.ensureSufficientBalance(userId, creditsRequired);
    }

    const prompt = this.buildVirtualTryOnPrompt(dto.additional_instructions);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt,
        modelUsed: model,
        resolution,
        aspectRatio: dto.aspect_ratio ?? '3:4',
        hasAudio: false,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: {
          feature: 'virtual_try_on',
          mimeType: dto.output_mime_type ?? 'image/png',
        },
      },
    });

    // Upload influencer image
    const influencerUrl = await this.uploadBase64Image(
      dto.influencer_image,
      dto.influencer_image_mime_type ?? 'image/png',
      generation.id,
    );

    // Upload clothing image
    const clothingUrl = await this.uploadBase64Image(
      dto.clothing_image,
      dto.clothing_image_mime_type ?? 'image/png',
      generation.id,
    );

    await this.prisma.generationInputImage.createMany({
      data: [
        {
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: dto.influencer_image_mime_type ?? 'image/png',
          order: 0,
          url: influencerUrl,
        },
        {
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: dto.clothing_image_mime_type ?? 'image/png',
          order: 1,
          url: clothingUrl,
        },
      ],
    });

    if (isFreeGeneration) {
      await this.creditsService.consumeFreeGeneration(
        userId,
        generation.id,
        freeGenType,
      );
    } else {
      await this.debitCredits(
        userId,
        creditsRequired,
        generation.id,
        type,
        resolution,
      );
    }

    await this.generationQueue.add(GenerationJobName.VIRTUAL_TRY_ON, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt,
      model,
      resolution,
      aspectRatio: dto.aspect_ratio ?? '3:4',
      mimeType: dto.output_mime_type ?? 'image/png',
    } satisfies VirtualTryOnJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  private buildVirtualTryOnPrompt(additionalInstructions?: string): string {
    let prompt = `Virtual try-on: Using the provided images, dress the person from the first image (the model/influencer) in the exact clothing item shown in the second image.

CRITICAL REQUIREMENTS:
- The person's face, body proportions, skin tone, hair, and overall appearance MUST remain exactly the same — do NOT alter them.
- The clothing from the second image must be placed naturally on the person's body, respecting the body's pose, proportions, and perspective.
- Preserve the exact design, color, pattern, texture, and style of the clothing item. Do not modify, simplify, or reinterpret the garment.
- The clothing must fit naturally on the body — proper draping, folds, and shadows that match the body's pose and lighting.
- Maintain the lighting, shadows, and overall photographic quality of the original person image.
- The result should look like a real, high-quality photograph — not a collage or digital overlay.
- Keep the background and environment from the first image (the person's photo).`;

    if (additionalInstructions) {
      prompt += `\n\nAdditional instructions: ${additionalInstructions}`;
    }

    return prompt;
  }

  // ─── Face Swap ──────────────────────────────────────────

  async generateFaceSwap(
    userId: string,
    dto: GenerateFaceSwapDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.FACE_SWAP;
    const resolutionMap: Record<string, Resolution> = {
      '1K': Resolution.RES_1K,
      '2K': Resolution.RES_2K,
      '4K': Resolution.RES_4K,
    };
    const resolution =
      resolutionMap[dto.resolution ?? '2K'] ?? Resolution.RES_2K;

    const modelVariant = getModelVariant('nano-banana-2');

    const freeGenType = await this.resolveFreeGenForRequest(
      userId,
      type,
      modelVariant,
    );
    const isFreeGeneration = freeGenType !== null;

    const creditsRequired = isFreeGeneration
      ? 0
      : await this.plansService.calculateGenerationCost(
          type,
          resolution,
          undefined,
          false,
          1,
          modelVariant,
        );

    await this.checkConcurrentLimit(userId);
    if (!isFreeGeneration) {
      await this.ensureSufficientBalance(userId, creditsRequired);
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: 'Face Swap',
        modelUsed: 'nano-banana-2',
        resolution,
        hasAudio: false,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: { feature: 'face_swap' },
      },
    });

    // Upload source image (face)
    const sourceUrl = await this.uploadBase64Image(
      dto.source_image,
      dto.source_image_mime_type ?? 'image/jpeg',
      generation.id,
    );

    // Upload target image (scene/body)
    const targetUrl = await this.uploadBase64Image(
      dto.target_image,
      dto.target_image_mime_type ?? 'image/jpeg',
      generation.id,
    );

    await this.prisma.generationInputImage.createMany({
      data: [
        {
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: dto.source_image_mime_type ?? 'image/jpeg',
          order: 0,
          url: sourceUrl,
        },
        {
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: dto.target_image_mime_type ?? 'image/jpeg',
          order: 1,
          url: targetUrl,
        },
      ],
    });

    if (isFreeGeneration) {
      await this.creditsService.consumeFreeGeneration(
        userId,
        generation.id,
        freeGenType,
      );
    } else {
      await this.debitCredits(
        userId,
        creditsRequired,
        generation.id,
        type,
        resolution,
      );
    }

    await this.generationQueue.add(GenerationJobName.FACE_SWAP, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      sourceImageUrl: sourceUrl,
      targetImageUrl: targetUrl,
      resolution: dto.resolution ?? '2K',
    } satisfies FaceSwapJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Kie Veo — Text to Video ─────────────────────────────

  async generateTextToVideoKie(
    userId: string,
    dto: GenerateVeoKieTextToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.TEXT_TO_VIDEO;
    const model = dto.model ?? 'veo3_fast';
    const hasAudio = dto.generate_audio ?? true;

    const modelVariant = dto.model_variant ?? getModelVariant(model);

    await this.modelsService.assertActiveBySlug(model, AiModelType.VIDEO);

    const veoAccess = await this.checkVeoAccess(userId, modelVariant, 'kie');
    const isFreeGeneration = veoAccess === 'free_generation';

    const creditsRequired = isFreeGeneration
      ? 0
      : await this.plansService.calculateGenerationCost(
          type,
          dto.resolution,
          undefined,
          hasAudio,
          1,
          modelVariant,
        );

    await this.checkConcurrentLimit(userId);

    if (!isFreeGeneration) {
      await this.ensureSufficientBalance(userId, creditsRequired);
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: model,
        resolution: dto.resolution,
        hasAudio,
        aspectRatio: dto.aspect_ratio,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: { provider: 'kie', seed: dto.seed },
      },
    });

    if (isFreeGeneration) {
      await this.creditsService.consumeFreeGeneration(
        userId,
        generation.id,
        FreeGenerationType.THEAIMODELAB_FAST,
      );
    } else {
      await this.debitCredits(
        userId,
        creditsRequired,
        generation.id,
        type,
        dto.resolution,
      );
    }

    await this.generationQueue.add(GenerationJobName.TEXT_TO_VIDEO_KIE, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model,
      resolution: dto.resolution,
      aspectRatio: dto.aspect_ratio,
      generateAudio: hasAudio,
      seed: dto.seed,
    } satisfies TextToVideoKieJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Kie Veo — Image to Video ──────────────────────────────

  async generateImageToVideoKie(
    userId: string,
    dto: GenerateVeoKieImageToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.IMAGE_TO_VIDEO;
    const model = dto.model ?? 'veo3_fast';
    const hasAudio = dto.generate_audio ?? true;

    const modelVariant = dto.model_variant ?? getModelVariant(model);

    await this.modelsService.assertActiveBySlug(model, AiModelType.VIDEO);

    const veoAccess = await this.checkVeoAccess(userId, modelVariant, 'kie');
    const isFreeGeneration = veoAccess === 'free_generation';

    const creditsRequired = isFreeGeneration
      ? 0
      : await this.plansService.calculateGenerationCost(
          type,
          dto.resolution,
          undefined,
          hasAudio,
          1,
          modelVariant,
        );

    await this.checkConcurrentLimit(userId);

    if (!isFreeGeneration) {
      await this.ensureSufficientBalance(userId, creditsRequired);
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: model,
        resolution: dto.resolution,
        hasAudio,
        aspectRatio: dto.aspect_ratio,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: { provider: 'kie', seed: dto.seed },
      },
    });

    // Upload frames to S3 and get public URLs for Kie API
    const firstFrameUrl = await this.uploadBase64ImagePublic(
      dto.first_frame,
      dto.first_frame_mime_type ?? 'image/jpeg',
      generation.id,
    );

    const inputImageData: Array<{
      generationId: string;
      role: GenerationImageRole;
      mimeType: string;
      order: number;
      url: string;
    }> = [
      {
        generationId: generation.id,
        role: GenerationImageRole.FIRST_FRAME,
        mimeType: dto.first_frame_mime_type ?? 'image/jpeg',
        order: 0,
        url: firstFrameUrl,
      },
    ];

    const imageUrls: string[] = [firstFrameUrl];

    if (dto.last_frame) {
      const lastFrameUrl = await this.uploadBase64ImagePublic(
        dto.last_frame,
        dto.last_frame_mime_type ?? 'image/jpeg',
        generation.id,
      );
      inputImageData.push({
        generationId: generation.id,
        role: GenerationImageRole.LAST_FRAME,
        mimeType: dto.last_frame_mime_type ?? 'image/jpeg',
        order: 1,
        url: lastFrameUrl,
      });
      imageUrls.push(lastFrameUrl);
    }

    await this.prisma.generationInputImage.createMany({ data: inputImageData });

    if (isFreeGeneration) {
      await this.creditsService.consumeFreeGeneration(
        userId,
        generation.id,
        FreeGenerationType.THEAIMODELAB_FAST,
      );
    } else {
      await this.debitCredits(
        userId,
        creditsRequired,
        generation.id,
        type,
        dto.resolution,
      );
    }

    await this.generationQueue.add(GenerationJobName.IMAGE_TO_VIDEO_KIE, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model,
      resolution: dto.resolution,
      aspectRatio: dto.aspect_ratio,
      generateAudio: hasAudio,
      seed: dto.seed,
      imageUrls,
    } satisfies ImageToVideoKieJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Kie Veo — Reference to Video ───────────────────────────

  async generateReferenceToVideoKie(
    userId: string,
    dto: GenerateVeoKieReferenceToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.IMAGE_TO_VIDEO;
    const model = 'veo3_fast'; // REFERENCE_2_VIDEO only supports veo3_fast
    const hasAudio = dto.generate_audio ?? true;

    const modelVariant = dto.model_variant ?? 'VEO_FAST';

    await this.modelsService.assertActiveBySlug(model, AiModelType.VIDEO);

    const veoAccess = await this.checkVeoAccess(userId, modelVariant, 'kie');
    const isFreeGeneration = veoAccess === 'free_generation';

    const creditsRequired = isFreeGeneration
      ? 0
      : await this.plansService.calculateGenerationCost(
          type,
          dto.resolution,
          undefined,
          hasAudio,
          1,
          modelVariant,
        );

    await this.checkConcurrentLimit(userId);

    if (!isFreeGeneration) {
      await this.ensureSufficientBalance(userId, creditsRequired);
    }

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: model,
        resolution: dto.resolution,
        hasAudio,
        aspectRatio: dto.aspect_ratio,
        creditsConsumed: creditsRequired,
        usedFreeGeneration: isFreeGeneration,
        parameters: {
          provider: 'kie',
          seed: dto.seed,
          generationType: 'REFERENCE_2_VIDEO',
        },
      },
    });

    // Upload reference images to S3 and get public URLs for Kie API
    const mimeTypes = dto.reference_images_mime_types ?? [];
    const imageUrls: string[] = [];

    for (let i = 0; i < dto.reference_images.length; i++) {
      const mime = mimeTypes[i] ?? 'image/jpeg';
      const publicUrl = await this.uploadBase64ImagePublic(
        dto.reference_images[i],
        mime,
        generation.id,
      );
      imageUrls.push(publicUrl);
    }

    await this.prisma.generationInputImage.createMany({
      data: dto.reference_images.map((_, i) => ({
        generationId: generation.id,
        role: GenerationImageRole.REFERENCE,
        mimeType: mimeTypes[i] ?? 'image/jpeg',
        order: i,
        url: imageUrls[i],
      })),
    });

    if (isFreeGeneration) {
      await this.creditsService.consumeFreeGeneration(
        userId,
        generation.id,
        FreeGenerationType.THEAIMODELAB_FAST,
      );
    } else {
      await this.debitCredits(
        userId,
        creditsRequired,
        generation.id,
        type,
        dto.resolution,
      );
    }

    await this.generationQueue.add(GenerationJobName.REFERENCE_TO_VIDEO_KIE, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      usedFreeGeneration: isFreeGeneration,
      prompt: dto.prompt,
      model,
      resolution: dto.resolution,
      aspectRatio: dto.aspect_ratio,
      generateAudio: hasAudio,
      seed: dto.seed,
      imageUrls,
    } satisfies ReferenceToVideoKieJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Grok Imagine — Image to Video ──────────────────────────

  async generateImageToVideoGrokImagine(
    userId: string,
    dto: GenerateGrokImagineImageToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.IMAGE_TO_VIDEO;
    const model = 'grok-imagine';
    const modelVariant = dto.model_variant ?? getModelVariant(model);

    await this.modelsService.assertActiveBySlug(model, AiModelType.VIDEO);

    const creditsRequired = await this.plansService.calculateGenerationCost(
      type,
      dto.resolution,
      dto.duration_seconds,
      false,
      1,
      modelVariant,
    );

    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, creditsRequired);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: model,
        resolution: dto.resolution,
        durationSeconds: dto.duration_seconds,
        hasAudio: false,
        aspectRatio: dto.aspect_ratio,
        creditsConsumed: creditsRequired,
        parameters: { provider: 'kie', mode: 'normal' },
      },
    });

    const firstFrameUrl = await this.uploadBase64ImagePublic(
      dto.first_frame,
      dto.first_frame_mime_type ?? 'image/jpeg',
      generation.id,
    );

    const inputImageData: Array<{
      generationId: string;
      role: GenerationImageRole;
      mimeType: string;
      order: number;
      url: string;
    }> = [
      {
        generationId: generation.id,
        role: GenerationImageRole.FIRST_FRAME,
        mimeType: dto.first_frame_mime_type ?? 'image/jpeg',
        order: 0,
        url: firstFrameUrl,
      },
    ];

    const imageUrls: string[] = [firstFrameUrl];

    if (dto.last_frame) {
      const lastFrameUrl = await this.uploadBase64ImagePublic(
        dto.last_frame,
        dto.last_frame_mime_type ?? 'image/jpeg',
        generation.id,
      );
      inputImageData.push({
        generationId: generation.id,
        role: GenerationImageRole.LAST_FRAME,
        mimeType: dto.last_frame_mime_type ?? 'image/jpeg',
        order: 1,
        url: lastFrameUrl,
      });
      imageUrls.push(lastFrameUrl);
    }

    await this.prisma.generationInputImage.createMany({ data: inputImageData });

    await this.debitCredits(
      userId,
      creditsRequired,
      generation.id,
      type,
      dto.resolution,
    );

    await this.generationQueue.add(GenerationJobName.IMAGE_TO_VIDEO_GROK, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      prompt: dto.prompt,
      resolution: dto.resolution,
      durationSeconds: dto.duration_seconds,
      aspectRatio: dto.aspect_ratio,
      imageUrls,
      mode: 'normal',
    } satisfies ImageToVideoGrokJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Grok Imagine — Text to Video ──────────────────────────

  async generateTextToVideoGrokImagine(
    userId: string,
    dto: GenerateGrokImagineTextToVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const type = GenerationType.TEXT_TO_VIDEO;
    const model = 'grok-imagine';
    const modelVariant = dto.model_variant ?? getModelVariant(model);

    await this.modelsService.assertActiveBySlug(model, AiModelType.VIDEO);

    const creditsRequired = await this.plansService.calculateGenerationCost(
      type,
      dto.resolution,
      dto.duration_seconds,
      false,
      1,
      modelVariant,
    );

    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, creditsRequired);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: model,
        resolution: dto.resolution,
        durationSeconds: dto.duration_seconds,
        hasAudio: false,
        aspectRatio: dto.aspect_ratio,
        creditsConsumed: creditsRequired,
        parameters: { provider: 'kie', mode: 'normal' },
      },
    });

    await this.debitCredits(
      userId,
      creditsRequired,
      generation.id,
      type,
      dto.resolution,
    );

    await this.generationQueue.add(GenerationJobName.TEXT_TO_VIDEO_GROK, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      prompt: dto.prompt,
      resolution: dto.resolution,
      durationSeconds: dto.duration_seconds,
      aspectRatio: dto.aspect_ratio,
      mode: 'normal',
    } satisfies TextToVideoGrokJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Gemini Omni Video ─────────────────────────────────────

  async generateGeminiOmniVideo(
    userId: string,
    dto: GenerateGeminiOmniVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const model = 'gemini-omni-video';
    const modelVariant = dto.model_variant ?? getModelVariant(model);

    await this.modelsService.assertActiveBySlug(model, AiModelType.VIDEO);

    const hasVideoInput = !!dto.video;
    const hasImageInput = (dto.images?.length ?? 0) > 0;

    // Tipo derivado dos inputs (vídeo > imagem > texto).
    const type: GenerationType = hasVideoInput
      ? GenerationType.REFERENCE_VIDEO
      : hasImageInput
        ? GenerationType.IMAGE_TO_VIDEO
        : GenerationType.TEXT_TO_VIDEO;

    const creditsRequired = await this.plansService.calculateGenerationCost(
      type,
      dto.resolution,
      dto.duration_seconds,
      false,
      1,
      modelVariant,
      hasVideoInput,
    );

    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, creditsRequired);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: model,
        resolution: dto.resolution,
        durationSeconds: dto.duration_seconds,
        hasAudio: false,
        aspectRatio: dto.aspect_ratio,
        creditsConsumed: creditsRequired,
        parameters: { provider: 'kie', hasVideoInput },
      },
    });

    // Upload das imagens (se houver) e do vídeo (se houver) pra S3 público.
    let imageUrls: string[] | undefined;
    if (hasImageInput && dto.images) {
      imageUrls = await Promise.all(
        dto.images.map((img) =>
          this.uploadBase64ImagePublic(
            img.base64,
            img.mime_type ?? 'image/jpeg',
            generation.id,
          ),
        ),
      );
      await this.prisma.generationInputImage.createMany({
        data: dto.images.map((img, i) => ({
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: img.mime_type ?? 'image/jpeg',
          order: i,
          url: imageUrls![i],
        })),
      });
    }

    let videoList: OmniVideoClipData[] | undefined;
    if (hasVideoInput && dto.video) {
      const videoUrl = await this.uploadBase64ImagePublic(
        dto.video.base64,
        dto.video.mime_type ?? 'video/mp4',
        generation.id,
      );
      // Range automático: start=0, ends=min(duration, 10). Sem UI de trim no v1.
      const sourceDuration = dto.video.duration_seconds ?? 10;
      const ends = Math.min(Math.max(sourceDuration, 1), 10);
      videoList = [{ url: videoUrl, start: 0, ends }];
    }

    await this.debitCredits(
      userId,
      creditsRequired,
      generation.id,
      type,
      dto.resolution,
    );

    await this.generationQueue.add(GenerationJobName.OMNI_VIDEO, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      prompt: dto.prompt,
      resolution: dto.resolution,
      durationSeconds: dto.duration_seconds,
      aspectRatio: dto.aspect_ratio,
      imageUrls,
      videoList,
      hasVideoInput,
    } satisfies OmniVideoJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Bytedance Seedance 2.0 ────────────────────────────────

  async generateSeedanceVideo(
    userId: string,
    dto: GenerateSeedanceVideoDto,
  ): Promise<CreateGenerationResponseDto> {
    const model = 'bytedance-seedance-2';
    const modelVariant = dto.model_variant ?? getModelVariant(model);

    await this.modelsService.assertActiveBySlug(model, AiModelType.VIDEO);

    const hasReferenceImages = (dto.reference_images?.length ?? 0) > 0;
    const hasReferenceVideo = !!dto.reference_video;
    const hasReferenceAudio = !!dto.reference_audio;
    // Áudio sozinho NÃO ativa pricing "with video" — só o vídeo de referência ativa.
    const hasVideoInput = hasReferenceVideo;

    // Tipo derivado: qualquer ref → REFERENCE_VIDEO, else TEXT_TO_VIDEO.
    const type: GenerationType =
      hasReferenceImages || hasReferenceVideo || hasReferenceAudio
        ? GenerationType.REFERENCE_VIDEO
        : GenerationType.TEXT_TO_VIDEO;

    const creditsRequired = await this.plansService.calculateGenerationCost(
      type,
      dto.resolution,
      dto.duration_seconds,
      false,
      1,
      modelVariant,
      hasVideoInput,
    );

    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, creditsRequired);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.prompt,
        modelUsed: model,
        resolution: dto.resolution,
        durationSeconds: dto.duration_seconds,
        hasAudio: dto.generate_audio ?? false,
        aspectRatio: dto.aspect_ratio,
        creditsConsumed: creditsRequired,
        parameters: { provider: 'kie', hasVideoInput },
      },
    });

    let referenceImageUrls: string[] | undefined;
    let referenceVideoUrls: string[] | undefined;
    let referenceAudioUrls: string[] | undefined;

    if (hasReferenceImages && dto.reference_images) {
      referenceImageUrls = await Promise.all(
        dto.reference_images.map((img) =>
          this.uploadBase64ImagePublic(
            img.base64,
            img.mime_type ?? 'image/jpeg',
            generation.id,
          ),
        ),
      );
      await this.prisma.generationInputImage.createMany({
        data: dto.reference_images.map((img, i) => ({
          generationId: generation.id,
          role: GenerationImageRole.REFERENCE,
          mimeType: img.mime_type ?? 'image/jpeg',
          order: i,
          url: referenceImageUrls![i],
        })),
      });
    }

    if (hasReferenceVideo && dto.reference_video) {
      const videoUrl = await this.uploadBase64ImagePublic(
        dto.reference_video.base64,
        dto.reference_video.mime_type ?? 'video/mp4',
        generation.id,
      );
      referenceVideoUrls = [videoUrl];
    }

    if (hasReferenceAudio && dto.reference_audio) {
      const audioUrl = await this.uploadBase64ImagePublic(
        dto.reference_audio.base64,
        dto.reference_audio.mime_type ?? 'audio/mpeg',
        generation.id,
      );
      referenceAudioUrls = [audioUrl];
    }

    await this.debitCredits(
      userId,
      creditsRequired,
      generation.id,
      type,
      dto.resolution,
    );

    await this.generationQueue.add(GenerationJobName.SEEDANCE_VIDEO, {
      generationId: generation.id,
      userId,
      creditsConsumed: creditsRequired,
      prompt: dto.prompt,
      resolution: dto.resolution,
      durationSeconds: dto.duration_seconds,
      aspectRatio: dto.aspect_ratio,
      referenceImageUrls,
      referenceVideoUrls,
      referenceAudioUrls,
      generateAudio: dto.generate_audio ?? false,
      hasVideoInput,
    } satisfies SeedanceVideoJobData);

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: creditsRequired,
    };
  }

  // ─── Audio — WaveSpeed OmniVoice ─────────────────────────

  /**
   * Tabela de créditos para áudio. Threshold de 400 chars define se o texto
   * é "curto" (até 399) ou "longo" (400+). Voice clone (criar nova ou usar
   * voz salva) sempre usa a tabela CLONE, mais cara que TTS.
   */
  private static readonly AUDIO_TIER_THRESHOLD = 400;
  private static readonly TTS_CREDIT_COST_SHORT = 35;
  private static readonly TTS_CREDIT_COST_LONG = 45;
  private static readonly CLONE_CREDIT_COST_SHORT = 65;
  private static readonly CLONE_CREDIT_COST_LONG = 80;

  private ttsCreditCost(textLength: number): number {
    return textLength >= GenerationsService.AUDIO_TIER_THRESHOLD
      ? GenerationsService.TTS_CREDIT_COST_LONG
      : GenerationsService.TTS_CREDIT_COST_SHORT;
  }

  private cloneCreditCost(textLength: number): number {
    return textLength >= GenerationsService.AUDIO_TIER_THRESHOLD
      ? GenerationsService.CLONE_CREDIT_COST_LONG
      : GenerationsService.CLONE_CREDIT_COST_SHORT;
  }

  async generateTextToSpeech(
    userId: string,
    dto: GenerateTextToSpeechDto,
  ): Promise<CreateGenerationResponseDto> {
    // voiceId prefixed with `clone:` means the user picked a saved voice
    // profile — we route to voice-clone with the persisted sample instead
    // of a stock TTS voice. Cost is the same as TTS in this case.
    const clonePrefix = 'clone:';
    if (dto.voice_id.startsWith(clonePrefix)) {
      const voiceProfileId = dto.voice_id.slice(clonePrefix.length);
      return this.generateTtsWithSavedVoice(userId, dto, voiceProfileId);
    }

    const ttsCreditCost = this.ttsCreditCost(dto.text.length);
    const type = GenerationType.VOICE_CLONE;

    await this.modelsService.assertActiveBySlug(
      'audio-generation',
      AiModelType.AUDIO,
    );
    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, ttsCreditCost);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.text,
        modelUsed: 'wavespeed-ai/omnivoice/text-to-speech',
        resolution: Resolution.RES_1K,
        hasAudio: true,
        creditsConsumed: ttsCreditCost,
        usedFreeGeneration: false,
        parameters: {
          mode: 'tts',
          voiceId: dto.voice_id,
          language: dto.language,
          speed: dto.speed,
        },
      },
    });

    await this.debitCredits(
      userId,
      ttsCreditCost,
      generation.id,
      type,
      Resolution.RES_1K,
    );

    this.runTextToSpeechDirectly({
      generationId: generation.id,
      userId,
      creditsConsumed: ttsCreditCost,
      text: dto.text,
      voiceId: dto.voice_id,
      language: dto.language,
      speed: dto.speed,
    });

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: ttsCreditCost,
    };
  }

  private async generateTtsWithSavedVoice(
    userId: string,
    dto: GenerateTextToSpeechDto,
    voiceProfileId: string,
  ): Promise<CreateGenerationResponseDto> {
    // TTS com voz já salva: cobra a mesma tabela das vozes padrão (TTS).
    // O custo alto (CLONE) é só na hora de criar a voz pela primeira vez.
    const ttsCreditCost = this.ttsCreditCost(dto.text.length);
    const type = GenerationType.VOICE_CLONE;

    await this.modelsService.assertActiveBySlug(
      'audio-generation',
      AiModelType.AUDIO,
    );

    const voice = await this.voicesService.getForUse(userId, voiceProfileId);
    if (!voice) {
      throw new NotFoundException(
        'Voz salva não encontrada ou não está pronta.',
      );
    }

    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, ttsCreditCost);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.text,
        modelUsed: 'wavespeed-ai/omnivoice/voice-clone',
        resolution: Resolution.RES_1K,
        hasAudio: true,
        creditsConsumed: ttsCreditCost,
        usedFreeGeneration: false,
        voiceProfileId: voice.id,
        parameters: {
          mode: 'tts-cloned',
          voiceProfileId: voice.id,
          language: dto.language ?? voice.language,
        },
      },
    });

    await this.debitCredits(
      userId,
      ttsCreditCost,
      generation.id,
      type,
      Resolution.RES_1K,
    );

    this.runVoiceCloneDirectly({
      generationId: generation.id,
      userId,
      creditsConsumed: ttsCreditCost,
      text: dto.text,
      audioUrl: voice.sampleUrl,
      language: dto.language ?? voice.language,
    });

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: ttsCreditCost,
    };
  }

  async generateVoiceClone(
    userId: string,
    dto: GenerateVoiceCloneDto,
  ): Promise<CreateGenerationResponseDto> {
    const cloneCreditCost = this.cloneCreditCost(dto.text.length);
    const type = GenerationType.VOICE_CLONE;

    await this.modelsService.assertActiveBySlug(
      'audio-generation',
      AiModelType.AUDIO,
    );
    await this.checkConcurrentLimit(userId);
    await this.ensureSufficientBalance(userId, cloneCreditCost);

    const generation = await this.prisma.generation.create({
      data: {
        userId,
        type,
        status: GenerationStatus.PROCESSING,
        prompt: dto.text,
        modelUsed: 'wavespeed-ai/omnivoice/voice-clone',
        resolution: Resolution.RES_1K,
        hasAudio: true,
        creditsConsumed: cloneCreditCost,
        usedFreeGeneration: false,
        parameters: {
          mode: 'clone',
          language: dto.language,
        },
      },
    });

    const inputMime = dto.audio_mime_type ?? 'audio/mpeg';
    const { url: audioUrl, mimeType: storedMime } =
      await this.uploadBase64Audio(dto.audio, inputMime, generation.id);

    // Persist the sample URL so the user can later promote this clone
    // into a saved VoiceProfile via POST /voices.
    await this.prisma.generation.update({
      where: { id: generation.id },
      data: {
        parameters: {
          mode: 'clone',
          language: dto.language,
          sampleUrl: audioUrl,
          sampleMime: storedMime,
        },
      },
    });

    await this.debitCredits(
      userId,
      cloneCreditCost,
      generation.id,
      type,
      Resolution.RES_1K,
    );

    this.runVoiceCloneDirectly({
      generationId: generation.id,
      userId,
      creditsConsumed: cloneCreditCost,
      text: dto.text,
      audioUrl,
      language: dto.language,
    });

    return {
      id: generation.id,
      status: GenerationStatus.PROCESSING,
      creditsConsumed: cloneCreditCost,
    };
  }

  // ─── Shared helpers ───────────────────────────────────────

  private async checkVeoAccess(
    userId: string,
    modelVariant: string | null,
    provider: 'theaimodelab' | 'kie' = 'theaimodelab',
  ): Promise<'paid' | 'free_generation'> {
    const isTheaimodelab =
      modelVariant === 'THEAIMODELAB_FAST' || modelVariant === 'THEAIMODELAB_QUALITY';
    const isVeo = modelVariant === 'VEO_FAST' || modelVariant === 'VEO_MAX';

    if (!isTheaimodelab && !isVeo) {
      return 'paid';
    }

    // Free generations agora cobrem apenas THEAIMODELAB_FAST (não THEAIMODELAB_QUALITY)
    if (provider === 'theaimodelab' && modelVariant === 'THEAIMODELAB_FAST') {
      const hasFree = await this.creditsService.hasFreeGeneration(
        userId,
        FreeGenerationType.THEAIMODELAB_FAST,
      );
      if (hasFree) {
        return 'free_generation';
      }
    }

    return 'paid';
  }

  /**
   * Resolve se o usuário tem uma free generation elegível pra este request.
   * Retorna o tipo se sim, null se deve cobrar créditos normalmente.
   */
  private async resolveFreeGenForRequest(
    userId: string,
    type: GenerationType,
    modelVariant: string | null,
    override?: FreeGenerationType,
  ): Promise<FreeGenerationType | null> {
    const freeType = override ?? resolveFreeGenerationType(type, modelVariant);
    if (!freeType) return null;
    const hasFree = await this.creditsService.hasFreeGeneration(
      userId,
      freeType,
    );
    return hasFree ? freeType : null;
  }

  private async checkConcurrentLimit(userId: string): Promise<void> {
    const [processingCount, subscription] = await Promise.all([
      this.prisma.generation.count({
        where: { userId, status: GenerationStatus.PROCESSING },
      }),
      this.prisma.subscription.findFirst({
        where: { userId, status: 'ACTIVE' },
        select: { plan: { select: { maxConcurrentGenerations: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const maxConcurrent = subscription?.plan.maxConcurrentGenerations ?? 5;

    if (processingCount >= maxConcurrent) {
      throw new HttpException(
        {
          code: 'MAX_CONCURRENT_REACHED',
          message: `Limite de ${maxConcurrent} geração(ões) simultânea(s) atingido. Aguarde uma geração concluir antes de iniciar outra.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async ensureSufficientBalance(
    userId: string,
    creditsRequired: number,
  ): Promise<void> {
    const balance = await this.creditsService.getBalance(userId);
    if (balance.totalCreditsAvailable < creditsRequired) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_CREDITS',
        message: `Créditos insuficientes. Necessário: ${creditsRequired}, disponível: ${balance.totalCreditsAvailable}.`,
        statusCode: 402,
      });
    }
  }

  private async debitCredits(
    userId: string,
    creditsRequired: number,
    generationId: string,
    type: GenerationType,
    resolution: Resolution,
  ): Promise<void> {
    await this.creditsService.debit(
      userId,
      creditsRequired,
      CreditTransactionType.GENERATION_DEBIT,
      generationId,
      `Geração ${type} ${resolution}`,
    );
  }

  // ─── Read operations ──────────────────────────────────────

  async findById(
    userId: string,
    generationId: string,
  ): Promise<GenerationResponseDto> {
    const generation = await this.prisma.generation.findFirst({
      where: {
        id: generationId,
        userId,
        isDeleted: false,
      },
      include: {
        outputs: { orderBy: { order: 'asc' } },
      },
    });

    if (!generation) {
      throw new NotFoundException('Geração não encontrada');
    }

    return this.toResponseDto(generation);
  }

  async findFolders(userId: string, generationId: string) {
    const generation = await this.prisma.generation.findFirst({
      where: { id: generationId, userId, isDeleted: false },
      select: { id: true },
    });

    if (!generation) {
      throw new NotFoundException('Geração não encontrada');
    }

    const generationFolders = await this.prisma.generationFolder.findMany({
      where: { generationId },
      include: {
        folder: {
          include: { _count: { select: { generationFolders: true } } },
        },
      },
    });

    return generationFolders.map((gf) => ({
      id: gf.folder.id,
      name: gf.folder.name,
      description: gf.folder.description ?? undefined,
      generationCount: gf.folder._count.generationFolders,
      createdAt: gf.folder.createdAt,
      updatedAt: gf.folder.updatedAt,
    }));
  }

  async findAll(
    userId: string,
    filters: GenerationFiltersDto,
  ): Promise<PaginatedResponseDto<GenerationResponseDto>> {
    const where: Record<string, unknown> = {
      userId,
      isDeleted: false,
    };

    if (filters.type) {
      where.type = filters.type;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.favorited !== undefined) {
      where.isFavorited = filters.favorited;
    }

    let orderBy: Record<string, string> = { createdAt: 'desc' };
    if (filters.sort) {
      const [field, direction] = filters.sort.split(':');
      const fieldMap: Record<string, string> = {
        created_at: 'createdAt',
        completed_at: 'completedAt',
        credits_consumed: 'creditsConsumed',
      };
      const mappedField = fieldMap[field];
      if (mappedField) {
        orderBy = { [mappedField]: direction === 'asc' ? 'asc' : 'desc' };
      }
      // If field not in map, keep default orderBy (createdAt desc)
    }

    const [generations, total] = await Promise.all([
      this.prisma.generation.findMany({
        where,
        orderBy,
        skip: filters.skip,
        take: filters.limit,
        include: {
          outputs: { orderBy: { order: 'asc' } },
        },
      }),
      this.prisma.generation.count({ where }),
    ]);

    const data = generations.map((gen) => this.toResponseDto(gen));

    return new PaginatedResponseDto(data, total, filters.page, filters.limit);
  }

  async softDelete(userId: string, generationId: string): Promise<void> {
    const generation = await this.prisma.generation.findFirst({
      where: { id: generationId, userId },
    });

    if (!generation) {
      throw new NotFoundException('Geração não encontrada');
    }

    await this.prisma.generation.update({
      where: { id: generationId },
      data: { isDeleted: true },
    });
  }

  async deleteOutput(
    userId: string,
    generationId: string,
    outputId: string,
  ): Promise<void> {
    const generation = await this.prisma.generation.findFirst({
      where: { id: generationId, userId },
      include: { outputs: { select: { id: true } } },
    });

    if (!generation) {
      throw new NotFoundException('Geração não encontrada');
    }

    const output = generation.outputs.find((o) => o.id === outputId);
    if (!output) {
      throw new NotFoundException('Output não encontrado nesta geração');
    }

    await this.prisma.generationOutput.delete({
      where: { id: outputId },
    });
  }

  async toggleFavorite(
    userId: string,
    generationId: string,
    isFavorited: boolean,
  ): Promise<void> {
    const generation = await this.prisma.generation.findFirst({
      where: { id: generationId, userId, isDeleted: false },
    });

    if (!generation) {
      throw new NotFoundException('Geração não encontrada');
    }

    await this.prisma.generation.update({
      where: { id: generationId },
      data: { isFavorited },
    });
  }

  // ─── Response mapping ─────────────────────────────────────

  private toResponseDto(
    generation: GenerationWithRelations,
  ): GenerationResponseDto {
    return {
      id: generation.id,
      type: generation.type,
      status: generation.status,
      prompt: generation.prompt ?? undefined,
      negativePrompt: generation.negativePrompt ?? undefined,
      resolution: generation.resolution,
      durationSeconds: generation.durationSeconds ?? undefined,
      hasAudio: generation.hasAudio,
      modelUsed: generation.modelUsed ?? undefined,
      parameters:
        (generation.parameters as Record<string, unknown>) ?? undefined,
      outputs: generation.outputs.map((o) => ({
        id: o.id,
        url: o.url,
        thumbnailUrl: o.thumbnailUrl ?? undefined,
        mimeType: o.mimeType ?? undefined,
        order: o.order,
      })),
      inputImages: [],
      hasWatermark: generation.hasWatermark,
      creditsConsumed: generation.creditsConsumed,
      processingTimeMs: generation.processingTimeMs ?? undefined,
      errorMessage: generation.errorMessage ?? undefined,
      errorCode: generation.errorCode ?? undefined,
      isFavorited: generation.isFavorited,
      createdAt: generation.createdAt,
      completedAt: generation.completedAt ?? undefined,
    };
  }

  private async uploadBase64Image(
    base64: string,
    mimeType: string,
    generationId: string,
  ): Promise<string> {
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeType.split('/')[1] ?? 'jpg';
    return this.uploadsService.uploadBuffer(
      buffer,
      `inputs/${generationId}`,
      `input.${ext}`,
      mimeType,
    );
  }

  private async uploadBase64ImagePublic(
    base64: string,
    mimeType: string,
    generationId: string,
  ): Promise<string> {
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeType.split('/')[1] ?? 'jpg';
    const { publicUrl } = await this.uploadsService.uploadBufferPublic(
      buffer,
      `inputs/${generationId}`,
      `input_${Date.now()}.${ext}`,
      mimeType,
    );
    return publicUrl;
  }

  private async uploadBase64Audio(
    base64: string,
    mimeType: string,
    generationId: string,
  ): Promise<{ url: string; mimeType: string }> {
    let buffer: Buffer = Buffer.from(base64, 'base64');
    const subtype = mimeType.split('/')[1] ?? 'mpeg';
    const isMp3 = subtype.includes('mpeg') || subtype === 'mp3';

    let finalMime = mimeType;
    const ext = 'mp3';

    // WaveSpeed OmniVoice voice-clone only accepts mp3/wav. Browser recordings
    // come in as webm (Chrome/Firefox) or m4a (Safari) — we transcode them to
    // mp3 here so any subsequent generation works without surprise format errors.
    if (!isMp3) {
      try {
        buffer = await this.uploadsService.transcodeAudioToMp3(buffer);
        finalMime = 'audio/mpeg';
      } catch (err) {
        this.logger.error(
          `Audio transcode failed for gen=${generationId}: ${(err as Error).message}`,
        );
        throw new BadRequestException(
          'Não foi possível processar o áudio enviado. Tente novamente com um arquivo mp3 ou wav.',
        );
      }
    }

    // Use 'samples/' (not 'inputs/') so the post-generation cleanup doesn't
    // delete it — user may want to save this voice as a profile afterward.
    const url = await this.uploadsService.uploadBuffer(
      buffer,
      `samples/${generationId}`,
      `reference.${ext}`,
      finalMime,
    );
    return { url, mimeType: finalMime };
  }
}
