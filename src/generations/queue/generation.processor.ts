import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { PlansService } from '../../plans/plans.service';
import {
  evaluateFallback,
  FallbackBlockReason,
  FallbackKind,
  fallbackKindOf,
  FallbackPlan,
  planFallback,
} from './generation-fallback';
import {
  GenerationUnrecoverableError,
  isUnrecoverableJobError,
  unwrapJobError,
} from './unrecoverable.error';
import { ContentSafetyError } from '../errors/content-safety.error';
import {
  classifyGenerationFailure,
  GenerationFailureCode,
  rawFailureText,
} from '../errors/failure-reason';
import { isMinorRefusal } from '../errors/minor-refusal';

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
  WavespeedImageToVideoJobData,
  WavespeedSeedanceImageToVideoJobData,
  MinimaxH3TextToVideoJobData,
  MinimaxH3ImageToVideoJobData,
  MinimaxH3ReferenceToVideoJobData,
  TextToSpeechJobData,
  VoiceCloneJobData,
  GenerationJobData,
} from './generation-queue.constants';

/**
 * Prompt de undress usado pelo modelo `deepdeep`, que agora roda no Seedream
 * (WaveSpeed, image-to-image) em vez da API n8ked/deepnude. Passa cru pro
 * provider com `skipSafetyWrapper` — sem o wrapper que força roupa no personagem.
 */
const UNDRESS_PROMPT =
  'remove all visible clothing from the subject in the image, keeping natural body proportions and anatomy, tits, vagina, ass, etc.';

/**
 * Prompt de face swap usado quando o modo Unlocked (NSFW) está ligado, rodando
 * pelo Seedream (WaveSpeed, image-to-image) com `skipSafetyWrapper`. Também é
 * reaproveitado como fallback de segurança do face swap padrão (nano-banana-2).
 */
const FACE_SWAP_SEEDREAM_PROMPT =
  'Recreate the scene in Image 2 (clothing, body pose, and setting) replacing the person with the woman in Image 1. Preserve facial features, skin tone and body proportions from Image 1 with photorealistic lighting and shadows.';

/** `minor_refusal` = a alternativa recusou por menor: sem retry do original. */
type FallbackOutcome = 'completed' | 'failed' | 'none' | 'minor_refusal';

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
    private readonly plansService: PlansService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(
      `Processing job ${job.id} [${job.name}] for generation ${job.data.generationId}`,
    );

    await this.dispatchWithFallback(job.name, job.data as GenerationJobData, {
      queued: true,
    });
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

  // ─── Fallback automático de modelo ─────────────────────────
  // Plano em ./generation-fallback.ts. Liga/desliga por env:
  //   GENERATION_FALLBACK_ENABLED (padrão true) — falha técnica do provedor
  //   GENERATION_SAFETY_FALLBACK_ENABLED (padrão true) — bloqueio de conteúdo em vídeo
  //     (inclui entrada recusada pelo provedor, tratada como segurança)
  //   GENERATION_FALLBACK_UNCENSORED_WITH_MEDIA (padrão false) — desvio para
  //     modelo sem censura em geração com mídia do usuário, por qualquer motivo.
  //     Vira "só com preflight limpo" quando a PR #4 e o porteiro da foto entrarem.
  // Recusa por menor (isMinorRefusal) não tem chave: nunca desvia nem volta à fila.

  /** Depois disso a geração está perto da janela do cron: não vale começar outra chamada. */
  private static readonly FALLBACK_DEADLINE_MS = 20 * 60 * 1000;

  /** Erros que não mudam 30 s depois: sem retry cego do BullMQ (TKT-107). */
  private static readonly NO_RETRY_CODES = new Set<string>([
    GenerationFailureCode.CONTENT_SAFETY_BLOCKED,
    GenerationFailureCode.INPUT_IMAGE_REJECTED,
    GenerationFailureCode.NO_SUBJECT_DETECTED,
    GenerationFailureCode.VIDEO_DURATION_UNSUPPORTED,
    GenerationFailureCode.VIDEO_INPUT_DURATION_INVALID,
    GenerationFailureCode.VIDEO_INPUT_RESOLUTION_LOW,
    GenerationFailureCode.REFERENCE_MIX_UNSUPPORTED,
    GenerationFailureCode.REFERENCE_ELEMENT_MISSING,
    GenerationFailureCode.FILE_TOO_LARGE,
    GenerationFailureCode.PROMPT_TOO_LONG,
    GenerationFailureCode.PROVIDER_QUOTA_EXCEEDED,
  ]);

  /**
   * Roda o job e, se o provedor falhar, tenta UMA vez num modelo alternativo.
   * Sucesso no alternativo = geração COMPLETED com o preço reconciliado para o
   * que rodou de fato. Falha nos dois = o erro ORIGINAL sobe (é o motivo que o
   * usuário precisa ver) e o BullMQ não repete: a alternativa já foi tentada.
   * Usado pela fila normal, pela fila ilimitada e pelos runners diretos.
   */
  async dispatchWithFallback(
    jobName: string,
    data: GenerationJobData,
    opts: { queued: boolean },
  ): Promise<void> {
    // Retry do BullMQ, job duplicado ou geração já finalizada pelo cron: não
    // chama o provedor de novo para algo que ninguém vai usar (TKT-107).
    const current = await this.prisma.generation.findUnique({
      where: { id: data.generationId },
      select: { status: true },
    });
    if (!current || current.status !== GenerationStatus.PROCESSING) {
      this.logger.warn(
        `Generation ${data.generationId} está ${current?.status ?? 'inexistente'} — job ${jobName} ignorado sem chamar o provedor`,
      );
      return;
    }

    try {
      await this.dispatch(jobName, data);
      return;
    } catch (error) {
      const original = error as Error;
      // Recusa por MENOR encerra aqui, ANTES do kind: sem desvio nenhum (nem
      // para modelo com filtro) e sem retry. Sem isso, pedido só com texto ia
      // ao MiniMax (sem filtro) com o mesmo prompt que o provedor recusou.
      // Merge com a PR #4: trocar a condição por
      // `isTerminalSafetyBlock(unwrapJobError(original)) || isMinorSafetyBlock(original)`
      // e manter o curto-circuito antes do kind (o desvio nunca desfaz bloqueio terminal).
      if (isMinorRefusal(unwrapJobError(original))) {
        this.logger.warn(
          `[FALLBACK] gen=${data.generationId} ${jobName}: recusa por menor — sem desvio nem retry`,
        );
        await this.recordMinorRefusal(jobName, data, original);
        if (!opts.queued) throw original;
        throw new GenerationUnrecoverableError(original);
      }
      const safety =
        fallbackKindOf(
          rawFailureText(original),
          this.isSafetyRelatedError(original),
        ) === 'safety';
      let outcome: FallbackOutcome = 'none';
      try {
        outcome = await this.tryFallback(jobName, data, original, safety);
      } catch (orchestrationError) {
        // Falha da orquestração (banco, plano) nunca troca o motivo real da falha.
        this.logger.error(
          `[FALLBACK] gen=${data.generationId} orquestração falhou: ${(orchestrationError as Error).message}`,
        );
      }
      if (outcome === 'completed') return;
      if (!opts.queued) throw original;
      // Bloqueio e erro determinístico não mudam em 30 s: sem retry. Falha
      // passageira mantém o retry do BullMQ, só do modelo original — a
      // alternativa roda no máximo uma vez por geração (fallbackAttempt).
      // Recusa por menor na alternativa também: o retry reenviaria o pedido.
      if (
        outcome === 'minor_refusal' ||
        safety ||
        this.isDeterministicFailure(original)
      ) {
        throw new GenerationUnrecoverableError(original);
      }
      throw original;
    }
  }

  /**
   * Marca a recusa por menor em `parameters.fallbackBlocked`, no formato da
   * guarda de mídia, para a métrica. Log e registro sem prompt nem texto do
   * provedor. Nunca lança: o registro não troca o motivo da falha.
   */
  private async recordMinorRefusal(
    jobName: string,
    data: GenerationJobData,
    originalError: Error,
  ): Promise<void> {
    try {
      const generation = await this.prisma.generation.findUnique({
        where: { id: data.generationId },
        select: {
          modelUsed: true,
          type: true,
          durationSeconds: true,
          aspectRatio: true,
          parameters: true,
        },
      });
      if (!generation) return;
      const params =
        generation.parameters && typeof generation.parameters === 'object'
          ? (generation.parameters as Record<string, unknown>)
          : {};
      // Só para a métrica: o desvio que a guarda barrou, no mesmo cálculo do
      // caminho normal (sem a guarda de mídia; imagem com foto sai sem alvo,
      // as URLs ficam no banco). Nada roda. Régua do isSafetyRelatedError sem
      // o log dele, que grava o texto do provedor.
      const safetyError =
        originalError instanceof ContentSafetyError ||
        originalError.message.includes('no video data returned') ||
        ContentSafetyError.fromErrorMessage(originalError.message) !== null;
      const kind = fallbackKindOf(rawFailureText(originalError), safetyError);
      const wouldBe = planFallback(jobName, data, {
        kind,
        originalModel: generation.modelUsed,
        generationType: generation.type,
        durationSeconds: generation.durationSeconds,
        aspectRatio: generation.aspectRatio,
        allowUncensoredWithMedia: true,
      });
      const reason: FallbackBlockReason = 'MINOR_REFUSAL';
      await this.prisma.generation.update({
        where: { id: data.generationId },
        data: {
          parameters: {
            ...params,
            fallbackBlocked: {
              from: generation.modelUsed,
              to: wouldBe?.model ?? null,
              kind,
              reason,
              errorCode: classifyGenerationFailure(
                rawFailureText(originalError),
                kind === 'safety',
              ),
            },
          },
        },
      });
    } catch (auditError) {
      // Só o código: a mensagem do Prisma pode trazer os parâmetros (e o prompt).
      const code = (auditError as { code?: unknown } | null)?.code;
      this.logger.warn(
        `[FALLBACK] gen=${data.generationId} registro da recusa por menor falhou (${typeof code === 'string' ? code : 'sem código'})`,
      );
    }
  }

  private isDeterministicFailure(error: Error): boolean {
    const code = classifyGenerationFailure(rawFailureText(error), false);
    return GenerationProcessor.NO_RETRY_CODES.has(code);
  }

  private fallbackEnabled(kind: FallbackKind): boolean {
    const key =
      kind === 'safety'
        ? 'GENERATION_SAFETY_FALLBACK_ENABLED'
        : 'GENERATION_FALLBACK_ENABLED';
    return this.configService.get<string>(key, 'true') !== 'false';
  }

  /** Só "true" explícito libera; ausente ou qualquer outro valor mantém a guarda. */
  private uncensoredWithMediaAllowed(): boolean {
    return (
      this.configService
        .get<string>('GENERATION_FALLBACK_UNCENSORED_WITH_MEDIA', 'false')
        ?.trim()
        .toLowerCase() === 'true'
    );
  }

  private async tryFallback(
    jobName: string,
    data: GenerationJobData,
    originalError: Error,
    safety: boolean,
  ): Promise<FallbackOutcome> {
    const kind: FallbackKind = safety ? 'safety' : 'provider';
    if (!this.fallbackEnabled(kind)) return 'none';

    const generation = await this.prisma.generation.findUnique({
      where: { id: data.generationId },
      select: {
        id: true,
        userId: true,
        status: true,
        type: true,
        modelUsed: true,
        durationSeconds: true,
        aspectRatio: true,
        createdAt: true,
        creditsConsumed: true,
        usedFreeGeneration: true,
        parameters: true,
      },
    });
    if (!generation || generation.status !== GenerationStatus.PROCESSING) {
      return 'none';
    }
    const params =
      generation.parameters && typeof generation.parameters === 'object'
        ? (generation.parameters as Record<string, unknown>)
        : {};
    // Uma alternativa por geração: se já tentou (deu certo ou não), não tenta de
    // novo — nem fallback de fallback, nem de novo no retry do BullMQ.
    if (params.fallbackFrom || params.fallbackAttempt) return 'none';
    if (
      Date.now() - generation.createdAt.getTime() >
      GenerationProcessor.FALLBACK_DEADLINE_MS
    ) {
      this.logger.warn(
        `[FALLBACK] gen=${generation.id} perto da janela do cron — sem alternativa`,
      );
      return 'none';
    }

    let inputImageUrls: string[] | undefined;
    if (
      (jobName === GenerationJobName.IMAGE ||
        jobName === GenerationJobName.IMAGE_WITH_FALLBACK) &&
      (data as ImageJobData).hasInputImages
    ) {
      const inputImages = await this.prisma.generationInputImage.findMany({
        where: { generationId: data.generationId },
        orderBy: { order: 'asc' },
      });
      inputImageUrls = inputImages
        .map((img) => img.url)
        .filter((url): url is string => !!url);
    }

    const decision = evaluateFallback(jobName, data, {
      kind,
      originalModel: generation.modelUsed,
      generationType: generation.type,
      durationSeconds: generation.durationSeconds,
      aspectRatio: generation.aspectRatio,
      inputImageUrls,
      allowUncensoredWithMedia: this.uncensoredWithMediaAllowed(),
    });
    const errorCode = classifyGenerationFailure(
      rawFailureText(originalError),
      safety,
    );
    if (decision.blocked) {
      // Sem prompt nem mensagem do provedor no log: só ids e códigos.
      this.logger.warn(
        `[FALLBACK] gen=${generation.id} ${generation.modelUsed} → ${decision.blocked.model} barrado (${kind}: ${errorCode}): ${decision.blocked.reason}`,
      );
      await this.prisma.generation
        .update({
          where: { id: generation.id },
          data: {
            parameters: {
              ...params,
              fallbackBlocked: {
                from: generation.modelUsed,
                to: decision.blocked.model,
                kind,
                reason: decision.blocked.reason,
                errorCode,
              },
            },
          },
        })
        .catch((auditError: Error) =>
          this.logger.warn(
            `[FALLBACK] gen=${generation.id} registro do bloqueio falhou: ${auditError.message}`,
          ),
        );
      return 'none';
    }
    const plan = decision.plan;
    if (!plan) return 'none';

    this.logger.warn(
      `[FALLBACK] gen=${generation.id} ${generation.modelUsed} → ${plan.model} (${kind}: ${errorCode}) motivo="${originalError.message}"`,
    );

    const attempt = {
      from: generation.modelUsed,
      to: plan.model,
      kind,
      reason: errorCode,
      originalError: originalError.message.slice(0, 300),
    };
    await this.prisma.generation.update({
      where: { id: generation.id },
      data: { parameters: { ...params, fallbackAttempt: attempt } },
    });

    try {
      await this.dispatch(plan.jobName, plan.data);
    } catch (fallbackError) {
      // A alternativa recusou por menor: o pedido não roda de novo em lugar
      // nenhum, nem no retry do modelo original (que pode ser sem filtro).
      const minorRefusal = isMinorRefusal(fallbackError);
      const failedMessage = String(
        (fallbackError as Error | null)?.message ?? fallbackError,
      );
      this.logger.error(
        `[FALLBACK] gen=${generation.id} alternativa ${plan.model} também falhou: ${minorRefusal ? 'recusa por menor' : failedMessage}`,
      );
      await this.prisma.generation
        .update({
          where: { id: generation.id },
          data: {
            parameters: {
              ...params,
              fallbackAttempt: {
                ...attempt,
                failed: failedMessage.slice(0, 300),
                ...(minorRefusal ? { minorRefusal: true } : {}),
              },
            },
          },
        })
        .catch(() => undefined);
      return minorRefusal ? 'minor_refusal' : 'failed';
    }

    // A alternativa entregou. Daqui para frente nada pode derrubar o job: um
    // erro aqui viraria retry e o provedor original rodaria de novo.
    try {
      const finished = await this.prisma.generation.findUnique({
        where: { id: generation.id },
        select: { status: true, parameters: true },
      });
      if (finished?.status !== GenerationStatus.COMPLETED) {
        // O cron finalizou (e estornou) enquanto a alternativa rodava.
        this.logger.warn(
          `[FALLBACK] gen=${generation.id} terminou como ${finished?.status ?? 'inexistente'} — sem reconciliação de créditos`,
        );
        return 'completed';
      }
      const finishedParams =
        finished.parameters && typeof finished.parameters === 'object'
          ? { ...(finished.parameters as Record<string, unknown>) }
          : {};
      delete finishedParams.fallbackAttempt;
      await this.prisma.generation.update({
        where: { id: generation.id },
        data: {
          parameters: {
            ...finishedParams,
            fallbackFrom: attempt.from,
            fallbackTo: attempt.to,
            fallbackKind: kind,
            fallbackReason: errorCode,
            fallbackOriginalError: attempt.originalError,
          },
        },
      });
      await this.settleFallbackCharge(
        {
          id: generation.id,
          userId: generation.userId,
          creditsConsumed: generation.creditsConsumed,
          usedFreeGeneration: generation.usedFreeGeneration,
          unlimited: params.unlimited === true,
        },
        plan,
      );
    } catch (settleError) {
      this.logger.error(
        `[FALLBACK] gen=${generation.id} entregue pela alternativa, mas a reconciliação falhou: ${(settleError as Error).message}`,
      );
    }
    return 'completed';
  }

  /**
   * O cliente nunca paga mais do que foi cobrado: alternativa mais barata →
   * estorna a diferença e grava o preço real; mais cara → a plataforma absorve.
   */
  private async settleFallbackCharge(
    generation: {
      id: string;
      userId: string;
      creditsConsumed: number;
      usedFreeGeneration: boolean;
      unlimited: boolean;
    },
    plan: FallbackPlan,
  ): Promise<void> {
    if (
      generation.creditsConsumed <= 0 ||
      generation.usedFreeGeneration ||
      generation.unlimited
    ) {
      return;
    }

    let fallbackCredits: number;
    try {
      fallbackCredits = await this.plansService.calculateGenerationCost(
        plan.billing.type,
        plan.billing.resolution as Resolution,
        plan.billing.durationSeconds,
        plan.billing.hasAudio,
        1,
        plan.modelVariant,
        plan.billing.hasVideoInput,
      );
    } catch (error) {
      this.logger.warn(
        `[FALLBACK] gen=${generation.id} sem tabela de preço para ${plan.model}: cobrança original mantida (${(error as Error).message})`,
      );
      return;
    }

    const delta = generation.creditsConsumed - fallbackCredits;
    const current = await this.getExistingParameters(generation.id);
    if (delta > 0) {
      await this.creditsService.adjustGenerationCost(
        generation.userId,
        generation.id,
        delta,
        `Estorno parcial: gerado no modelo alternativo ${plan.model} (${fallbackCredits} créditos)`,
      );
      await this.prisma.generation.update({
        where: { id: generation.id },
        data: {
          creditsConsumed: fallbackCredits,
          parameters: {
            ...current,
            fallbackCreditsOriginal: generation.creditsConsumed,
            fallbackCreditsCharged: fallbackCredits,
            fallbackCreditsRefunded: delta,
          },
        },
      });
      this.logger.log(
        `[FALLBACK] gen=${generation.id} estornados ${delta} créditos (${generation.creditsConsumed} → ${fallbackCredits})`,
      );
      return;
    }
    if (delta < 0) {
      await this.prisma.generation.update({
        where: { id: generation.id },
        data: {
          parameters: {
            ...current,
            fallbackCreditsOriginal: generation.creditsConsumed,
            fallbackCreditsCharged: generation.creditsConsumed,
            fallbackCreditsAbsorbed: -delta,
          },
        },
      });
      this.logger.log(
        `[FALLBACK] gen=${generation.id} alternativa custa ${-delta} créditos a mais; plataforma absorve`,
      );
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
      await this.dispatchWithFallback(GenerationJobName.IMAGE, data, {
        queued: false,
      });
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
          family: data.model,
        });
        await this.completeGeneration(data.generationId, result, startTime);
      } catch (error) {
        if (this.isSafetyRelatedError(error)) {
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
      const imageUrls = inputImages
        .map((img) => img.url)
        .filter((url): url is string => !!url);

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
          family: data.model,
        });
        await this.completeGeneration(data.generationId, result, startTime);
      } catch (error) {
        if (this.isSafetyRelatedError(error)) {
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
      const imageUrls = inputImages
        .map((img) => img.url)
        .filter((url): url is string => !!url);

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
      imageUrls = inputImages
        .map((img) => img.url)
        .filter((url): url is string => !!url);
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
          error,
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
          error,
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
          error,
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
      `[FACE_SWAP] ${data.generationId} resolution=${data.resolution} nsfw=${data.nsfw ?? false} sourceImage=${data.sourceImageUrl} targetImage=${data.targetImageUrl}`,
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
          error,
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
          error,
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
          error,
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
      `[SEEDANCE_VIDEO] ${data.generationId} model=${data.modelId ?? 'bytedance/seedance-2'} resolution=${data.resolution} duration=${data.durationSeconds}s aspectRatio=${data.aspectRatio} refImages=${data.referenceImageUrls?.length ?? 0} refVideos=${data.referenceVideoUrls?.length ?? 0} refAudios=${data.referenceAudioUrls?.length ?? 0} firstFrame=${!!data.firstFrameUrl} lastFrame=${!!data.lastFrameUrl} audio=${data.generateAudio} prompt="${data.prompt}"`,
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
        const retryResult = await this.retryWithRefinedPrompt(
          data.generationId,
          data.prompt,
          (refined) => this.bytedanceSeedanceProvider.generateVideo(buildInput(refined)),
          error,
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
      generateAudio: data.generateAudio,
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
          error,
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

  // ─── WaveSpeed — LTX 2.3 Spicy (image-to-video, NSFW) ───────

  private async processWavespeedImageToVideo(
    data: WavespeedImageToVideoJobData,
  ): Promise<void> {
    const startTime = Date.now();
    await this.markProcessingStarted(data.generationId);

    this.logger.log(
      `[WAVESPEED_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s prompt="${data.prompt}"`,
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
      `[WAVESPEED_SEEDANCE_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s audio=${data.generateAudio} prompt="${data.prompt}"`,
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
      `[MINIMAX_H3_TEXT_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspect=${data.aspectRatio ?? '16:9'} prompt="${data.prompt}"`,
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
      `[MINIMAX_H3_IMAGE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s lastFrame=${data.lastImageUrl ? 'yes' : 'no'} prompt="${data.prompt}"`,
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
      `[MINIMAX_H3_REFERENCE_TO_VIDEO] ${data.generationId} resolution=${data.resolution} duration=${data.durationSeconds}s aspect=${data.aspectRatio ?? '16:9'} refImages=${data.referenceImageUrls?.length ?? 0} refVideos=${data.referenceVideoUrls?.length ?? 0} refAudios=${data.referenceAudioUrls?.length ?? 0} prompt="${data.prompt}"`,
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
      // O motivo que o usuário precisa ver é o bloqueio original, não o erro do
      // Unlocked — senão a falha aparece como "erro do provedor".
      this.logger.error(
        `[FALLBACK_SEEDREAM_SAFETY] ${context} gen=${generationId} Unlocked também falhou: ${(fallbackError as Error).message}`,
      );
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

  /**
   * `originalError` = a recusa do pedido original. Recusa por menor não se
   * reescreve (mesma regra da PR #4): volta null, o caller relança o erro
   * original e o dispatchWithFallback encerra sem desvio nem retry.
   */
  private async retryWithRefinedPrompt(
    generationId: string,
    originalPrompt: string,
    generateFn: (refinedPrompt: string) => Promise<{ outputUrls: string[]; modelUsed: string }>,
    originalError: unknown,
  ): Promise<{ outputUrls: string[]; modelUsed: string } | null> {
    if (isMinorRefusal(originalError)) {
      this.logger.warn(
        `Generation ${generationId} recusada por menor — sem reescrita do prompt`,
      );
      return null;
    }

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
      // Recusa por menor do prompt reescrito sobe como veio: embrulhada no
      // genérico abaixo, a marca sumia e o dispatchWithFallback levava o prompt
      // ORIGINAL ao modelo sem filtro. (PR #4 faz o mesmo com isMinorSafetyBlock.)
      if (isMinorRefusal(retryError)) throw retryError;
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

    // Only refund after all retries are exhausted. Erro irrecuperável (bloqueio,
    // entrada recusada, alternativa já tentada) não tem retry: finaliza agora.
    const unrecoverable = isUnrecoverableJobError(error);
    if (!unrecoverable && job.attemptsMade < (job.opts.attempts ?? 1)) {
      this.logger.warn(`Job ${job.id} will be retried`);
      return;
    }

    await this.handleFailure(
      job.data.generationId,
      job.data.userId,
      job.data.creditsConsumed,
      unwrapJobError(error),
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
    // classifica a mensagem CRUA do provedor num código estável — é ele que o
    // front usa pra dizer ao usuário o motivo real da falha
    const errorCode = classifyGenerationFailure(
      rawFailureText(error),
      isSafetyError,
    );
    const isContentBlock =
      errorCode === GenerationFailureCode.CONTENT_SAFETY_BLOCKED;

    const userMessage = isContentBlock
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

    // Sem assinatura: 7 dias. Plano com galeria ilimitada (null) não expira.
    if (!subscription) return 7;
    return subscription.plan.galleryRetentionDays;
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
