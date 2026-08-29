import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FreeGenerationType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isEligibleForOnboarding,
  ONBOARDING_STARTER_KIT,
  ONBOARDING_TOTAL_STEPS,
  recommendPlan,
  resolveFirstRun,
  resolveSegment,
  type OnboardingAnswers,
  type OnboardingContentMix,
  type OnboardingModelStatus,
  type OnboardingPlanSlug,
  type OnboardingPlatform,
  type OnboardingRole,
  type OnboardingSegment,
  type OnboardingWeeklyVolume,
} from './onboarding.constants';
import {
  CompleteOnboardingQuizDto,
  SaveOnboardingProgressDto,
} from './dto/onboarding-answers.dto';
import { OnboardingProfileResponseDto } from './dto/onboarding-profile-response.dto';

type ProfileRow = Prisma.UserOnboardingProfileGetPayload<object>;

const STARTER_KIT_ENTRIES = Object.entries(ONBOARDING_STARTER_KIT) as Array<
  [FreeGenerationType, number]
>;

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string): Promise<OnboardingProfileResponseDto> {
    const profile = await this.prisma.userOnboardingProfile.findUnique({
      where: { userId },
    });

    return this.toResponse(profile);
  }

  /**
   * Grava o progresso parcial a cada resposta. É a fonte do funil por pergunta:
   * sem isso só dá para saber quem terminou, não onde os outros desistiram.
   */
  async saveProgress(
    userId: string,
    dto: SaveOnboardingProgressDto,
  ): Promise<OnboardingProfileResponseDto> {
    await this.assertEligible(userId);

    const { step, ...answers } = dto;
    const data = this.stripUndefined(answers);

    const existing = await this.prisma.userOnboardingProfile.findUnique({
      where: { userId },
      select: { lastStepReached: true },
    });

    // lastStepReached nunca anda para trás — voltar uma pergunta não pode
    // apagar o registro de que o usuário já tinha chegado adiante.
    const lastStepReached = Math.max(step ?? 0, existing?.lastStepReached ?? 0);

    const profile = await this.prisma.userOnboardingProfile.upsert({
      where: { userId },
      create: { userId, ...data, lastStepReached },
      update: { ...data, lastStepReached },
    });

    return this.toResponse(profile);
  }

  /**
   * Conclui o quiz: congela os derivados, concede o Starter Kit uma única vez
   * e marca o onboarding como concluído. Idempotente — reenviar não duplica
   * gerações grátis.
   */
  async complete(
    userId: string,
    dto: CompleteOnboardingQuizDto,
  ): Promise<OnboardingProfileResponseDto> {
    await this.assertEligible(userId);

    const answers: OnboardingAnswers = {
      role: dto.role,
      platform: dto.platform,
      modelStatus: dto.modelStatus,
      contentMix: dto.contentMix,
      weeklyVolume: dto.weeklyVolume,
    };

    const segment = resolveSegment(answers);
    const { recommendedPlan, estimatedMonthlyCredits } = recommendPlan(answers);

    const profile = await this.prisma.$transaction(async (tx) => {
      const current = await tx.userOnboardingProfile.findUnique({
        where: { userId },
        select: { starterKitGrantedAt: true, completedAt: true },
      });

      const alreadyGranted = !!current?.starterKitGrantedAt;
      const alreadyCompleted = !!current?.completedAt;
      const now = new Date();

      const saved = await tx.userOnboardingProfile.upsert({
        where: { userId },
        create: {
          userId,
          ...answers,
          answers: answers,
          segment,
          recommendedPlan,
          estimatedMonthlyCredits,
          lastStepReached: ONBOARDING_TOTAL_STEPS,
          completedAt: now,
          starterKitGrantedAt: now,
        },
        update: {
          ...answers,
          answers: answers,
          segment,
          recommendedPlan,
          estimatedMonthlyCredits,
          lastStepReached: ONBOARDING_TOTAL_STEPS,
          // Só na primeira conclusão: preserva o tempo-até-conclusão real.
          // A condição é `completedAt`, não a existência da linha — a linha já
          // existe desde a primeira resposta, gravada pelo saveProgress.
          completedAt: alreadyCompleted ? undefined : now,
          starterKitGrantedAt: alreadyGranted ? undefined : now,
        },
      });

      if (!alreadyGranted) {
        for (const [type, amount] of STARTER_KIT_ENTRIES) {
          await tx.userFreeGeneration.upsert({
            where: { userId_type: { userId, type } },
            create: { userId, type, remaining: amount },
            update: { remaining: { increment: amount } },
          });
        }

        await tx.user.update({
          where: { id: userId },
          data: { hasCompletedOnboarding: true },
        });

        this.logger.log(
          `[ONBOARDING_COMPLETE] user=${userId} segment=${segment} plan=${recommendedPlan} credits=${estimatedMonthlyCredits}`,
        );
      }

      return saved;
    });

    return this.toResponse(profile);
  }

  /**
   * Marca a ativação (primeira geração concluída). Só grava uma vez, e só se o
   * usuário tiver perfil de onboarding — é a métrica de tempo-até-valor.
   */
  async markActivated(userId: string): Promise<void> {
    try {
      await this.prisma.userOnboardingProfile.updateMany({
        where: { userId, activatedAt: null },
        data: { activatedAt: new Date() },
      });
    } catch (err) {
      // Ativação é telemetria: nunca pode derrubar o fluxo de geração.
      this.logger.warn(
        `[ONBOARDING_ACTIVATION_FAILED] user=${userId}: ${String(err)}`,
      );
    }
  }

  /**
   * Barra a base anterior ao lançamento. O portão no front usa o mesmo corte,
   * então na prática ninguém cai aqui — o guard existe para o Starter Kit não
   * ser resgatável por quem chamar o endpoint na mão.
   */
  private async assertEligible(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });

    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    if (!isEligibleForOnboarding(user.createdAt)) {
      throw new ForbiddenException('ONBOARDING_NOT_ELIGIBLE');
    }
  }

  private stripUndefined<T extends Record<string, unknown>>(input: T) {
    return Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    );
  }

  private toResponse(profile: ProfileRow | null): OnboardingProfileResponseDto {
    const starterKit = STARTER_KIT_ENTRIES.map(([type, amount]) => ({
      type,
      amount,
    }));

    if (!profile) {
      return {
        completed: false,
        lastStepReached: 0,
        totalSteps: ONBOARDING_TOTAL_STEPS,
        starterKit,
        starterKitGranted: false,
      };
    }

    const answers = this.readAnswers(profile);
    const plan = answers ? recommendPlan(answers) : null;

    return {
      completed: !!profile.completedAt,
      lastStepReached: profile.lastStepReached,
      totalSteps: ONBOARDING_TOTAL_STEPS,
      role: profile.role as OnboardingRole | null,
      platform: profile.platform as OnboardingPlatform | null,
      modelStatus: profile.modelStatus as OnboardingModelStatus | null,
      contentMix: profile.contentMix as OnboardingContentMix | null,
      weeklyVolume: profile.weeklyVolume as OnboardingWeeklyVolume | null,
      segment: profile.segment as OnboardingSegment | null,
      firstRun: answers ? resolveFirstRun(answers) : null,
      recommendedPlan: profile.recommendedPlan as OnboardingPlanSlug | null,
      estimatedMonthlyCredits: profile.estimatedMonthlyCredits,
      exceedsTopPlan: plan?.exceedsTopPlan ?? false,
      starterKit,
      starterKitGranted: !!profile.starterKitGrantedAt,
      activatedAt: profile.activatedAt?.toISOString() ?? null,
    };
  }

  /** Só devolve respostas quando as cinco existem — derivar de parcial mente. */
  private readAnswers(profile: ProfileRow): OnboardingAnswers | null {
    const { role, platform, modelStatus, contentMix, weeklyVolume } = profile;
    if (!role || !platform || !modelStatus || !contentMix || !weeklyVolume) {
      return null;
    }

    return {
      role: role as OnboardingRole,
      platform: platform as OnboardingPlatform,
      modelStatus: modelStatus as OnboardingModelStatus,
      contentMix: contentMix as OnboardingContentMix,
      weeklyVolume: weeklyVolume as OnboardingWeeklyVolume,
    };
  }
}
