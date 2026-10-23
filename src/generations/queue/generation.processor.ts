import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger, Optional } from '@nestjs/common';
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
import {
  WavespeedVideoProvider,
  type WavespeedVideoResolution,
  type SeedanceVideoResolution,
  type SeedanceAspectRatio,
  type MinimaxH3Resolution,
  type MinimaxH3AspectRatio,
} from '../providers/wavespeed-video.provider';
import { SeedreamLiteProvider } from '../providers/seedream-lite.provider';
import { SeedreamProvider } from '../providers/seedream.provider';
import { GptImageProvider } from '../providers/gpt-image.provider';
import { DeepDeepProvider } from '../providers/deepdeep.provider';
import { WavespeedAudioProvider } from '../providers/wavespeed-audio.provider';
import { GenerationEventsService } from '../generation-events.service';
import { PromptEnhancerService } from '../../prompt-enhancer/prompt-enhancer.service';
import { ContentSafetyService } from '../../content-safety/content-safety.service';
import {
  ImageSafetyService,
  type OutputCompletion,
} from '../../content-safety/image-safety/image-safety.service';
import {
  ConsentRequiredSafetyError,
  ContentSafetyError,
  isMinorSafetyBlock,
  isTerminalSafetyBlock,
  keepsInputsOnFailure,
  MinorSafetyBlockError,
  minorBlockAuditOf,
  SafetyCheckPendingError,
  safetyFallbackVerdict,
  type SafetyFallbackTarget,
  type TerminalSafetyBlockError,
  UnverifiedContentBlockError,
} from '../errors/content-safety.error';
import { deferJobForSafetyCheck } from './safety-check-deferral';
import type { PreflightStatus } from '../../content-safety/preflight-status';
import {
  jobCarriesUserMedia,
  mediaUrlForLog,
  providerMessageForLog,
  refinedPromptBlockOf,
  requestTextsOfJob,
  stackFramesForLog,
  textFingerprintForLog,
  withRefreshedMediaUrls,
} from './safety-fallback-guard';
import {
  failureCodeOf,
  failureUserMessage,
  GenerationFailureCode,
} from '../errors/failure-reason';

import {
  ContentSafetyEventKind,
  GenerationStatus,
  GenerationType,
  GenerationImageRole,
  Prisma,
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
  WavespeedImageToVideoJobData,
  WavespeedSeedanceImageToVideoJobData,
  MinimaxH3TextToVideoJobData,
  MinimaxH3ImageToVideoJobData,
  MinimaxH3ReferenceToVideoJobData,
  TextToSpeechJobData,
  VoiceCloneJobData,
} from './generation-queue.constants';

import { FACE_SWAP_SEEDREAM_PROMPT, UNDRESS_PROMPT } from './server-prompts';

/** O desvio que vem depois de um bloqueio do filtro (ver assertSafetyFallbackAllowed). */
interface SafetyFallbackRequest {
  /** modelo que bloqueou: vai para a trilha de auditoria como `provider:<modelo>` */
  model: string;
  /**
   * 'uncensored' = fallbackToSeedream (Unlocked sem censura, com as fotos da geração);
   * 'same_provider' = retryWithRefinedPrompt (prompt reescrito no MESMO provedor com filtro).
   */
  target: SafetyFallbackTarget;
  /**
   * O job já sabe que leva foto/frame/referência/vídeo do usuário (jobCarriesUserMedia). Falso ou ausente, a guarda
   * olha as imagens guardadas da geração (é o que o fallbackToSeedream manda ao Unlocked) e o atestado.
   */
  userMedia?: boolean;
}

/** O que o encerramento de uma geração precisa do job (handleFailure). */
interface FailureJobMeta {
  generationId: string;
  userId: string;
  creditsConsumed: number;
  usedFreeGeneration?: boolean;
}

/** Lê do job (dado sem tipo do BullMQ) o que o encerramento precisa; null quando falta id da geração ou do usuário. */
function failureMetaOf(jobData: unknown): FailureJobMeta | null {
  if (!jobData || typeof jobData !== 'object') return null;
  const data = jobData as Record<string, unknown>;
  if (typeof data.generationId !== 'string' || typeof data.userId !== 'string') {
    return null;
  }
  return {
    generationId: data.generationId,
    userId: data.userId,
    creditsConsumed:
      typeof data.creditsConsumed === 'number' ? data.creditsConsumed : 0,
    usedFreeGeneration: data.usedFreeGeneration === true,
  };
}

/**
 * O BullMQ ainda vai repetir este job? No evento 'failed', a falha definitiva já vem com `finishedOn` (fim das
 * tentativas, UnrecoverableError, job descartado). Olhar só `attemptsMade < attempts` não basta: nesses casos a
 * contagem fica abaixo do limite, ninguém encerrava a geração e ela ficava PROCESSING até o cron de presas.
 * Usado também pelo UnlimitedProcessor.
 */
export function willBeRetried(
  job: Pick<Job, 'attemptsMade' | 'opts' | 'finishedOn'>,
): boolean {
  if (job.finishedOn) return false;
  return job.attemptsMade < (job.opts.attempts ?? 1);
}

/** Id da geração do job (dado sem tipo do BullMQ); '' quando falta. */
function jobGenerationIdOf(jobData: unknown): string {
  if (!jobData || typeof jobData !== 'object') return '';
  const { generationId } = jobData as { generationId?: unknown };
  return typeof generationId === 'string' ? generationId : '';
}

/** Modelo do job para a trilha de auditoria (vídeo usa resolvedModel, Seedance usa modelId); '' = o da geração. */
function jobModelOf(jobData: unknown): string {
  if (!jobData || typeof jobData !== 'object') return '';
  const data = jobData as Record<string, unknown>;
  for (const key of ['resolvedModel', 'modelId', 'model']) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

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
    private readonly wavespeedVideoProvider: WavespeedVideoProvider,
    private readonly seedreamLiteProvider: SeedreamLiteProvider,
    private readonly seedreamProvider: SeedreamProvider,
    private readonly gptImageProvider: GptImageProvider,
    private readonly deepDeepProvider: DeepDeepProvider,
    private readonly wavespeedAudioProvider: WavespeedAudioProvider,
    private readonly generationEvents: GenerationEventsService,
    private readonly promptEnhancer: PromptEnhancerService,
    private readonly contentSafety: ContentSafetyService,
    /**
     * segurança de imagem e texto (módulo global); ausente ou com os modos off, nada roda (o desvio depois de uma
     * recusa segue a regra de antes da checagem: ContentSafetyService.enforcesMediaPreflight)
     */
    @Optional() private readonly imageSafety?: ImageSafetyService,
  ) {
    super();
  }

  async process(job: Job, token?: string): Promise<void> {
    this.logger.log(
      `Processing job ${job.id} [${job.name}] for generation ${job.data.generationId}`,
    );

    try {
      await this.dispatch(job.name, job.data);
    } catch (error) {
      // checagem de segurança fora do ar: o job espera na fila (nada foi ao provedor), sem desvio
      if (error instanceof SafetyCheckPendingError) {
        throw await deferJobForSafetyCheck(job, token, error);
      }
      const terminal = this.terminalSafetyBlockOf(error, job.data);
      if (!terminal) throw error;
      // Bloqueio terminal (menor de idade, foto sem atestado): encerra aqui e o job CONCLUI. Relançar faria o
      // BullMQ (attempts 2, backoff 30 s) mandar o mesmo prompt e as mesmas fotos ao provedor de novo.
      this.logger.warn(
        `Job ${job.id} [${job.name}] encerrado sem nova tentativa: ${terminal.name} (${terminal.failureCode})`,
      );
      await this.finalizeTerminalBlock(job.data, terminal);
    }
  }

  /**
   * Switch público compartilhado com o UnlimitedProcessor. Mantém os
   * métodos de processamento privados sem duplicar lógica entre filas.
   * Cada chamada (inclusive a nova tentativa do BullMQ) reassina as URLs de entrada do job: a assinada no upload
   * vence enquanto o job espera na fila.
   */
  async dispatch(jobName: string, jobData: unknown): Promise<void> {
    // porteiro de segurança ANTES do 1º provedor (as duas filas passam aqui); segurado ou já resolvido = não despacha
    if (!(await this.passesSafetyPreflight(jobName, jobData, true))) return;
    const generationId = jobGenerationIdOf(jobData);
    const data = await withRefreshedMediaUrls(jobData, (url) =>
      this.freshInputUrl(generationId, url),
    );
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
      case GenerationJobName.WAVESPEED_IMAGE_TO_VIDEO:
        return this.processWavespeedImageToVideo(
          data as WavespeedImageToVideoJobData,
        );
      case GenerationJobName.WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO:
        return this.processWavespeedSeedanceImageToVideo(
          data as WavespeedSeedanceImageToVideoJobData,
        );
      case GenerationJobName.MINIMAX_H3_TEXT_TO_VIDEO:
        return this.processMinimaxH3TextToVideo(
          data as MinimaxH3TextToVideoJobData,
        );
      case GenerationJobName.MINIMAX_H3_IMAGE_TO_VIDEO:
        return this.processMinimaxH3ImageToVideo(
          data as MinimaxH3ImageToVideoJobData,
        );
      case GenerationJobName.MINIMAX_H3_REFERENCE_TO_VIDEO:
        return this.processMinimaxH3ReferenceToVideo(
          data as MinimaxH3ReferenceToVideoJobData,
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
        requestTextsOfJob(data),
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
        requestTextsOfJob(data),
      );
    }
  }

  // ─── Process methods ────────────────────────────────────────

  async runImageJobDirectly(data: ImageJobData): Promise<void> {
    try {
      // sem fila não há espera: checagem indisponível encerra na hora (com estorno)
      if (
        !(await this.passesSafetyPreflight(GenerationJobName.IMAGE, data, false))
      ) {
        return;
      }
      await this.processImage(data);
    } catch (error) {
      await this.handleFailure(
        data.generationId,
        data.userId,
        data.creditsConsumed,
        error as Error,
        data.usedFreeGeneration,
        requestTextsOfJob(data),
      );
    }
  }

  private async processImage(data: ImageJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[IMAGE] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} hasInputImages=${data.hasInputImages} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    if (data.model === 'sem-censura') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = await this.freshInputUrls(
          data.generationId,
          inputImages.map((img) => img.url),
        );
      }

      const result = await this.seedreamProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        imageUrls,
        // "Unlocked" (sem-censura) é o modelo sem censura: não aplica o wrapper
        // de segurança que força roupa no personagem.
        skipSafetyWrapper: true,
      });

      await this.completeGeneration(data.generationId, result, startTime);
      return;
    }

    if (data.model === 'gpt-image-2' || data.model === 'gpt-image-2-5') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = await this.freshInputUrls(
          data.generationId,
          inputImages.map((img) => img.url),
        );
      }

      try {
        const result = await this.gptImageProvider.generateImage({
          id: data.generationId,
          prompt: data.prompt,
          resolution: data.resolution,
          aspectRatio: data.aspectRatio,
          imageUrls,
          family: data.model,
        });
        await this.completeGeneration(data.generationId, result, startTime);
      } catch (error) {
        if (this.isSafetyRelatedError(error)) {
          // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
          await this.assertSafetyFallbackAllowed(data.generationId, error, {
            model: data.model,
            target: 'uncensored',
            userMedia: data.hasInputImages,
          });
          const result = await this.fallbackToSeedream(
            data.generationId,
            data.prompt,
            data.aspectRatio,
            error,
            `processImage:${data.model}`,
          );
          await this.completeGeneration(data.generationId, result, startTime);
          return;
        }
        throw error;
      }
      return;
    }

    if (data.model === 'seedream-5-lite') {
      await this.processSeedreamLite(data, startTime, 'processImage');
      return;
    }

    if (data.model === 'deepdeep') {
      // Undress agora roda no Seedream (WaveSpeed, image-to-image) com prompt
      // explícito e sem o wrapper de roupa. Sempre precisa de imagem de input.
      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      const imageUrls = await this.freshInputUrls(
        data.generationId,
        inputImages.map((img) => img.url),
      );

      const result = await this.seedreamProvider.generateImage({
        id: data.generationId,
        prompt: UNDRESS_PROMPT,
        resolution: data.resolution,
        // Undress: saída sempre casa com a foto de entrada (match_input_image).
        // Ignora o aspect_ratio do request (o front manda 1:1 por default).
        aspectRatio: undefined,
        imageUrls,
        skipSafetyWrapper: true,
        modelUsedTag: 'deepdeep',
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
        // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: data.model,
          target: 'uncensored',
          userMedia: data.hasInputImages,
        });
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
      `[IMAGE_FALLBACK] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} hasInputImages=${data.hasInputImages} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    if (data.model === 'sem-censura') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = await this.freshInputUrls(
          data.generationId,
          inputImages.map((img) => img.url),
        );
      }

      const result = await this.seedreamProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        imageUrls,
        // "Unlocked" (sem-censura) é o modelo sem censura: não aplica o wrapper
        // de segurança que força roupa no personagem.
        skipSafetyWrapper: true,
      });

      await this.completeGeneration(data.generationId, result, startTime);
      return;
    }

    if (data.model === 'gpt-image-2' || data.model === 'gpt-image-2-5') {
      let imageUrls: string[] | undefined;
      if (data.hasInputImages) {
        const inputImages = await this.prisma.generationInputImage.findMany({
          where: { generationId: data.generationId },
          orderBy: { order: 'asc' },
        });
        imageUrls = await this.freshInputUrls(
          data.generationId,
          inputImages.map((img) => img.url),
        );
      }

      try {
        const result = await this.gptImageProvider.generateImage({
          id: data.generationId,
          prompt: data.prompt,
          resolution: data.resolution,
          aspectRatio: data.aspectRatio,
          imageUrls,
          family: data.model,
        });
        await this.completeGeneration(data.generationId, result, startTime);
      } catch (error) {
        if (this.isSafetyRelatedError(error)) {
          // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
          await this.assertSafetyFallbackAllowed(data.generationId, error, {
            model: data.model,
            target: 'uncensored',
            userMedia: data.hasInputImages,
          });
          const result = await this.fallbackToSeedream(
            data.generationId,
            data.prompt,
            data.aspectRatio,
            error,
            `processImageWithFallback:${data.model}`,
          );
          await this.completeGeneration(data.generationId, result, startTime);
          return;
        }
        throw error;
      }
      return;
    }

    // Sem este desvio o Seedream Lite caía no provider Gemini (modelo
    // desconhecido) e terminava silenciosamente no Nano Banana 2.
    if (data.model === 'seedream-5-lite') {
      await this.processSeedreamLite(data, startTime, 'processImageWithFallback');
      return;
    }

    if (data.model === 'deepdeep') {
      // Undress agora roda no Seedream (WaveSpeed, image-to-image) com prompt
      // explícito e sem o wrapper de roupa. Sempre precisa de imagem de input.
      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      const imageUrls = await this.freshInputUrls(
        data.generationId,
        inputImages.map((img) => img.url),
      );

      const result = await this.seedreamProvider.generateImage({
        id: data.generationId,
        prompt: UNDRESS_PROMPT,
        resolution: data.resolution,
        // Undress: saída sempre casa com a foto de entrada (match_input_image).
        // Ignora o aspect_ratio do request (o front manda 1:1 por default).
        aspectRatio: undefined,
        imageUrls,
        skipSafetyWrapper: true,
        modelUsedTag: 'deepdeep',
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
      // bloqueio terminal (inclusive da checagem da saída) nunca desvia nem regera em outro provedor
      if (isTerminalSafetyBlock(theaimodelabError)) throw theaimodelabError;
      if (this.isSafetyRelatedError(theaimodelabError)) {
        // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
        await this.assertSafetyFallbackAllowed(data.generationId, theaimodelabError, {
          model: data.model,
          target: 'uncensored',
          userMedia: data.hasInputImages,
        });
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
        `The AI Model Lab failed for ${data.generationId}, falling back to Nano Banana: ${providerMessageForLog(theaimodelabError, [data.prompt])}`,
      );

      // Check if CRON already marked this generation as FAILED — skip KIE to avoid paying for nothing
      const preCheck = await this.prisma.generation.findUnique({
        where: { id: data.generationId },
        select: { status: true },
      });
      if (
        preCheck?.status === GenerationStatus.FAILED ||
        preCheck?.status === GenerationStatus.COMPLETED ||
        preCheck?.status === GenerationStatus.IN_REVIEW
      ) {
        this.logger.warn(
          `Generation ${data.generationId} already ${preCheck.status} before Nano Banana fallback — aborting to save KIE costs`,
        );
        return;
      }
      // conta suspensa no meio do job (camada 6): o desvio técnico também não chama mais um provedor
      await this.imageSafety?.haltIfAccountSuspended(data);

      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
      });
      const imageUrls = await this.freshInputUrls(
        data.generationId,
        inputImages.map((img) => img.url),
      );

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
          // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
          await this.assertSafetyFallbackAllowed(data.generationId, nanoBananaError, {
            model: nanaBananaModel,
            target: 'uncensored',
            userMedia: data.hasInputImages,
          });
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

  private async processSeedreamLite(
    data: ImageJobData,
    startTime: number,
    context: string,
  ): Promise<void> {
    let imageUrls: string[] | undefined;
    if (data.hasInputImages) {
      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      imageUrls = await this.freshInputUrls(
        data.generationId,
        inputImages.map((img) => img.url),
      );
    }

    try {
      const result = await this.seedreamLiteProvider.generateImage({
        id: data.generationId,
        prompt: data.prompt,
        resolution: data.resolution,
        aspectRatio: data.aspectRatio,
        imageUrls,
      });
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      // Bloqueio de conteúdo vai direto pro Unlocked, como os demais modelos.
      if (this.isSafetyRelatedError(error)) {
        // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: 'seedream-5-lite',
          target: 'uncensored',
          userMedia: data.hasInputImages,
        });
        const result = await this.fallbackToSeedream(
          data.generationId,
          data.prompt,
          data.aspectRatio,
          error,
          `${context}:seedream-5-lite`,
        );
        await this.completeGeneration(data.generationId, result, startTime);
        return;
      }
      throw error;
    }
  }

  private async processNanoBanana(data: ImageNanoBananaJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[NANO_BANANA] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} outputFormat=${data.outputFormat} googleSearch=${data.googleSearch} imageUrls=${data.imageUrls?.length ?? 0} prompt ${textFingerprintForLog(data.prompt)}`,
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
        // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: data.model,
          target: 'uncensored',
          userMedia: !!data.imageUrls?.length,
        });
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
      `[TEXT_TO_VIDEO] ${data.generationId} model=${data.model} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} audio=${data.generateAudio} samples=${data.sampleCount} prompt ${textFingerprintForLog(data.prompt)}`,
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
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: data.model,
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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
      `[IMAGE_TO_VIDEO] ${data.generationId} model=${data.resolvedModel} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} audio=${data.generateAudio} samples=${data.sampleCount} prompt ${textFingerprintForLog(data.prompt)}`,
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

    const firstFrameBase64 = await this.downloadToBase64(
      firstFrameImg.url,
      data.generationId,
    );
    const lastFrameBase64 = lastFrameImg?.url
      ? await this.downloadToBase64(lastFrameImg.url, data.generationId)
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
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: data.resolvedModel,
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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
      `[REFERENCE_VIDEO] ${data.generationId} model=${data.resolvedModel} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} audio=${data.generateAudio} samples=${data.sampleCount} prompt ${textFingerprintForLog(data.prompt)}`,
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
        base64: img.url
          ? await this.downloadToBase64(img.url, data.generationId)
          : '',
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
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: data.resolvedModel,
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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
      `[MOTION_CONTROL] ${data.generationId} resolution=${data.resolution} videoUrl=${mediaUrlForLog(data.videoUrl)} imageUrl=${mediaUrlForLog(data.imageUrl)}`,
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
      // bloqueio terminal (inclusive da checagem da saída) nunca desvia nem regera em outro provedor
      if (isTerminalSafetyBlock(theaimodelabError)) throw theaimodelabError;
      if (this.isSafetyRelatedError(theaimodelabError)) {
        // try-on sempre leva a foto da pessoa e a da roupa
        // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
        await this.assertSafetyFallbackAllowed(data.generationId, theaimodelabError, {
          model: data.model,
          target: 'uncensored',
          userMedia: true,
        });
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
        `The AI Model Lab failed for virtual try-on ${data.generationId}, falling back to Nano Banana: ${providerMessageForLog(theaimodelabError, [data.prompt])}`,
      );

      const preCheck = await this.prisma.generation.findUnique({
        where: { id: data.generationId },
        select: { status: true },
      });
      if (
        preCheck?.status === GenerationStatus.FAILED ||
        preCheck?.status === GenerationStatus.COMPLETED ||
        preCheck?.status === GenerationStatus.IN_REVIEW
      ) {
        this.logger.warn(
          `Generation ${data.generationId} already ${preCheck.status} before Nano Banana fallback — aborting to save KIE costs`,
        );
        return;
      }
      // conta suspensa no meio do job (camada 6): o desvio técnico também não chama mais um provedor
      await this.imageSafety?.haltIfAccountSuspended(data);

      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      const imageUrls = await this.freshInputUrls(
        data.generationId,
        inputImages.map((img) => img.url),
      );

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
          // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
          await this.assertSafetyFallbackAllowed(data.generationId, nanoBananaError, {
            model: nanoBananaModel,
            target: 'uncensored',
            userMedia: true,
          });
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
      `[FACE_SWAP] ${data.generationId} resolution=${data.resolution} nsfw=${data.nsfw ?? false} sourceImage=${mediaUrlForLog(data.sourceImageUrl)} targetImage=${mediaUrlForLog(data.targetImageUrl)}`,
    );

    // Unlocked (NSFW): rota direto pelo Seedream sem censura. Não passa pelo
    // nano-banana-2 porque ele devolveria um resultado com roupa em vez de erro
    // — então o fallback de segurança nem dispararia.
    if (data.nsfw) {
      const resolutionMap: Record<string, Resolution> = {
        '1K': Resolution.RES_1K,
        '2K': Resolution.RES_2K,
        '4K': Resolution.RES_4K,
      };
      const result = await this.seedreamProvider.generateImage({
        id: data.generationId,
        prompt: FACE_SWAP_SEEDREAM_PROMPT,
        resolution: resolutionMap[data.resolution] ?? Resolution.RES_2K,
        imageUrls: [data.sourceImageUrl, data.targetImageUrl],
        skipSafetyWrapper: true,
      });
      await this.completeGeneration(data.generationId, result, startTime);
      return;
    }

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
        // troca de rosto sempre leva duas fotos do usuário (rosto e cena)
        // alvo 'uncensored': o desvio abaixo é o Unlocked sem censura (fallbackToSeedream), com as fotos da geração
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: 'face-swap',
          target: 'uncensored',
          userMedia: true,
        });
        const result = await this.fallbackToSeedream(
          data.generationId,
          FACE_SWAP_SEEDREAM_PROMPT,
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
      `[TEXT_TO_VIDEO_KIE] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} audio=${data.generateAudio} prompt ${textFingerprintForLog(data.prompt)}`,
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
      `[IMAGE_TO_VIDEO_KIE] ${data.generationId} model=${data.model} resolution=${data.resolution} aspectRatio=${data.aspectRatio} audio=${data.generateAudio} imageUrls=${data.imageUrls.length} prompt ${textFingerprintForLog(data.prompt)}`,
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
      `[REFERENCE_TO_VIDEO_KIE] ${data.generationId} model=veo3_fast resolution=${data.resolution} aspectRatio=${data.aspectRatio} audio=${data.generateAudio} imageUrls=${data.imageUrls.length} prompt ${textFingerprintForLog(data.prompt)}`,
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
      `[IMAGE_TO_VIDEO_GROK] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} mode=${data.mode ?? 'normal'} imageUrls=${data.imageUrls.length} prompt ${textFingerprintForLog(data.prompt)}`,
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
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: 'grok-imagine',
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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
      `[TEXT_TO_VIDEO_GROK] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} mode=${data.mode ?? 'normal'} prompt ${textFingerprintForLog(data.prompt)}`,
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
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: 'grok-imagine',
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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
      `[OMNI_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} images=${data.imageUrls?.length ?? 0} videos=${data.videoList?.length ?? 0} hasVideo=${data.hasVideoInput} prompt ${textFingerprintForLog(data.prompt)}`,
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
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: 'gemini-omni',
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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

  // ─── Bytedance Seedance 2.0 / 2.5 ──────────────────────────

  private async processSeedanceVideo(data: SeedanceVideoJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[SEEDANCE_VIDEO] ${data.generationId} model=${data.modelId ?? 'bytedance/seedance-2'} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} refImages=${data.referenceImageUrls?.length ?? 0} refVideos=${data.referenceVideoUrls?.length ?? 0} refAudios=${data.referenceAudioUrls?.length ?? 0} firstFrame=${!!data.firstFrameUrl} lastFrame=${!!data.lastFrameUrl} audio=${data.generateAudio} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    const buildInput = (prompt: string) => ({
      id: data.generationId,
      prompt,
      modelId: data.modelId,
      referenceImageUrls: data.referenceImageUrls,
      referenceVideoUrls: data.referenceVideoUrls,
      referenceAudioUrls: data.referenceAudioUrls,
      firstFrameUrl: data.firstFrameUrl,
      lastFrameUrl: data.lastFrameUrl,
      webSearch: data.webSearch,
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
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: data.modelId ?? 'bytedance/seedance-2',
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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
      `[KLING_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s imageUrls=${data.imageUrls.length} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    const buildInput = (prompt: string | undefined) => ({
      id: data.generationId,
      prompt,
      imageUrls: data.imageUrls,
      resolution: data.resolution,
      durationSeconds: data.durationSeconds,
      aspectRatio: data.aspectRatio,
      generateAudio: data.generateAudio,
    });

    try {
      const result = await this.klingProvider.generateImageToVideo(
        buildInput(data.prompt),
      );
      await this.completeGeneration(data.generationId, result, startTime);
    } catch (error) {
      if (this.isSafetyRelatedError(error) && data.prompt) {
        // alvo 'same_provider': prompt reescrito no MESMO provedor; com mídia do usuário e o porteiro ligado, encerra
        await this.assertSafetyFallbackAllowed(data.generationId, error, {
          model: 'kling-v3-turbo',
          target: 'same_provider',
          userMedia: jobCarriesUserMedia(data),
        });
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
      `[COMFYDEPLOY_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s prompt ${textFingerprintForLog(data.prompt)}`,
    );

    const result = await this.comfyDeployProvider.generateImageToVideo({
      id: data.generationId,
      prompt: data.prompt,
      imageUrl: data.imageUrl,
      durationSeconds: data.durationSeconds,
    });
    await this.completeGeneration(data.generationId, result, startTime);
  }

  // ─── WaveSpeed — LTX 2.3 Spicy (image-to-video, NSFW) ───────

  private async processWavespeedImageToVideo(
    data: WavespeedImageToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[WAVESPEED_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s prompt ${textFingerprintForLog(data.prompt)}`,
    );

    // Resolução DB -> resolução aceita pelo LTX (480p/720p/1080p).
    const resMap: Record<string, WavespeedVideoResolution> = {
      RES_480P: '480p',
      RES_720P: '720p',
      RES_1080P: '1080p',
    };

    const result = await this.wavespeedVideoProvider.generateImageToVideo({
      id: data.generationId,
      prompt: data.prompt,
      imageUrl: data.imageUrl,
      durationSeconds: data.durationSeconds,
      resolution: resMap[data.resolution] ?? '480p',
      preset: data.preset,
    });
    await this.completeGeneration(data.generationId, result, startTime);
  }

  // ─── WaveSpeed — Seedance 2.0 Fast Spicy (image-to-video, NSFW) ───

  private async processWavespeedSeedanceImageToVideo(
    data: WavespeedSeedanceImageToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s audio=${data.generateAudio} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    // Resolução DB -> resolução aceita pelo Seedance (480p/720p/1080p/4k).
    const resMap: Record<string, SeedanceVideoResolution> = {
      RES_480P: '480p',
      RES_720P: '720p',
      RES_1080P: '1080p',
      RES_4K: '4k',
    };

    const result = await this.wavespeedVideoProvider.generateSeedanceImageToVideo({
      id: data.generationId,
      prompt: data.prompt,
      imageUrl: data.imageUrl,
      durationSeconds: data.durationSeconds,
      resolution: resMap[data.resolution] ?? '720p',
      aspectRatio: data.aspectRatio as SeedanceAspectRatio | undefined,
      generateAudio: data.generateAudio,
    });
    await this.completeGeneration(data.generationId, result, startTime);
  }

  // ─── WaveSpeed — MiniMax H3 (text/image/reference to video) ───
  // Resolução DB -> string do WaveSpeed. RES_720P mapeia para '768p'
  // (canvas nativo do MiniMax H3); RES_480P -> '480p'.
  private static readonly MINIMAX_H3_RES_MAP: Record<
    string,
    MinimaxH3Resolution
  > = {
    RES_480P: '480p',
    RES_720P: '768p',
  };

  private async processMinimaxH3TextToVideo(
    data: MinimaxH3TextToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[MINIMAX_H3_TEXT_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspect=${data.aspectRatio ?? '16:9'} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    const result = await this.wavespeedVideoProvider.generateMinimaxH3TextToVideo({
      id: data.generationId,
      prompt: data.prompt,
      durationSeconds: data.durationSeconds,
      resolution:
        GenerationProcessor.MINIMAX_H3_RES_MAP[data.resolution] ?? '480p',
      aspectRatio: data.aspectRatio as MinimaxH3AspectRatio | undefined,
    });
    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processMinimaxH3ImageToVideo(
    data: MinimaxH3ImageToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[MINIMAX_H3_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s lastFrame=${data.lastImageUrl ? 'yes' : 'no'} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    const result = await this.wavespeedVideoProvider.generateMinimaxH3ImageToVideo({
      id: data.generationId,
      prompt: data.prompt,
      imageUrl: data.imageUrl,
      lastImageUrl: data.lastImageUrl,
      durationSeconds: data.durationSeconds,
      resolution:
        GenerationProcessor.MINIMAX_H3_RES_MAP[data.resolution] ?? '480p',
    });
    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processMinimaxH3ReferenceToVideo(
    data: MinimaxH3ReferenceToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[MINIMAX_H3_REFERENCE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspect=${data.aspectRatio ?? '16:9'} refImages=${data.referenceImageUrls?.length ?? 0} refVideos=${data.referenceVideoUrls?.length ?? 0} refAudios=${data.referenceAudioUrls?.length ?? 0} prompt ${textFingerprintForLog(data.prompt)}`,
    );

    const result =
      await this.wavespeedVideoProvider.generateMinimaxH3ReferenceToVideo({
        id: data.generationId,
        prompt: data.prompt,
        durationSeconds: data.durationSeconds,
        resolution:
          GenerationProcessor.MINIMAX_H3_RES_MAP[data.resolution] ?? '480p',
        aspectRatio: data.aspectRatio as MinimaxH3AspectRatio | undefined,
        referenceImageUrls: data.referenceImageUrls,
        referenceVideoUrls: data.referenceVideoUrls,
        referenceAudioUrls: data.referenceAudioUrls,
      });
    await this.completeGeneration(data.generationId, result, startTime);
  }

  private async processTextToSpeech(data: TextToSpeechJobData): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[TEXT_TO_SPEECH] ${data.generationId} voice=${data.voiceId} language=${data.language ?? 'auto'} speed=${data.speed ?? 1} text ${textFingerprintForLog(data.text)}`,
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
      `[VOICE_CLONE] ${data.generationId} audio=${mediaUrlForLog(data.audioUrl)} language=${data.language ?? 'auto'} text ${textFingerprintForLog(data.text)}`,
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

  /**
   * Porteiro de segurança da plataforma (ImageSafetyService.preflight) antes do 1º provedor: true = pode despachar.
   * Bloqueio lança erro terminal; fornecedor fora lança SafetyCheckPendingError (o process() adia o job) ou, sem fila,
   * SafetyCheckUnavailableError. Sem o serviço ou com os modos off, sempre true (Onda 0).
   * PR API #3: o dispatchWithFallback chama o dispatch(); o catch dele relança isSafetyCheckHalt (terminal OU pendente)
   * ANTES de calcular o kind do tryFallback, senão a checagem pendente vira 'provider' e desvia para o MiniMax H3.
   */
  private async passesSafetyPreflight(
    jobName: string,
    jobData: unknown,
    queued: boolean,
  ): Promise<boolean> {
    if (!this.imageSafety) return true;
    const outcome = await this.imageSafety.preflight(
      { name: jobName, data: jobData },
      { queued },
    );
    return outcome.action === 'proceed';
  }

  private isSafetyRelatedError(error: unknown): boolean {
    if (error instanceof ContentSafetyError) return true;
    if (error instanceof Error) {
      // a mensagem crua do provedor pode repetir o prompt: o log leva só o motivo e o tamanho
      if (error.message.includes('no video data returned')) {
        this.logger.warn(
          `Treating "no video data returned" (len=${error.message.length}) as potential silent safety block`,
        );
        return true;
      }
      // Safety net: raw Error with a safety-related message slipped past provider conversion
      const detected = ContentSafetyError.fromErrorMessage(error.message);
      if (detected) {
        this.logger.warn(
          `Detected safety pattern in raw Error message (len=${error.message.length}${detected.supportCode ? ` support code ${detected.supportCode}` : ''})`,
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Guarda que roda ANTES de todo desvio de um bloqueio de segurança. Passa calada quando o desvio pode seguir e
   * LANÇA um bloqueio terminal quando não pode; o process() (e o UnlimitedProcessor, e os run*Directly) encerram a
   * geração pelo caminho normal de falha (handleFailure: estorno, SSE, MINOR_BLOCKED) sem nova tentativa do BullMQ.
   * Só junta os fatos; a regra mora em safetyFallbackVerdict (content-safety.error.ts):
   *  - menor de idade, qualquer alvo e qualquer modo → MinorSafetyBlockError (CONTENT_POLICY_MINOR);
   *  - porteiro de imagem DESLIGADO (IMAGE_SAFETY_MODE=off, o padrão): regra de antes da checagem. 'same_provider'
   *    segue, com ou sem mídia (a reescrita passa pela trava de texto dentro do retryWithRefinedPrompt); 'uncensored'
   *    com mídia do usuário sem atestado → ConsentRequiredSafetyError (CONTENT_BLOCKED_NEEDS_CONSENT); o resto segue
   *    o desvio de sempre. O veredito do porteiro nem é lido;
   *  - porteiro LIGADO (shadow ou enforce):
   *    - alvo 'same_provider' (retryWithRefinedPrompt) com mídia do usuário → UnverifiedContentBlockError
   *      (CONTENT_SAFETY_BLOCKED) com QUALQUER veredito: reescrever o prompt para passar no filtro e reenviar a mesma
   *      foto não existe (seção 2, camada 4, regra 3); só com texto → segue (a reescrita passa pelas camadas 1 e 2
   *      dentro do retryWithRefinedPrompt);
   *    - alvo 'uncensored' com mídia do usuário sem veredito 'clean' → UnverifiedContentBlockError. O veredito é o da
   *      entrada reavaliada como pedido sexual (o destino não tem filtro: zona de dúvida e estilizado sem juiz não
   *      passam);
   *    - alvo 'uncensored' (fallbackToSeedream) com foto limpa sem atestado → ConsentRequiredSafetyError;
   *    - alvo 'uncensored' só com texto, ou com foto limpa e atestada → segue o desvio de sempre.
   * Erro de banco na leitura das fotos, do atestado ou do veredito nunca libera o desvio (conta como foto do usuário,
   * sem atestado e sem checagem).
   *
   * PR API #3 (fix/creditos-auditoria) reescreve este processor (dispatchWithFallback + generation-fallback.ts).
   * Ao mergear, reaplicar aqui: (1) esta guarda antes de todo fallbackToSeedream (alvo 'uncensored') e de todo
   * retryWithRefinedPrompt (alvo 'same_provider'); (2) a mesma guarda, alvo 'uncensored', antes de TODO fallback
   * automático de modelo cujo alvo seja sem censura (isUncensoredModel, ex.: vídeo kie → MiniMax H3), com kind
   * 'safety' E 'provider' ("entrada recusada" conta como 'safety'): com foto, porteiro ligado só segue com preflight
   * 'clean' e desligado só com o atestado;
   * (3) o catch de bloqueio terminal no process() e no UnlimitedProcessor.process() (sem relançar);
   * (4) failureCodeOf/failureUserMessage no handleFailure e no markFailed do ilimitado;
   * (5) no catch do dispatchWithFallback, ANTES de calcular o kind: `const unwrapped = unwrapJobError(original); if
   * (isTerminalSafetyBlock(unwrapped) || isMinorSafetyBlock(unwrapped)) throw new GenerationUnrecoverableError(original)`.
   * Os bloqueios desta guarda (menor, reescrita barrada, mídia sem checagem) estendem ContentSafetyError e cairiam como
   * kind 'safety' no desvio; a guarda de (2) fica dentro do tryFallback mas FORA do try/catch de orquestração, que
   * engole o erro e devolve 'none';
   * (6) o tryFallback relê inputImageUrls do banco: passar por freshInputUrls (a assinada no upload vence);
   * (7) uma lista só de mídia do usuário: o hasUserMedia do generation-fallback.ts chama jobCarriesUserMedia e a
   * USER_MEDIA_FIELDS sai (conferir que os campos dela estão em safety-fallback-guard.ts);
   * (8) o log "[FALLBACK] … motivo=" usa providerMessageForLog (sem prompt nem URL assinada);
   * (9) camada 6: `await this.imageSafety?.haltIfGenerationOwnerSuspended(generationId)` antes de cada tentativa do
   * tryFallback (desvio técnico ou de segurança), como aqui no allow_fallback e antes da Nano Banana.
   * Na #3 o erro chega embrulhado em GenerationUnrecoverableError: o catch de (3) passa por unwrapJobError antes de
   * terminalSafetyBlockOf, senão a recusa por menor não é reconhecida. O "unsafe image upload" da #3 entra no
   * CONTENT_BLOCK_PATTERN de errors/failure-reason.ts. Merge de teste: conflito neste arquivo, no unlimited.processor.ts,
   * no errors/failure-reason.ts e no .env.example.
   */
  private async assertSafetyFallbackAllowed(
    generationId: string,
    error: unknown,
    request: SafetyFallbackRequest,
  ): Promise<void> {
    // bloqueio terminal que chegou a um catch de provedor (checagem da plataforma, guarda anterior) nunca desvia
    if (isTerminalSafetyBlock(error)) throw error;
    const isMinor = isMinorSafetyBlock(error);
    // porteiro de imagem ligado (config dele): só então a mídia do usuário depende do veredito
    const enforceMediaPreflight = this.contentSafety.enforcesMediaPreflight();
    // o atestado só existe em pedido com foto: também conta como mídia do usuário
    const hasConsent =
      !isMinor && (await this.hasConsentForGeneration(generationId));
    const hasUserImages =
      !isMinor &&
      (request.userMedia === true ||
        hasConsent ||
        (await this.hasStoredInputImages(generationId)));
    // só o desvio sem censura com o porteiro ligado consulta o veredito: com foto, a reescrita no mesmo provedor encerra
    // com qualquer veredito, e com o porteiro desligado ele não conta
    const preflight: PreflightStatus =
      enforceMediaPreflight && hasUserImages && request.target === 'uncensored'
        ? await this.preflightStatusFor(generationId, request.target)
        : 'unavailable';
    const { decision, reason } = safetyFallbackVerdict({
      target: request.target,
      isMinor,
      hasUserImages,
      hasConsent,
      enforceMediaPreflight,
      preflight,
    });

    if (decision === 'allow_fallback') {
      // conta suspensa no meio do job (camada 6): o desvio não chama mais um provedor (com o modo off, nada é lido)
      await this.imageSafety?.haltIfGenerationOwnerSuspended(generationId);
      return;
    }

    if (reason === 'unverified_media') {
      this.logger.warn(
        `[SAFETY_GUARD] gen=${generationId} model=${request.model} target=${request.target}: bloqueio com mídia do usuário sem checagem limpa da imagem (preflight=${preflight}) — encerrada sem desvio`,
      );
      throw new UnverifiedContentBlockError(
        error,
        request.model,
        'unverified_media',
      );
    }

    if (decision === 'fail_minor') {
      const minorError = new MinorSafetyBlockError(error, request.model);
      this.logger.warn(
        `[SAFETY_GUARD] gen=${generationId} model=${request.model}: provedor recusou por MENOR de idade — geração encerrada sem desvio (${minorError.supportCode ? `support code ${minorError.supportCode}` : `len=${minorError.providerDetail.length}`})`,
      );
      throw minorError;
    }

    this.logger.warn(
      `[SAFETY_GUARD] gen=${generationId} model=${request.model}: bloqueio com foto do usuário sem atestado de imagem — encerrada sem desvio para modelo sem censura`,
    );
    throw new ConsentRequiredSafetyError(error, request.model);
  }

  /**
   * Bloqueio que encerra a geração SEM nova tentativa: o que a guarda lançou (menor, foto sem atestado) e toda
   * recusa por MENOR que escapou dela (provedor sem desvio, o próprio Unlocked, a nova tentativa com prompt
   * reescrito). Devolve o erro pronto para o encerramento (a recusa por menor vira MinorSafetyBlockError com o
   * modelo do job para a trilha) ou null quando a falha segue o caminho normal, com o retry do BullMQ.
   * Público: o UnlimitedProcessor usa a mesma regra.
   */
  terminalSafetyBlockOf(
    error: unknown,
    jobData: unknown,
  ): TerminalSafetyBlockError | null {
    if (isTerminalSafetyBlock(error)) return error;
    if (!this.isMinorProviderRefusal(error)) return null;
    return new MinorSafetyBlockError(error, jobModelOf(jobData));
  }

  /** Recusa do provedor por MENOR de idade (mesma regra da classificação CONTENT_POLICY_MINOR). */
  private isMinorProviderRefusal(error: unknown): error is Error {
    if (!(error instanceof Error)) return false;
    const isSafetyError = this.isSafetyRelatedError(error);
    // o código de criança pode vir só no campo supportCode, fora do texto que a classificação lê
    if (isSafetyError && isMinorSafetyBlock(error)) return true;
    return (
      failureCodeOf(error, isSafetyError) ===
      GenerationFailureCode.CONTENT_POLICY_MINOR
    );
  }

  /**
   * Encerra a geração de um bloqueio terminal pelo caminho normal de falha (estorno como em toda falha, SSE,
   * MINOR_BLOCKED uma vez). Nunca lança: um erro aqui faria o BullMQ repetir o job e reenviar o pedido ao provedor.
   */
  private async finalizeTerminalBlock(
    jobData: unknown,
    error: TerminalSafetyBlockError,
  ): Promise<void> {
    const meta = failureMetaOf(jobData);
    if (!meta) {
      this.logger.error(
        `[SAFETY_GUARD] job sem generationId/userId — bloqueio ${error.failureCode} não pôde encerrar a geração`,
      );
      return;
    }
    try {
      await this.handleFailure(
        meta.generationId,
        meta.userId,
        meta.creditsConsumed,
        error,
        meta.usedFreeGeneration,
        requestTextsOfJob(jobData),
      );
    } catch (finalizeError) {
      this.logger.error(
        `[SAFETY_GUARD] gen=${meta.generationId}: encerramento do bloqueio ${error.failureCode} falhou (${(finalizeError as Error).message}) — conferir o estorno no admin`,
      );
      await this.failStuckGeneration(meta.generationId, meta.userId, error);
    }
  }

  /**
   * Última linha de defesa quando o encerramento normal (handleFailure / markFailed) lançou: marca FAILED só se a
   * geração ainda estiver PROCESSING e avisa o site pelo SSE. Não estorna (o estorno pode ter rodado antes do erro;
   * o log de quem chamou pede a conferência). Nunca lança. Público: o UnlimitedProcessor usa no onFailed.
   */
  async failStuckGeneration(
    generationId: string,
    userId: string,
    error: Error,
  ): Promise<void> {
    const errorCode = failureCodeOf(error, this.isSafetyRelatedError(error));
    const errorMessage = failureUserMessage(errorCode, error);
    try {
      const { count } = await this.prisma.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.PROCESSING },
        data: { status: GenerationStatus.FAILED, errorMessage, errorCode },
      });
      if (count === 0) return;
      this.generationEvents.emit({
        userId,
        generationId,
        status: 'failed',
        data: { errorMessage, errorCode, creditsRefunded: 0 },
      });
    } catch (updateError) {
      this.logger.error(
        `Generation ${generationId} segue PROCESSING: nem o encerramento de reserva gravou (${(updateError as Error).message}) — o cron de presas encerra depois`,
      );
    }
  }

  /** A geração tem foto do usuário guardada? É o que fallbackToSeedream manda para o Unlocked. */
  private async hasStoredInputImages(generationId: string): Promise<boolean> {
    try {
      const count = await this.prisma.generationInputImage.count({
        where: { generationId },
      });
      return count > 0;
    } catch (error) {
      this.logger.error(
        `[SAFETY_GUARD] gen=${generationId}: falha ao ler as imagens de entrada (${(error as Error).message}) — tratando como foto do usuário`,
      );
      return true;
    }
  }

  /** O pedido que criou a geração trouxe atestado de consentimento? Falha de leitura = sem atestado. */
  private async hasConsentForGeneration(generationId: string): Promise<boolean> {
    try {
      return await this.contentSafety.hasConsentForGeneration(generationId);
    } catch (error) {
      this.logger.error(
        `[SAFETY_GUARD] gen=${generationId}: falha ao ler o atestado de consentimento (${(error as Error).message}) — tratando como sem atestado`,
      );
      return false;
    }
  }

  /** Veredito do porteiro de imagem para as entradas da geração. Falha de leitura = sem checagem ('unavailable'). */
  private async preflightStatusFor(
    generationId: string,
    target: SafetyFallbackTarget,
  ): Promise<PreflightStatus> {
    try {
      return await this.contentSafety.preflightStatusForGeneration(
        generationId,
        target,
      );
    } catch (error) {
      this.logger.error(
        `[SAFETY_GUARD] gen=${generationId}: falha ao ler a checagem da imagem (${(error as Error).message}) — tratando como sem checagem`,
      );
      return 'unavailable';
    }
  }

  /**
   * Evento MINOR_BLOCKED de uma geração encerrada por recusa do provedor por menor. Chamado UMA vez, por quem grava
   * o FAILED (handleFailure / markFailed do ilimitado), depois da trava de idempotência. Modelo = o que recusou
   * (MinorSafetyBlockError.model) ou o da geração; trecho = o prompt original (antes da reescrita automática).
   * O site avisa que pedidos assim ficam registrados. Nunca lança. Público: o UnlimitedProcessor usa no markFailed.
   */
  async recordProviderMinorBlock(
    generationId: string,
    userId: string,
    error: Error,
  ): Promise<void> {
    let model =
      error instanceof MinorSafetyBlockError && error.model ? error.model : '';
    let prompt: string | null = null;
    try {
      const generation = await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: { modelUsed: true, prompt: true, parameters: true },
      });
      if (!model && generation?.modelUsed) model = generation.modelUsed;
      const params =
        generation?.parameters && typeof generation.parameters === 'object'
          ? (generation.parameters as Record<string, unknown>)
          : {};
      prompt =
        typeof params.originalPrompt === 'string'
          ? params.originalPrompt
          : (generation?.prompt ?? null);
    } catch (lookupError) {
      this.logger.warn(
        `[SAFETY_GUARD] gen=${generationId}: geração não lida para o registro (${(lookupError as Error).message})`,
      );
    }
    // recusa do provedor = `provider:<modelo>` + código de criança; reescrita acusada pela trava = `refiner:<modelo>`
    const audit = minorBlockAuditOf(error);
    await this.recordMinorBlock({
      userId,
      generationId,
      source: audit.source,
      model: model || 'desconhecido',
      match: audit.match,
      excerpt: prompt,
    });
  }

  /** Evento MINOR_BLOCKED na trilha de auditoria. Nunca lança: o registro não pode travar a falha nem o estorno. */
  private async recordMinorBlock(event: {
    userId: string;
    generationId: string;
    source: 'provider' | 'refiner';
    model: string;
    match: string;
    excerpt: string | null;
  }): Promise<void> {
    try {
      await this.contentSafety.record({
        userId: event.userId,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        route: `${event.source}:${event.model}`,
        match: event.match,
        excerpt: event.excerpt,
        generationId: event.generationId,
      });
    } catch (recordError) {
      this.logger.error(
        `[SAFETY_GUARD] gen=${event.generationId}: MINOR_BLOCKED não registrado (${(recordError as Error).message})`,
      );
    }
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
      `[FALLBACK_SEEDREAM_SAFETY] ${context} gen=${generationId} originalError="${providerMessageForLog(originalError, [prompt])}"`,
    );

    // Skip if CRON already finalized this generation
    const preCheck = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (
      preCheck?.status === GenerationStatus.FAILED ||
      preCheck?.status === GenerationStatus.COMPLETED ||
      preCheck?.status === GenerationStatus.IN_REVIEW
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
    const imageUrls = await this.freshInputUrls(
      generationId,
      inputImages.map((img) => img.url),
    );

    let result: { outputUrls: string[]; modelUsed: string };
    try {
      result = await this.seedreamProvider.generateImage({
        id: generationId,
        prompt,
        resolution: Resolution.RES_2K,
        aspectRatio,
        imageUrls: imageUrls.length ? imageUrls : undefined,
        // Fallback também sem censura — não aplica o wrapper que força roupa.
        skipSafetyWrapper: true,
      });
    } catch (fallbackError) {
      if (isTerminalSafetyBlock(fallbackError)) throw fallbackError;
      // O motivo que o usuário precisa ver é o bloqueio original, não o erro do
      // Unlocked — senão a falha aparece como "erro do provedor".
      this.logger.error(
        `[FALLBACK_SEEDREAM_SAFETY] ${context} gen=${generationId} Unlocked também falhou: ${providerMessageForLog(fallbackError, [prompt])}`,
      );
      // Se o próprio Unlocked recusou por menor, esse é o motivo: bloqueio terminal (CONTENT_POLICY_MINOR, sem nova
      // tentativa do BullMQ), registrado como provider:sem-censura.
      if (
        isMinorSafetyBlock(fallbackError) &&
        this.isSafetyRelatedError(fallbackError)
      ) {
        throw new MinorSafetyBlockError(fallbackError, 'sem-censura');
      }
      throw originalError instanceof ContentSafetyError
        ? originalError
        : new ContentSafetyError((originalError as Error).message);
    }

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
        `Prompt refinement failed for ${generationId}: ${providerMessageForLog(refineError, [originalPrompt])}`,
      );
      return null;
    }

    if (!refinedPrompt) {
      this.logger.warn(
        `Prompt refinement returned null for ${generationId} — content is unrefinable`,
      );
      return null;
    }

    // A reescrita passa pela trava de texto ANTES de ser gravada e de ir ao provedor; acusada = bloqueio terminal.
    // Só vira menor (MINOR_BLOCKED) se o pedido original também for acusado: o termo da reescrita é do refinador.
    const refinerBlock = refinedPromptBlockOf(refinedPrompt, originalPrompt);
    if (refinerBlock) {
      const source =
        refinerBlock instanceof UnverifiedContentBlockError
          ? refinerBlock.source
          : 'refiner_minor';
      this.logger.warn(
        `[SAFETY_GUARD] gen=${generationId}: prompt reescrito barrado pela trava de texto (${refinerBlock.failureCode}, ${source}, termo=${refinerBlock.guardMatch ?? '-'}, refined ${textFingerprintForLog(refinedPrompt)}) — encerrada sem nova tentativa`,
      );
      throw refinerBlock;
    }
    // leitor de sentido do texto sobre a reescrita (camada 2): acusada e agindo = REFINER_BLOCKED, terminal, sem
    // gravar o prompt reescrito; com o texto off não chama ninguém
    const classifierBlock = await this.imageSafety?.checkRefinedPrompt(
      generationId,
      refinedPrompt,
      '',
    );
    if (classifierBlock) throw classifierBlock;

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

    // nunca o texto do pedido no log: só tamanho e sha256
    this.logger.log(
      `Retrying generation ${generationId} with refined prompt — original ${textFingerprintForLog(originalPrompt)} → refined ${textFingerprintForLog(refinedPrompt)}`,
    );

    try {
      return await generateFn(refinedPrompt);
    } catch (retryError) {
      if (isTerminalSafetyBlock(retryError)) throw retryError;
      this.logger.error(
        `Retry with refined prompt also failed for ${generationId}: ${providerMessageForLog(retryError, [originalPrompt, refinedPrompt])}`,
      );
      if (this.isSafetyRelatedError(retryError)) {
        // Recusa por menor sai como veio: reembalada viraria CONTENT_SAFETY_BLOCKED e o site sugeriria modelo sem
        // censura. O process() a encerra como bloqueio terminal (sem nova tentativa do BullMQ).
        if (isMinorSafetyBlock(retryError)) throw retryError;
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
    // Idempotency: skip if already completed/failed (ou segurada pela checagem de segurança)
    const current = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (
      current?.status === GenerationStatus.COMPLETED ||
      current?.status === GenerationStatus.FAILED ||
      current?.status === GenerationStatus.IN_REVIEW
    ) {
      this.logger.warn(
        `Generation ${generationId} already ${current.status}, skipping completeGeneration`,
      );
      return;
    }

    const processingTimeMs = Date.now() - startTime;
    // checagem do resultado ANTES das miniaturas e da transação. Não lança por veredito (roda dentro do try de cada
    // provedor, onde qualquer erro vira desvio): segurado = IN_REVIEW; barrado = encerrado aqui com estorno
    const released = await this.screenOutputs(
      generationId,
      result,
      processingTimeMs,
      provider,
    );
    if (!released) return;
    await this.finishCompletion(
      generationId,
      released,
      processingTimeMs,
      provider,
    );
  }

  /**
   * Checagem de segurança do resultado (ImageSafetyService.checkOutput): devolve o resultado com as URLs públicas
   * (promovidas da quarentena) ou null quando ele foi segurado (IN_REVIEW) ou barrado (já encerrado aqui, com
   * estorno). Sem o serviço, o resultado segue como veio.
   */
  private async screenOutputs(
    generationId: string,
    result: { outputUrls: string[]; modelUsed: string },
    processingTimeMs: number,
    provider?: string,
  ): Promise<{ outputUrls: string[]; modelUsed: string } | null> {
    if (!this.imageSafety) return result;
    const outcome = await this.imageSafety.checkOutput(
      generationId,
      result.outputUrls,
      {
        modelUsed: result.modelUsed,
        provider: provider ?? null,
        processingTimeMs,
      },
    );
    if (outcome.action === 'promote') {
      return { ...result, outputUrls: outcome.outputs };
    }
    if (outcome.action === 'blocked') {
      await this.failForSafety(generationId, outcome.error, 'processing');
    }
    return null;
  }

  /**
   * Conclui uma geração segurada (IN_REVIEW) cujo resultado foi liberado depois (cron da quarentena ou revisor), com as
   * URLs já promovidas. Só uma conclusão vence (trava IN_REVIEW → PROCESSING). Público: o cron da quarentena usa.
   * A troca grava safetyCheckedAt agora: a geração segurada há horas não pode cair no cron de presas (que conta dali)
   * enquanto conclui, senão sairia concluída E estornada.
   */
  async completeHeldGeneration(
    generationId: string,
    outputUrls: string[],
    completion: OutputCompletion,
  ): Promise<boolean> {
    const { count } = await this.prisma.generation.updateMany({
      where: { id: generationId, status: GenerationStatus.IN_REVIEW },
      data: {
        status: GenerationStatus.PROCESSING,
        safetyCheckedAt: new Date(),
      },
    });
    if (count === 0) return false;
    await this.finishCompletion(
      generationId,
      { outputUrls, modelUsed: completion.modelUsed },
      completion.processingTimeMs,
      completion.provider ?? undefined,
    );
    return true;
  }

  /**
   * Encerra pelo caminho do bloqueio terminal (estorno, SSE, limpeza das entradas) uma geração barrada pela checagem
   * da saída ou segurada que venceu no cron. Nunca lança. Público: o cron da quarentena usa.
   *  - `held` (padrão, o cron): só encerra quem ganhar a troca IN_REVIEW → PROCESSING; outra réplica ou o revisor que
   *    chegou antes já encerrou. A troca grava safetyCheckedAt agora, para o cron de presas não estornar junto;
   *  - `processing` (o próprio job, resultado barrado na checagem): a geração está PROCESSING, sem troca.
   */
  async failForSafety(
    generationId: string,
    error: TerminalSafetyBlockError,
    from: 'held' | 'processing' = 'held',
  ): Promise<void> {
    try {
      if (from === 'held') {
        // segurada: volta a PROCESSING só para o encerramento (handleFailure não mexe em IN_REVIEW)
        const { count } = await this.prisma.generation.updateMany({
          where: { id: generationId, status: GenerationStatus.IN_REVIEW },
          data: {
            status: GenerationStatus.PROCESSING,
            safetyCheckedAt: new Date(),
          },
        });
        if (count === 0) {
          this.logger.warn(
            `[IMAGE_SAFETY] gen=${generationId}: já não estava segurada — encerramento feito por outro caminho`,
          );
          return;
        }
      }
      const generation = await this.prisma.generation.findUnique({
        where: { id: generationId },
        select: {
          userId: true,
          creditsConsumed: true,
          usedFreeGeneration: true,
        },
      });
      if (!generation) return;
      await this.finalizeTerminalBlock(
        {
          generationId,
          userId: generation.userId,
          creditsConsumed: generation.creditsConsumed,
          usedFreeGeneration: generation.usedFreeGeneration,
        },
        error,
      );
    } catch (failError) {
      this.logger.error(
        `[IMAGE_SAFETY] gen=${generationId}: encerramento do bloqueio falhou (${(failError as Error).message}) — conferir no admin`,
      );
    }
  }

  /** O que vem depois da checagem: miniaturas, saídas, prazo da galeria, SSE e limpeza das entradas. */
  private async finishCompletion(
    generationId: string,
    result: { outputUrls: string[]; modelUsed: string },
    processingTimeMs: number,
    provider?: string,
  ): Promise<void> {
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
        user: { select: { isActive: true } },
      },
    });

    // Calculate expiresAt based on user's plan retention
    // Conta inativa (guarda legal, exclusão, bloqueio) não ganha prazo: a guarda tira o prazo de todas as gerações da
    // conta para o cron da galeria não apagar evidência, e a geração que termina depois dela não pode trazer o prazo
    // de volta. O prazo só é gravado com a conta ativa NA escrita (updateMany abaixo), não só na leitura daqui.
    let expiresAt: Date | null = null;
    if (generation && generation.user?.isActive !== false) {
      const retentionDays = await this.getUserRetentionDays(generation.userId);
      if (retentionDays !== null) {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + retentionDays);
      }
    } else if (generation) {
      this.logger.warn(
        `Generation ${generationId}: owner account inactive — completed without gallery expiry (legal hold protection)`,
      );
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

    const completion = this.prisma.generation.update({
      where: { id: generationId },
      data: updateData,
    });
    const outputs = this.prisma.generationOutput.createMany({
      data: result.outputUrls.map((url, i) => ({
        generationId,
        url,
        thumbnailUrl: thumbnailUrls[i],
        blurDataUrl: blurDataUrls[i],
        order: i,
      })),
    });
    // o prazo vai por último na transação, com a conta conferida de novo na escrita (a guarda pode ter desativado a
    // conta durante as miniaturas): conta inativa fica sem prazo (count 0)
    const [updatedGeneration] = expiresAt
      ? await this.prisma.$transaction([
          completion,
          outputs,
          this.prisma.generation.updateMany({
            where: { id: generationId, user: { isActive: true } },
            data: { expiresAt },
          }),
        ])
      : await this.prisma.$transaction([completion, outputs]);

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
      `Job ${job.id} [${job.name}] failed (attempt ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${providerMessageForLog(error, requestTextsOfJob(job.data))}`,
    );

    // Only refund after all retries are exhausted
    if (willBeRetried(job)) {
      this.logger.warn(`Job ${job.id} will be retried`);
      return;
    }

    try {
      await this.handleFailure(
        job.data.generationId,
        job.data.userId,
        job.data.creditsConsumed,
        error,
        job.data.usedFreeGeneration,
        requestTextsOfJob(job.data),
      );
    } catch (finalizeError) {
      // sem isso a geração ficava PROCESSING até o cron de presas (o job já não volta para a fila)
      this.logger.error(
        `Job ${job.id}: encerramento da geração ${job.data.generationId} falhou (${(finalizeError as Error).message}) — conferir o estorno no admin`,
      );
      await this.failStuckGeneration(
        job.data.generationId,
        job.data.userId,
        error,
      );
    }
  }

  /** `requestTexts`: textos do pedido (requestTextsOfJob) que saem da mensagem do provedor no log. */
  private async handleFailure(
    generationId: string,
    userId: string,
    creditsConsumed: number,
    error: Error,
    usedFreeGeneration?: boolean,
    requestTexts: ReadonlyArray<string> = [],
  ): Promise<void> {
    // Idempotency: skip if already completed/failed (segurada pela checagem só sai pelo cron ou pelo revisor)
    const current = await this.prisma.generation.findUnique({
      where: { id: generationId },
      select: { status: true },
    });
    if (
      current?.status === GenerationStatus.COMPLETED ||
      current?.status === GenerationStatus.FAILED ||
      current?.status === GenerationStatus.IN_REVIEW
    ) {
      this.logger.warn(
        `Generation ${generationId} already ${current.status}, skipping handleFailure`,
      );
      return;
    }

    const isSafetyError = this.isSafetyRelatedError(error);
    // classifica a mensagem CRUA do provedor num código estável — é ele que o
    // front usa pra dizer ao usuário o motivo real da falha. O código que a
    // guarda de segurança decidiu (menor, foto sem atestado) vem pronto no erro.
    const errorCode = failureCodeOf(error, isSafetyError);
    const isMinorBlock =
      errorCode === GenerationFailureCode.CONTENT_POLICY_MINOR;

    const userMessage = failureUserMessage(errorCode, error);

    // sem a mensagem crua (pode repetir o prompt ou trazer URL assinada) nem a 1ª linha da pilha, que a repete
    this.logger.error(
      `Generation ${generationId} failed (${errorCode}): ${providerMessageForLog(error, requestTexts)}`,
      stackFramesForLog(error),
    );

    // a troca para FAILED é a trava: duas chamadas ao mesmo tempo (duas suspensões varrendo a fila, o preflight e a
    // suspensão) passam pela leitura acima, mas só uma acha a geração aberta; a outra (P2025) não estorna nem avisa
    try {
      await this.prisma.generation.update({
        where: {
          id: generationId,
          status: {
            notIn: [
              GenerationStatus.COMPLETED,
              GenerationStatus.FAILED,
              GenerationStatus.IN_REVIEW,
            ],
          },
        },
        data: {
          status: GenerationStatus.FAILED,
          errorMessage: userMessage,
          errorCode,
        },
      });
    } catch (claimError) {
      if (
        claimError instanceof Prisma.PrismaClientKnownRequestError &&
        claimError.code === 'P2025'
      ) {
        this.logger.warn(
          `Generation ${generationId} encerrada por outro caminho no meio do encerramento, skipping handleFailure`,
        );
        return;
      }
      throw claimError;
    }

    // MINOR_BLOCKED uma vez por geração: só aqui, depois da trava de idempotência acima
    if (isMinorBlock) {
      await this.recordProviderMinorBlock(generationId, userId, error);
    }

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

    // recusa por menor: a foto enviada é a evidência do caso (fica no bucket e na tabela, para a equipe e as
    // autoridades); bloqueio da checagem cuja evidência não foi guardada também (storage fora): a limpeza apagaria a
    // prova. Nas outras falhas, apaga os arquivos de entrada para economizar armazenamento
    if (isMinorBlock) {
      this.logger.warn(`Generation ${generationId}: entradas mantidas como evidência (recusa por menor de idade)`);
      return;
    }
    if (keepsInputsOnFailure(error)) {
      this.logger.error(
        `Generation ${generationId}: evidência pendente — entradas e resultado mantidos (conferir e mover para a evidência)`,
      );
      return;
    }
    // Fire-and-forget: delete input files from S3 to save storage
    this.cleanupInputFiles(generationId);
    // sobra do resultado na quarentena (upload parcial, hold que não foi gravado); com o modo off não faz nada
    this.imageSafety?.discardFailedOutputs(generationId).catch((err) =>
      this.logger.warn(
        `Failed to discard quarantined outputs for ${generationId}: ${(err as Error).message}`,
      ),
    );
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
          base64: await this.downloadToBase64(img.url!, generationId),
          mimeType: img.mimeType ?? 'image/png',
        })),
    );
  }

  /** Baixa uma entrada da geração, reassinando antes a URL gravada (a assinada no upload pode ter vencido). */
  private async downloadToBase64(
    url: string,
    generationId: string,
  ): Promise<string> {
    const response = await fetch(await this.freshInputUrl(generationId, url));
    if (!response.ok) {
      throw new Error(`Failed to download from S3: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.toString('base64');
  }

  /**
   * URLs das entradas guardadas da geração, reassinadas na hora do envio (refreshInputReadUrl): a assinada no upload
   * vence na fila, na nova tentativa do BullMQ ou no desvio. Vazias saem; a ordem fica.
   */
  private async freshInputUrls(
    generationId: string,
    urls: ReadonlyArray<string | null | undefined>,
  ): Promise<string[]> {
    return Promise.all(
      urls
        .filter((url): url is string => !!url)
        .map((url) => this.freshInputUrl(generationId, url)),
    );
  }

  /** Uma entrada reassinada; se a assinatura falhar, segue a URL gravada (pode ainda valer) e avisa no log. */
  private async freshInputUrl(
    generationId: string,
    url: string,
  ): Promise<string> {
    try {
      return await this.uploadsService.refreshInputReadUrl(url, generationId);
    } catch (error) {
      this.logger.warn(
        `gen=${generationId}: entrada ${mediaUrlForLog(url)} não reassinada (${(error as Error).message}) — segue a URL gravada`,
      );
      return url;
    }
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
