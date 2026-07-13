import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditsService } from '../../credits/credits.service';
import { UploadsService } from '../../uploads/uploads.service';
import { TheaimodelabProvider } from '../providers/theaimodelab.provider';
import {
  NanoBananaProvider,
  mapGeminiToNanoBanana,
} from '../providers/nano-banana.provider';
import { WanProvider } from '../providers/wan.provider';
import { FaceSwapProvider } from '../providers/face-swap.provider';
import { VeoProvider } from '../providers/veo.provider';
import { GrokImagineProvider } from '../providers/grok-imagine.provider';
import { GeminiOmniVideoProvider } from '../providers/gemini-omni-video.provider';
import { BytedanceSeedanceProvider } from '../providers/bytedance-seedance.provider';
import { KlingProvider } from '../providers/kling.provider';
import { ComfyDeployProvider } from '../providers/comfydeploy.provider';
import { SeedreamLiteProvider } from '../providers/seedream-lite.provider';
import { SeedreamProvider } from '../providers/seedream.provider';
import { GptImageProvider } from '../providers/gpt-image.provider';
import { DeepDeepProvider } from '../providers/deepdeep.provider';
import { WavespeedAudioProvider } from '../providers/wavespeed-audio.provider';
import { GenerationEventsService } from '../generation-events.service';
import { PromptEnhancerService } from '../../prompt-enhancer/prompt-enhancer.service';
import { ContentSafetyError } from '../errors/content-safety.error';

import {
  GenerationStatus,
  GenerationType,
  GenerationImageRole,
  Resolution,
} from '@prisma/client';
import {
  GENERATION_QUEUE,
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
  SeedanceVideoJobData,
  KlingImageToVideoJobData,
  ComfyDeployImageToVideoJobData,
  TextToSpeechJobData,
  VoiceCloneJobData,
} from './generation-queue.constants';

@Processor(GENERATION_QUEUE, {
  concurrency: 5,
  lockDuration: 15 * 60 * 1000, // 15 min — vídeos podem demorar até 12 min
})
export class GenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(GenerationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditsService: CreditsService,
    private readonly uploadsService: UploadsService,
    private readonly theaimodelabProvider: TheaimodelabProvider,
    private readonly nanoBananaProvider: NanoBananaProvider,
    private readonly wanProvider: WanProvider,
    private readonly faceSwapProvider: FaceSwapProvider,
    private readonly veoProvider: VeoProvider,
    private readonly grokImagineProvider: GrokImagineProvider,
    private readonly geminiOmniVideoProvider: GeminiOmniVideoProvider,
    private readonly bytedanceSeedanceProvider: BytedanceSeedanceProvider,
    private readonly klingProvider: KlingProvider,
    private readonly comfyDeployProvider: ComfyDeployProvider,
    private readonly seedreamLiteProvider: SeedreamLiteProvider,
    private readonly seedreamProvider: SeedreamProvider,
    private readonly gptImageProvider: GptImageProvider,
    private readonly deepDeepProvider: DeepDeepProvider,
    private readonly wavespeedAudioProvider: WavespeedAudioProvider,
    private readonly generationEvents: GenerationEventsService,
    private readonly promptEnhancer: PromptEnhancerService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(
      `Processing job ${job.id} [${job.name}] for generation ${job.data.generationId}`,
    );

    return this.dispatch(job.name, job.data);
  }

  /**
   * Switch público compartilhado com o UnlimitedProcessor. Mantém os
   * métodos de processamento privados sem duplicar lógica entre filas.
   */
  async dispatch(jobName: string, data: unknown): Promise<void> {
    switch (jobName) {
      case GenerationJobName.IMAGE:
        return this.processImage(data as ImageJobData);
      case GenerationJobName.IMAGE_WITH_FALLBACK:
        return this.processImageWithFallback(data as ImageJobData);
      case GenerationJobName.IMAGE_NANO_BANANA:
        return this.processNanoBanana(data as ImageNanoBananaJobData);
      case GenerationJobName.TEXT_TO_VIDEO:
        return this.processTextToVideo(data as TextToVideoJobData);
      case GenerationJobName.IMAGE_TO_VIDEO:
        return this.processImageToVideo(data as ImageToVideoJobData);
      case GenerationJobName.REFERENCE_VIDEO:
        return this.processReferenceVideo(data as ReferenceVideoJobData);
      case GenerationJobName.MOTION_CONTROL:
        return this.processMotionControl(data as MotionControlJobData);
      case GenerationJobName.VIRTUAL_TRY_ON:
        return this.processVirtualTryOn(data as VirtualTryOnJobData);
      case GenerationJobName.FACE_SWAP:
        return this.processFaceSwap(data as FaceSwapJobData);
      case GenerationJobName.TEXT_TO_VIDEO_KIE:
        return this.processTextToVideoKie(data as TextToVideoKieJobData);
      case GenerationJobName.IMAGE_TO_VIDEO_KIE:
        return this.processImageToVideoKie(data as ImageToVideoKieJobData);
      case GenerationJobName.REFERENCE_TO_VIDEO_KIE:
        return this.processReferenceToVideoKie(data as ReferenceToVideoKieJobData);
      case GenerationJobName.IMAGE_TO_VIDEO_GROK:
        return this.processImageToVideoGrok(data as ImageToVideoGrokJobData);
      case GenerationJobName.TEXT_TO_VIDEO_GROK:
        return this.processTextToVideoGrok(data as TextToVideoGrokJobData);
      case GenerationJobName.OMNI_VIDEO:
        return this.processOmniVideo(data as OmniVideoJobData);
      case GenerationJobName.SEEDANCE_VIDEO:
        return this.processSeedanceVideo(data as SeedanceVideoJobData);
      case GenerationJobName.KLING_IMAGE_TO_VIDEO:
        return this.processKlingImageToVideo(data as KlingImageToVideoJobData);
      case GenerationJobName.COMFYDEPLOY_IMAGE_TO_VIDEO:
        return this.processComfyDeployImageToVideo(
          data as ComfyDeployImageToVideoJobData,
        );
      default:
        throw new Error(`Unknown job name: ${jobName}`);
    }
  }

  // ─── Direct audio runners (no queue) ────────────────────────
  // Audio generations bypass BullMQ — they're fast, single-provider
  // (WaveSpeed), and we don't want the Redis hop adding silent failure modes.

  async runTextToSpeechDirectly(data: TextToSpeechJobData): Promise<void> {
    try {
      await this.processTextToSpeech(data);
    } catch (error) {
      await this.handleFailure(
        data.generationId,
        data.userId,
        data.creditsConsumed,
        error as Error,
        data.usedFreeGeneration,
      );
    }
  }

  async runVoiceCloneDirectly(data: VoiceCloneJobData): Promise<void> {
    try {
      await this.processVoiceClone(data);
    } catch (error) {
      await this.handleFailure(
        data.generationId,
        data.userId,
        data.creditsConsumed,
        error as Error,
        data.usedFreeGeneration,
      );
    }
  }

  // ─── Process methods ────────────────────────────────────────

  async runImageJobDirectly(data: ImageJobData): Promise<void> {
    try {
      await this.processImage(data);
    } catch (error) {
      await this.handleFailure(
        data.generationId,
        data.userId,
        data.creditsConsumed,
        error as Error,
        data.usedFreeGeneration,
      );
    }
  }

  private async processImage(data: ImageJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[IMAGE] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} hasInputImages=${data.hasInputImages} prompt="${data.prompt}"`,
    );

    if (data.model === 'sem-censura') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = inputImages
          .map((img) => img.url)
          .filter((url): url is string => !!url);
      }

      const result = await this.seedreamProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        imageUrls,
      });

      await this.completeGeneration(data.generationId, result, startTime);
      return;
    }

    if (data.model === 'gpt-image-2') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = inputImages
          .map((img) => img.url)
          .filter((url): url is string => !!url);
      }

      try {
        const result = await this.gptImageProvider.generateImage({
          id: data.generationId,
          prompt: data.prompt,
          resolution: data.resolution,
          aspectRatio: data.aspectRatio,
          imageUrls,
        });
        await this.completeGeneration(data.generationId, result, startTime);
      } catch (error) {
        if (this.isSafetyRelatedError(error)) {
          const result = await this.fallbackToSeedream(
            data.generationId,
            data.prompt,
            data.aspectRatio,
            error,
            'processImage:gpt-image-2',
          );
          await this.completeGeneration(data.generationId, result, startTime);
          return;
        }
        throw error;
      }
      return;
    }

    if (data.model === 'seedream-5-lite') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = inputImages
          .map((img) => img.url)
          .filter((url): url is string => !!url);
      }

      const buildInput = (prompt: string) => ({
        id: data.generationId,
        prompt,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        imageUrls,
      });

      try {
        const result = await this.seedreamLiteProvider.generateImage(buildInput(data.prompt));
        await this.completeGeneration(data.generationId, result, startTime);
      } catch (error) {
        if (this.isSafetyRelatedError(error)) {
          const retryResult = await this.retryWithRefinedPrompt(
            data.generationId,
            data.prompt,
            (refined) => this.seedreamLiteProvider.generateImage(buildInput(refined)),
          );
          if (retryResult) {
            await this.completeGeneration(data.generationId, retryResult, startTime);
            return;
          }
        }
        throw error;
      }
      return;
    }

    if (data.model === 'deepdeep') {
      // Deepdeep é image-to-image puro: sempre precisa de imagem de input.
      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      const imageUrls = inputImages
        .map((img) => img.url)
        .filter((url): url is string => !!url);

      const result = await this.deepDeepProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        imageUrls,
      });

      await this.completeGeneration(data.generationId, result, startTime);
      return;
    }

    const images = data.hasInputImages
      ? await this.loadInputImagesAsBase64(data.generationId)
      : undefined;

    try {
      const result = await this.theaimodelabProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        model: data.model,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        mimeType: data.mimeType,
        images,
      });

      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const result = await this.fallbackToSeedream(
          data.generationId,
          data.prompt,
          data.aspectRatio,
          error,
          'processImage:theaimodelab',
        );
        await this.completeGeneration(data.generationId, result, startTime);
        return;
      }
      throw error;
    }
  }

  private async processImageWithFallback(data: ImageJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[IMAGE_FALLBACK] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} hasInputImages=${data.hasInputImages} prompt="${data.prompt}"`,
    );

    if (data.model === 'sem-censura') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = inputImages
          .map((img) => img.url)
          .filter((url): url is string => !!url);
      }

      const result = await this.seedreamProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        imageUrls,
      });

      await this.completeGeneration(data.generationId, result, startTime);
      return;
    }

    if (data.model === 'gpt-image-2') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = inputImages
          .map((img) => img.url)
          .filter((url): url is string => !!url);
      }

      try {
        const result = await this.gptImageProvider.generateImage({
          id: data.generationId,
          prompt: data.prompt,
          resolution: data.resolution,
          aspectRatio: data.aspectRatio,
          imageUrls,
        });
        await this.completeGeneration(data.generationId, result, startTime);
      } catch (error) {
        if (this.isSafetyRelatedError(error)) {
          const result = await this.fallbackToSeedream(
            data.generationId,
            data.prompt,
            data.aspectRatio,
            error,
            'processImageWithFallback:gpt-image-2',
          );
          await this.completeGeneration(data.generationId, result, startTime);
          return;
        }
        throw error;
      }
      return;
    }

    if (data.model === 'deepdeep') {
      // Deepdeep é image-to-image puro com provider próprio — não tem fallback.
      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      const imageUrls = inputImages
        .map((img) => img.url)
        .filter((url): url is string => !!url);

      const result = await this.deepDeepProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        imageUrls,
      });

      await this.completeGeneration(data.generationId, result, startTime);
      return;
    }

    const images = data.hasInputImages
      ? await this.loadInputImagesAsBase64(data.generationId)
      : undefined;

    try {
      const result = await this.theaimodelabProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        model: data.model,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        mimeType: data.mimeType,
        images,
      });

      await this.completeGeneration(
        data.generationId,
        result,
        startTime,
        'theaimodelab',
      );
    } catch (theaimodelabError) {
      if (this.isSafetyRelatedError(theaimodelabError)) {
        const result = await this.fallbackToSeedream(
          data.generationId,
          data.prompt,
          data.aspectRatio,
          theaimodelabError,
          'processImageWithFallback:theaimodelab',
        );
        await this.completeGeneration(data.generationId, result, startTime);
        return;
      }

      this.logger.warn(
        `The AI Model Lab failed for ${data.generationId}, falling back to Nano Banana: ${(theaimodelabError as Error).message}`,
      );

      // Check if CRON already marked this generation as FAILED — skip KIE to avoid paying for nothing
      const preCheck = await this.prisma.generation.findUnique({
        where: { id: data.generationId },
        select: { status: true },
      });
      if (
        preCheck?.status === GenerationStatus.FAILED ||
        preCheck?.status === GenerationStatus.COMPLETED
      ) {
        this.logger.warn(
          `Generation ${data.generationId} already ${preCheck.status} before Nano Banana fallback — aborting to save KIE costs`,
        );
        return;
      }

      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
      });
      const imageUrls = inputImages
        .map((img) => img.url)
        .filter(Boolean) as string[];

      const nanaBananaModel = mapGeminiToNanoBanana(data.model);
      try {
        const result = await this.nanoBananaProvider.generateImage({
          id: data.generationId,
          model: nanaBananaModel,
          prompt: data.prompt,
          resolution: data.resolution,
          aspectRatio: data.aspectRatio,
          outputFormat: data.mimeType === 'image/jpeg' ? 'jpg' : 'png',
          imageUrls: imageUrls.length ? imageUrls : undefined,
        });

        await this.completeGeneration(
          data.generationId,
          result,
          startTime,
          nanaBananaModel,
        );
      } catch (nanoBananaError) {
        if (this.isSafetyRelatedError(nanoBananaError)) {
          const result = await this.fallbackToSeedream(
            data.generationId,
            data.prompt,
            data.aspectRatio,
            nanoBananaError,
            'processImageWithFallback:nano-banana',
          );
          await this.completeGeneration(data.generationId, result, startTime);
          return;
        }
        throw nanoBananaError;
      }
    }
  }

  private async processNanoBanana(data: ImageNanoBananaJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[NANO_BANANA] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} outputFormat=${data.outputFormat} googleSearch=${data.googleSearch} imageUrls=${data.imageUrls?.length ?? 0} prompt="${data.prompt}"`,
    );

    try {
      const result = await this.nanoBananaProvider.generateImage({
        id: data.generationId,
        model: data.model,
        prompt: data.prompt,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        outputFormat: data.outputFormat,
        googleSearch: data.googleSearch,
        imageUrls: data.imageUrls,
      });

      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const result = await this.fallbackToSeedream(
          data.generationId,
          data.prompt,
          data.aspectRatio,
          error,
          'processNanoBanana',
        );
        await this.completeGeneration(data.generationId, result, startTime);
        return;
      }
      throw error;
    }
  }

  private async processTextToVideo(data: TextToVideoJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[TEXT_TO_VIDEO] ${data.generationId} model=${data.model} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} audio=${data.generateAudio} samples=${data.sampleCount} prompt="${data.prompt}"`,
    );

    const buildInput = (prompt: string) => ({
      id: data.generationId,
      prompt,
      model: data.model,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
      sampleCount: data.sampleCount,
      negativePrompt: data.negativePrompt,
    });

    try {
      const result = await this.theaimodelabProvider.generateTextToVideo(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.theaimodelabProvider.generateTextToVideo(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  private async processImageToVideo(data: ImageToVideoJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[IMAGE_TO_VIDEO] ${data.generationId} model=${data.resolvedModel} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} audio=${data.generateAudio} samples=${data.sampleCount} prompt="${data.prompt}"`,
    );

    const inputImages = await this.prisma.generationInputImage.findMany({
      where: { generationId: data.generationId },
      orderBy: { order: 'asc' },
    });

    const firstFrameImg = inputImages.find(
      (img) => img.role === GenerationImageRole.FIRST_FRAME,
    );
    const lastFrameImg = inputImages.find(
      (img) => img.role === GenerationImageRole.LAST_FRAME,
    );

    if (!firstFrameImg?.url) {
      throw new Error('First frame image not found for image-to-video');
    }

    const firstFrameBase64 = await this.downloadToBase64(firstFrameImg.url);
    const lastFrameBase64 = lastFrameImg?.url
      ? await this.downloadToBase64(lastFrameImg.url)
      : undefined;

    const buildInput = (prompt: string) => ({
      id: data.generationId,
      prompt,
      model: data.resolvedModel,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
      sampleCount: data.sampleCount,
      negativePrompt: data.negativePrompt,
      firstFrame: firstFrameBase64,
      firstFrameMimeType: firstFrameImg.mimeType ?? 'image/jpeg',
      lastFrame: lastFrameBase64,
      lastFrameMimeType: lastFrameImg?.mimeType ?? undefined,
    });

    try {
      const result = await this.theaimodelabProvider.generateImageToVideo(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.theaimodelabProvider.generateImageToVideo(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  private async processReferenceVideo(
    data: ReferenceVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[REFERENCE_VIDEO] ${data.generationId} model=${data.resolvedModel} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} audio=${data.generateAudio} samples=${data.sampleCount} prompt="${data.prompt}"`,
    );

    const inputImages = await this.prisma.generationInputImage.findMany({
      where: {
        generationId: data.generationId,
        role: GenerationImageRole.REFERENCE,
      },
      orderBy: { order: 'asc' },
    });

    const referenceImages = await Promise.all(
      inputImages.map(async (img) => ({
        base64: img.url ? await this.downloadToBase64(img.url) : '',
        mimeType: img.mimeType ?? 'image/jpeg',
        referenceType: (img.referenceType ?? 'asset') as 'asset' | 'style',
      })),
    );

    const buildInput = (prompt: string) => ({
      id: data.generationId,
      prompt,
      model: data.resolvedModel,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
      sampleCount: data.sampleCount,
      negativePrompt: data.negativePrompt,
      referenceImages,
    });

    try {
      const result = await this.theaimodelabProvider.generateVideoWithReferences(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) =>
            this.theaimodelabProvider.generateVideoWithReferences(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  private async processMotionControl(
    data: MotionControlJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[MOTION_CONTROL] ${data.generationId} resolution=${data.resolution} videoUrl=${data.videoUrl} imageUrl=${data.imageUrl}`,
    );

    const result = await this.wanProvider.generateAnimateReplace({
      id: data.generationId,
      videoUrl: data.videoUrl,
      imageUrl: data.imageUrl,
      resolution: data.resolution,
    });

    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processVirtualTryOn(data: VirtualTryOnJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[VIRTUAL_TRY_ON] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio}`,
    );

    const images = await this.loadInputImagesAsBase64(data.generationId);

    try {
      const result = await this.theaimodelabProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        model: data.model,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        mimeType: data.mimeType,
        images,
      });

      await this.completeGeneration(
        data.generationId,
        result,
        startTime,
        'theaimodelab',
      );
    } catch (theaimodelabError) {
      if (this.isSafetyRelatedError(theaimodelabError)) {
        const result = await this.fallbackToSeedream(
          data.generationId,
          data.prompt,
          data.aspectRatio,
          theaimodelabError,
          'processVirtualTryOn:theaimodelab',
        );
        await this.completeGeneration(data.generationId, result, startTime);
        return;
      }

      this.logger.warn(
        `The AI Model Lab failed for virtual try-on ${data.generationId}, falling back to Nano Banana: ${(theaimodelabError as Error).message}`,
      );

      const preCheck = await this.prisma.generation.findUnique({
        where: { id: data.generationId },
        select: { status: true },
      });
      if (
        preCheck?.status === GenerationStatus.FAILED ||
        preCheck?.status === GenerationStatus.COMPLETED
      ) {
        this.logger.warn(
          `Generation ${data.generationId} already ${preCheck.status} before Nano Banana fallback — aborting to save KIE costs`,
        );
        return;
      }

      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      const imageUrls = inputImages
        .map((img) => img.url)
        .filter(Boolean) as string[];

      const nanoBananaModel = mapGeminiToNanoBanana(data.model);
      try {
        const result = await this.nanoBananaProvider.generateImage({
          id: data.generationId,
          model: nanoBananaModel,
          prompt: data.prompt,
          resolution: data.resolution,
          aspectRatio: data.aspectRatio,
          outputFormat: data.mimeType === 'image/jpeg' ? 'jpg' : 'png',
          imageUrls: imageUrls.length ? imageUrls : undefined,
        });

        await this.completeGeneration(
          data.generationId,
          result,
          startTime,
          nanoBananaModel,
        );
      } catch (nanoBananaError) {
        if (this.isSafetyRelatedError(nanoBananaError)) {
          const result = await this.fallbackToSeedream(
            data.generationId,
            data.prompt,
            data.aspectRatio,
            nanoBananaError,
            'processVirtualTryOn:nano-banana',
          );
          await this.completeGeneration(data.generationId, result, startTime);
          return;
        }
        throw nanoBananaError;
      }
    }
  }

  private async processFaceSwap(data: FaceSwapJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[FACE_SWAP] ${data.generationId} resolution=${data.resolution} sourceImage=${data.sourceImageUrl} targetImage=${data.targetImageUrl}`,
    );

    try {
      const result = await this.faceSwapProvider.generateFaceSwap({
        id: data.generationId,
        sourceImageUrl: data.sourceImageUrl,
        targetImageUrl: data.targetImageUrl,
        resolution: data.resolution,
      });

      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const faceSwapFallbackPrompt =
          'Recreate the scene in Image 2 (clothing, body pose, and setting) replacing the person with the woman in Image 1. Preserve facial features, skin tone and body proportions from Image 1 with photorealistic lighting and shadows.';
        const result = await this.fallbackToSeedream(
          data.generationId,
          faceSwapFallbackPrompt,
          undefined,
          error,
          'processFaceSwap',
        );
        await this.completeGeneration(data.generationId, result, startTime);
        return;
      }
      throw error;
    }
  }

  // ─── Kie Veo process methods ────────────────────────────────

  private async processTextToVideoKie(data: TextToVideoKieJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[TEXT_TO_VIDEO_KIE] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} audio=${data.generateAudio} prompt="${data.prompt}"`,
    );

    const result = await this.veoProvider.generateTextToVideo({
      id: data.generationId,
      prompt: data.prompt,
      model: data.model,
      resolution: data.resolution,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
      seed: data.seed,
    });

    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processImageToVideoKie(data: ImageToVideoKieJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[IMAGE_TO_VIDEO_KIE] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} audio=${data.generateAudio} imageUrls=${data.imageUrls.length} prompt="${data.prompt}"`,
    );

    const result = await this.veoProvider.generateImageToVideo({
      id: data.generationId,
      prompt: data.prompt,
      model: data.model,
      resolution: data.resolution,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
      seed: data.seed,
      imageUrls: data.imageUrls,
    });

    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processReferenceToVideoKie(data: ReferenceToVideoKieJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[REFERENCE_TO_VIDEO_KIE] ${data.generationId} model=veo3_fast resolution=${data.resolution} aspectRatio=${data.aspectRatio} audio=${data.generateAudio} imageUrls=${data.imageUrls.length} prompt="${data.prompt}"`,
    );

    const result = await this.veoProvider.generateReferenceToVideo({
      id: data.generationId,
      prompt: data.prompt,
      model: 'veo3_fast',
      resolution: data.resolution,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
      seed: data.seed,
      imageUrls: data.imageUrls,
    });

    await this.completeGeneration(data.generationId, result, startTime);
  }

  // ─── Grok Imagine process methods ───────────────────────────

  private async processImageToVideoGrok(
    data: ImageToVideoGrokJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[IMAGE_TO_VIDEO_GROK] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} mode=${data.mode ?? 'normal'} imageUrls=${data.imageUrls.length} prompt="${data.prompt ?? ''}"`,
    );

    const buildInput = (prompt: string | undefined) => ({
      id: data.generationId,
      prompt,
      imageUrls: data.imageUrls,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
      mode: data.mode ?? 'normal',
    });

    try {
      const result = await this.grokImagineProvider.generateImageToVideo(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      // Se foi bloqueado por safety E tem prompt, tenta refinar e gerar de novo.
      if (this.isSafetyRelatedError(error) && data.prompt) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.grokImagineProvider.generateImageToVideo(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  private async processTextToVideoGrok(
    data: TextToVideoGrokJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[TEXT_TO_VIDEO_GROK] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} mode=${data.mode ?? 'normal'} prompt="${data.prompt}"`,
    );

    const buildInput = (prompt: string) => ({
      id: data.generationId,
      prompt,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
      mode: data.mode ?? 'normal',
    });

    try {
      const result = await this.grokImagineProvider.generateTextToVideo(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.grokImagineProvider.generateTextToVideo(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  // ─── Gemini Omni Video ─────────────────────────────────────

  private async processOmniVideo(data: OmniVideoJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[OMNI_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} images=${data.imageUrls?.length ?? 0} videos=${data.videoList?.length ?? 0} hasVideo=${data.hasVideoInput} prompt="${data.prompt}"`,
    );

    const buildInput = (prompt: string) => ({
      id: data.generationId,
      prompt,
      imageUrls: data.imageUrls,
      videoList: data.videoList,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
    });

    try {
      const result = await this.geminiOmniVideoProvider.generateOmniVideo(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.geminiOmniVideoProvider.generateOmniVideo(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  // ─── Bytedance Seedance 2.0 ────────────────────────────────

  private async processSeedanceVideo(data: SeedanceVideoJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[SEEDANCE_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} refImages=${data.referenceImageUrls?.length ?? 0} refVideos=${data.referenceVideoUrls?.length ?? 0} refAudios=${data.referenceAudioUrls?.length ?? 0} audio=${data.generateAudio} prompt="${data.prompt}"`,
    );

    const buildInput = (prompt: string) => ({
      id: data.generationId,
      prompt,
      referenceImageUrls: data.referenceImageUrls,
      referenceVideoUrls: data.referenceVideoUrls,
      referenceAudioUrls: data.referenceAudioUrls,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
    });

    try {
      const result = await this.bytedanceSeedanceProvider.generateVideo(buildInput(data.prompt));
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error)) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.bytedanceSeedanceProvider.generateVideo(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  // ─── Audio process methods ──────────────────────────────────

  // ─── Kling V3 Turbo — Image to Video ───────────────────────

  private async processKlingImageToVideo(
    data: KlingImageToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[KLING_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s imageUrls=${data.imageUrls.length} prompt="${data.prompt ?? ''}"`,
    );

    const buildInput = (prompt: string | undefined) => ({
      id: data.generationId,
      prompt,
      imageUrls: data.imageUrls,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
    });

    try {
      const result = await this.klingProvider.generateImageToVideo(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error) && data.prompt) {
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.klingProvider.generateImageToVideo(buildInput(refined)),
        );
        if (retryResult) {
          await this.completeGeneration(data.generationId, retryResult, startTime);
          return;
        }
      }
      throw error;
    }
  }

  // ─── ComfyDeploy — WanImageToVideo (NSFW/legacy) ───────────

  private async processComfyDeployImageToVideo(
    data: ComfyDeployImageToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[COMFYDEPLOY_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s prompt="${data.prompt}"`,
    );

    const result = await this.comfyDeployProvider.generateImageToVideo({
      id: data.generationId,
      prompt: data.prompt,
      imageUrl: data.imageUrl,
      durationSeconds: data.durationSeconds,
    });
    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processTextToSpeech(data: TextToSpeechJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[TEXT_TO_SPEECH] ${data.generationId} voice=${data.voiceId} language=${data.language ?? 'auto'} speed=${data.speed ?? 1} text="${data.text.slice(0, 80)}"`,
    );

    const result = await this.wavespeedAudioProvider.generateTextToSpeech({
      id: data.generationId,
      text: data.text,
      voiceId: data.voiceId,
      language: data.language,
      speed: data.speed,
    });

    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processVoiceClone(data: VoiceCloneJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[VOICE_CLONE] ${data.generationId} audio=${data.audioUrl} language=${data.language ?? 'auto'} text="${data.text.slice(0, 80)}"`,
    );

    const result = await this.wavespeedAudioProvider.generateVoiceClone({
      id: data.generationId,
      text: data.text,
      audioUrl: data.audioUrl,
      language: data.language,
    });

    await this.completeGeneration(data.generationId, result, startTime);
  }

  // ─── Safety helpers ─────────────────────────────────────────

  private isSafetyRelatedError(error: unknown): boolean {
    if (error instanceof ContentSafetyError) return true;
    if (error instanceof Error) {
      if (error.message.includes('no video data returned')) {
        this.logger.warn(
          `Treating "${error.message}" as potential silent safety block`,
        );
        return true;
      }
      // Safety net: raw Error with a safety-related message slipped past provider conversion
      if (ContentSafetyError.fromErrorMessage(error.message)) {
        this.logger.warn(
          `Detected safety pattern in raw Error message: "${error.message}"`,
        );
        return true;
      }
    }
    return false;
  }

  // ─── Seedream universal fallback (for safety-blocked image generations) ──

  private async fallbackToSeedream(
    generationId: string,
    prompt: string,
    aspectRatio: string | undefined,
    originalError: unknown,
    context: string,
  ): Promise<{ outputUrls: string[]; modelUsed: string }> {
    this.logger.warn(
      `[FALLBACK_SEEDREAM_SAFETY] ${context} gen=${generationId} originalError="${(originalError as Error).message}"`,
    );

    // Skip if CRON already finalized this generation
    const preCheck = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (
      preCheck?.status === GenerationStatus.FAILED ||
      preCheck?.status === GenerationStatus.COMPLETED
    ) {
      this.logger.warn(
        `Generation ${generationId} already ${preCheck.status} before Seedream safety fallback — aborting`,
      );
      throw originalError;
    }


    const inputImages = await this.prisma.generationInputImage.findMany({
      where: { generationId },
      orderBy: { order: 'asc' },
    });
    const imageUrls = inputImages
      .map((img) => img.url)
      .filter((url): url is string => !!url);

    const result = await this.seedreamProvider.generateImage({
      id: generationId,
      prompt,
      resolution: Resolution.RES_2K,
      aspectRatio,
      imageUrls: imageUrls.length ? imageUrls : undefined,
    });

    // Tag as safety fallback so we can differentiate from direct Seedream runs
    const existing = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { parameters: true },
    });
    const params =
      existing?.parameters && typeof existing.parameters === 'object'
        ? (existing.parameters as Record<string, unknown>)
        : {};
    await this.prisma.generation.update({
      where: { id: generationId },
      data: {
        parameters: {
          ...params,
          seedreamSafetyFallback: true,
          seedreamFallbackFrom: context,
        },
      },
    });

    return { outputUrls: result.outputUrls, modelUsed: 'sem-censura-fallback' };
  }

  // ─── Safety refinement retry ────────────────────────────────

  private async retryWithRefinedPrompt(
    generationId: string,
    originalPrompt: string,
    generateFn: (refinedPrompt: string) => Promise<{ outputUrls: string[]; modelUsed: string }>,
  ): Promise<{ outputUrls: string[]; modelUsed: string } | null> {
    this.logger.warn(
      `Generation ${generationId} blocked by safety filter — attempting prompt refinement`,
    );

    let refinedPrompt: string | null;
    try {
      refinedPrompt = await this.promptEnhancer.refinePromptForSafety(originalPrompt);
    } catch (refineError) {
      this.logger.error(
        `Prompt refinement failed for ${generationId}: ${(refineError as Error).message}`,
      );
      return null;
    }

    if (!refinedPrompt) {
      this.logger.warn(
        `Prompt refinement returned null for ${generationId} — content is unrefinable`,
      );
      return null;
    }

    // Save the refined prompt for audit / user visibility
    await this.prisma.generation.update({
      where: { id: generationId },
      data: {
        parameters: {
          ...(await this.getExistingParameters(generationId)),
          originalPrompt,
          refinedBySafetyAgent: true,
        },
        prompt: refinedPrompt,
      },
    });

    this.logger.log(
      `Retrying generation ${generationId} with refined prompt — original: "${originalPrompt}" → refined: "${refinedPrompt}"`,
    );

    try {
      return await generateFn(refinedPrompt);
    } catch (retryError) {
      this.logger.error(
        `Retry with refined prompt also failed for ${generationId}: ${(retryError as Error).message}`,
      );
      if (this.isSafetyRelatedError(retryError)) {
        throw new ContentSafetyError(
          'A imagem ou texto enviado viola nossas diretrizes de conteúdo mesmo após ajuste automático. Tente reformular sua ideia de forma diferente.',
          retryError instanceof ContentSafetyError
            ? retryError.supportCode
            : undefined,
        );
      }
      throw retryError;
    }
  }

  private async getExistingParameters(
    generationId: string,
  ): Promise<Record<string, unknown>> {
    const gen = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { parameters: true },
    });
    return gen?.parameters && typeof gen.parameters === 'object'
      ? (gen.parameters as Record<string, unknown>)
      : {};
  }

  // ─── Shared helpers ─────────────────────────────────────────

  private async markProcessingStarted(generationId: string): Promise<void> {
    await this.prisma.generation.update({
      where: { id: generationId },
      data: { processingStartedAt: new Date() },
    });
  }

  private async completeGeneration(
    generationId: string,
    result: { outputUrls: string[]; modelUsed: string },
    startTime: number,
    provider?: string,
  ): Promise<void> {
    // Idempotency: skip if already completed/failed
    const current = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (
      current?.status === GenerationStatus.COMPLETED ||
      current?.status === GenerationStatus.FAILED
    ) {
      this.logger.warn(
        `Generation ${generationId} already ${current.status}, skipping completeGeneration`,
      );
      return;
    }

    const processingTimeMs = Date.now() - startTime;

    const updateData: Record<string, unknown> = {
      status: GenerationStatus.COMPLETED,
      modelUsed: result.modelUsed,
      processingTimeMs,
      completedAt: new Date(),
    };

    if (provider) {
      const existing = await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: { parameters: true },
      });
      const params =
        existing?.parameters && typeof existing.parameters === 'object'
          ? (existing.parameters as Record<string, unknown>)
          : {};
      updateData.parameters = { ...params, provider };
    }

    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: {
        type: true,
        quantity: true,
        creditsConsumed: true,
        userId: true,
      },
    });

    // Calculate expiresAt based on user's plan retention
    if (generation) {
      const retentionDays = await this.getUserRetentionDays(generation.userId);
      if (retentionDays !== null) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + retentionDays);
        updateData.expiresAt = expiresAt;
      }
    }

    const isImage =
      generation?.type === GenerationType.TEXT_TO_IMAGE ||
      generation?.type === GenerationType.IMAGE_TO_IMAGE;

    const isAudio = generation?.type === GenerationType.VOICE_CLONE;

    // For images: generate thumbnails/blur synchronously (fast).
    // For videos: skip thumbnails now, generate them async after delivery.
    let thumbnailUrls: (string | null)[] = result.outputUrls.map(() => null);
    let blurDataUrls: (string | null)[] = result.outputUrls.map(() => null);

    if (isImage) {
      try {
        thumbnailUrls = await Promise.all(
          result.outputUrls.map((url, i) =>
            this.uploadsService
              .generateThumbnail(
                url,
                `thumbnails/${generationId}`,
                `thumb_${i}.webp`,
                512,
                undefined,
                true,
              )
              .catch(() => null),
          ),
        );

        blurDataUrls = await Promise.all(
          result.outputUrls.map(async (url) => {
            try {
              const res = await fetch(url);
              if (!res.ok) return null;
              const buf = Buffer.from(await res.arrayBuffer());
              return this.uploadsService.generateBlurDataUrl(buf);
            } catch {
              return null;
            }
          }),
        );
      } catch (err) {
        this.logger.warn(
          `Image post-processing failed for ${generationId}: ${(err as Error).message}`,
        );
      }
    }

    const [updatedGeneration] = await this.prisma.$transaction([
      this.prisma.generation.update({
        where: { id: generationId },
        data: updateData,
      }),
      this.prisma.generationOutput.createMany({
        data: result.outputUrls.map((url, i) => ({
          generationId,
          url,
          thumbnailUrl: thumbnailUrls[i],
          blurDataUrl: blurDataUrls[i],
          order: i,
        })),
      }),
    ]);

    this.generationEvents.emit({
      userId: updatedGeneration.userId,
      generationId,
      status: 'completed',
      data: {
        outputUrls: result.outputUrls,
        processingTimeMs,
      },
    });

    this.logger.log(
      `Generation ${generationId} completed in ${processingTimeMs}ms — ${result.outputUrls.length} output(s)`,
    );

    // Fire-and-forget: generate video thumbnails + blur AFTER delivery
    if (!isImage && !isAudio) {
      this.generateVideoPostProcessing(generationId, result.outputUrls).catch(
        (err) =>
          this.logger.warn(
            `Video post-processing failed for ${generationId}: ${(err as Error).message}`,
          ),
      );
    }

    // Fire-and-forget: delete input files from S3 to save storage
    this.cleanupInputFiles(generationId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error): Promise<void> {
    this.logger.error(
      `Job ${job.id} [${job.name}] failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${error.message}`,
    );

    // Only refund after all retries are exhausted
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      this.logger.warn(`Job ${job.id} will be retried`);
      return;
    }

    await this.handleFailure(
      job.data.generationId,
      job.data.userId,
      job.data.creditsConsumed,
      error,
      job.data.usedFreeGeneration,
    );
  }

  private async handleFailure(
    generationId: string,
    userId: string,
    creditsConsumed: number,
    error: Error,
    usedFreeGeneration?: boolean,
  ): Promise<void> {
    // Idempotency: skip if already completed/failed
    const current = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (
      current?.status === GenerationStatus.COMPLETED ||
      current?.status === GenerationStatus.FAILED
    ) {
      this.logger.warn(
        `Generation ${generationId} already ${current.status}, skipping handleFailure`,
      );
      return;
    }

    const isSafetyError = this.isSafetyRelatedError(error);
    const errorCode = isSafetyError
      ? 'CONTENT_SAFETY_BLOCKED'
      : 'GENERATION_FAILED';

    const userMessage = isSafetyError
      ? 'A imagem ou texto enviado viola nossas diretrizes de conteúdo. Tente reformular seu prompt ou use outra imagem.'
      : error.message;

    this.logger.error(
      `Generation ${generationId} failed (${errorCode}): ${error.message}`,
      error.stack,
    );

    await this.prisma.generation.update({
      where: { id: generationId },
      data: {
        status: GenerationStatus.FAILED,
        errorMessage: userMessage,
        errorCode,
      },
    });

    if (usedFreeGeneration) {
      await this.creditsService.refundFreeGeneration(userId, generationId);
    } else {
      await this.creditsService.refund(userId, creditsConsumed, generationId);
    }

    this.generationEvents.emit({
      userId,
      generationId,
      status: 'failed',
      data: {
        errorMessage: userMessage,
        errorCode,
        creditsRefunded: usedFreeGeneration ? 0 : creditsConsumed,
      },
    });

    this.logger.log(
      usedFreeGeneration
        ? `Refunded free generation slot for failed generation ${generationId}`
        : `Refunded ${creditsConsumed} credits for failed generation ${generationId}`,
    );

    // Fire-and-forget: delete input files from S3 to save storage
    this.cleanupInputFiles(generationId);
  }

  private async getUserRetentionDays(
    userId: string,
  ): Promise<number | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { plan: { select: { galleryRetentionDays: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Return plan's retention or default 7 days for free users
    return subscription?.plan.galleryRetentionDays ?? 7;
  }

  private cleanupInputFiles(generationId: string): void {
    // Delete S3 files
    this.uploadsService
      .deleteByPrefix(`inputs/${generationId}/`)
      .then((count) => {
        if (count > 0) {
          this.logger.log(
            `Cleaned up ${count} input file(s) for generation ${generationId}`,
          );
        }
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to cleanup inputs for ${generationId}: ${(err as Error).message}`,
        );
      });

    // Delete DB records (no longer needed after processing)
    this.prisma.generationInputImage
      .deleteMany({ where: { generationId } })
      .then((result) => {
        if (result.count > 0) {
          this.logger.log(
            `Deleted ${result.count} input image record(s) for generation ${generationId}`,
          );
        }
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to delete input image records for ${generationId}: ${(err as Error).message}`,
        );
      });
  }

  private async loadInputImagesAsBase64(
    generationId: string,
  ): Promise<Array<{ base64: string; mimeType: string }>> {
    const inputImages = await this.prisma.generationInputImage.findMany({
      where: { generationId },
      orderBy: { order: 'asc' },
    });

    return Promise.all(
      inputImages
        .filter((img) => img.url)
        .map(async (img) => ({
          base64: await this.downloadToBase64(img.url!),
          mimeType: img.mimeType ?? 'image/png',
        })),
    );
  }

  private async downloadToBase64(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download from S3: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString('base64');
  }

  /**
   * Fire-and-forget: generates video thumbnails + blur AFTER the video
   * has been delivered to the user. Updates output records in DB.
   */
  private async generateVideoPostProcessing(
    generationId: string,
    outputUrls: string[],
  ): Promise<void> {
    const thumbnailUrls = await Promise.all(
      outputUrls.map((url, i) =>
        this.uploadsService
          .generateVideoThumbnail(
            url,
            `thumbnails/${generationId}`,
            `thumb_${i}.webp`,
          )
          .catch(() => null),
      ),
    );

    // Generate blur from thumbnails (not from the video file — Sharp can't process MP4)
    const blurDataUrls = await Promise.all(
      thumbnailUrls.map(async (thumbUrl) => {
        if (!thumbUrl) return null;
        try {
          const res = await fetch(thumbUrl);
          if (!res.ok) return null;
          const buf = Buffer.from(await res.arrayBuffer());
          return this.uploadsService.generateBlurDataUrl(buf);
        } catch {
          return null;
        }
      }),
    );

    // Update each output record with thumbnail + blur
    const outputs = await this.prisma.generationOutput.findMany({
      where: { generationId },
      orderBy: { order: 'asc' },
      select: { id: true, order: true },
    });

    await Promise.all(
      outputs.map((output) => {
        const thumbUrl = thumbnailUrls[output.order] ?? null;
        const blurUrl = blurDataUrls[output.order] ?? null;
        if (!thumbUrl && !blurUrl) return Promise.resolve();
        return this.prisma.generationOutput.update({
          where: { id: output.id },
          data: {
            ...(thumbUrl && { thumbnailUrl: thumbUrl }),
            ...(blurUrl && { blurDataUrl: blurUrl }),
          },
        });
      }),
    );

    this.logger.log(
      `Video post-processing done for ${generationId}: ${thumbnailUrls.filter(Boolean).length} thumbnail(s)`,
    );
  }
}
