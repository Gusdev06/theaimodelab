import { FreeGenerationType } from '@prisma/client';

/**
 * Quiz de onboarding pós-signup. Cinco perguntas, nenhuma de digitação:
 * nome e email já vieram do cadastro, então cada pergunta aqui precisa
 * justificar o próprio atrito — ou personaliza o primeiro uso, ou entra
 * na conta do plano. Nenhuma pergunta existe só para "conhecer o usuário".
 */

export const ONBOARDING_QUIZ_VERSION = 'v1';
export const ONBOARDING_TOTAL_STEPS = 5;

/**
 * Corte de elegibilidade: o quiz (e o Starter Kit que ele concede) só valem
 * para contas criadas a partir desta data. A base que já existia não é
 * interrompida por cinco perguntas nem ganha gerações grátis retroativas —
 * decisão do Gusta em 2026-08-29, na subida para produção.
 *
 * O front espelha este valor em `web/lib/onboarding.ts`. Mudou aqui, muda lá.
 */
export const ONBOARDING_ELIGIBILITY_CUTOFF = new Date(
  '2026-08-29T00:00:00.000Z',
);

/** Contas anteriores ao corte não veem o quiz nem recebem o Starter Kit. */
export function isEligibleForOnboarding(userCreatedAt: Date): boolean {
  return userCreatedAt.getTime() >= ONBOARDING_ELIGIBILITY_CUTOFF.getTime();
}

export const ONBOARDING_ROLES = [
  'solo_creator',
  'ofm_operator',
  'agency',
  'telegram_bot',
] as const;

export const ONBOARDING_PLATFORMS = [
  'onlyfans',
  'fanvue',
  'telegram',
  'instagram',
  'not_launched',
] as const;

export const ONBOARDING_MODEL_STATUS = [
  'needs_first',
  'has_one',
  'has_many',
] as const;

export const ONBOARDING_CONTENT_MIX = [
  'photos',
  'mixed',
  'video_heavy',
] as const;

export const ONBOARDING_WEEKLY_VOLUME = [
  'under_20',
  'from_20_to_60',
  'from_60_to_150',
  'over_150',
] as const;

export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];
export type OnboardingPlatform = (typeof ONBOARDING_PLATFORMS)[number];
export type OnboardingModelStatus = (typeof ONBOARDING_MODEL_STATUS)[number];
export type OnboardingContentMix = (typeof ONBOARDING_CONTENT_MIX)[number];
export type OnboardingWeeklyVolume = (typeof ONBOARDING_WEEKLY_VOLUME)[number];

export type OnboardingSegment = 'identity' | 'volume' | 'scale' | 'factory';

/** O que o app abre primeiro quando o quiz termina. É a rota de ativação. */
export type OnboardingFirstRun =
  'create_model' | 'generate_photos' | 'generate_video';

export type OnboardingAnswers = {
  role: OnboardingRole;
  platform: OnboardingPlatform;
  modelStatus: OnboardingModelStatus;
  contentMix: OnboardingContentMix;
  weeklyVolume: OnboardingWeeklyVolume;
};

/**
 * Starter Kit — gerações grátis liberadas ao concluir o quiz.
 *
 * Sem isso o onboarding não fecha: o signup dá 50 créditos de bônus e a
 * imagem de qualidade mais barata custa 90, então hoje um usuário novo não
 * consegue concluir nenhuma geração. O kit é dimensionado para provar as três
 * coisas que sustentam a oferta — rosto consistente, 18+ sem censura e vídeo —
 * e para acabar antes de substituir um mês de plano.
 */
export const ONBOARDING_STARTER_KIT: Partial<
  Record<FreeGenerationType, number>
> = {
  [FreeGenerationType.NB2]: 3,
  [FreeGenerationType.SEM_CENSURA]: 1,
  [FreeGenerationType.THEAIMODELAB_FAST]: 1,
};

/**
 * Custo de referência por ativo, em créditos (base definida em 2026-07-04):
 * imagem NB2 1K = 90 · vídeo motion control 720p/10s = 700.
 */
const CREDITS_PER_IMAGE = 90;
const CREDITS_PER_VIDEO = 700;

/** Fração de vídeo no mix declarado. O resto é imagem. */
const VIDEO_SHARE: Record<OnboardingContentMix, number> = {
  photos: 0,
  mixed: 0.25,
  video_heavy: 0.65,
};

/** Ativos por semana no meio de cada faixa declarada. */
const WEEKLY_ASSETS: Record<OnboardingWeeklyVolume, number> = {
  under_20: 15,
  from_20_to_60: 40,
  from_60_to_150: 100,
  over_150: 200,
};

const WEEKS_PER_MONTH = 4.33;

export const ONBOARDING_PLAN_SLUGS = [
  'creator',
  'pro',
  'advanced',
  'studio',
] as const;
export type OnboardingPlanSlug = (typeof ONBOARDING_PLAN_SLUGS)[number];

/** Créditos/mês por plano ativo. Espelha `prisma/seed.ts`. */
const PLAN_CREDITS: Record<OnboardingPlanSlug, number> = {
  creator: 12_000,
  pro: 30_000,
  advanced: 50_000,
  studio: 80_000,
};

/**
 * Piso de plano por segmento — volume baixo não pode recomendar Creator para
 * quem precisa de API ou de mais slots de clone de avatar.
 */
const SEGMENT_PLAN_FLOOR: Record<OnboardingSegment, OnboardingPlanSlug> = {
  identity: 'creator',
  volume: 'creator',
  scale: 'pro',
  factory: 'advanced',
};

export function resolveSegment(answers: OnboardingAnswers): OnboardingSegment {
  if (answers.role === 'agency' || answers.modelStatus === 'has_many') {
    return 'factory';
  }
  if (
    answers.role === 'ofm_operator' ||
    answers.weeklyVolume === 'over_150' ||
    answers.weeklyVolume === 'from_60_to_150'
  ) {
    return 'scale';
  }
  if (answers.modelStatus === 'needs_first') return 'identity';
  return 'volume';
}

/**
 * Rota de ativação. Depende só do que o usuário consegue fazer AGORA:
 * quem não tem persona precisa criar uma antes de qualquer outra coisa.
 */
export function resolveFirstRun(
  answers: OnboardingAnswers,
): OnboardingFirstRun {
  if (answers.modelStatus === 'needs_first') return 'create_model';
  if (answers.contentMix === 'video_heavy') return 'generate_video';
  return 'generate_photos';
}

export function estimateMonthlyCredits(answers: OnboardingAnswers): number {
  const monthlyAssets = WEEKLY_ASSETS[answers.weeklyVolume] * WEEKS_PER_MONTH;
  const videoShare = VIDEO_SHARE[answers.contentMix];
  const blendedCost =
    videoShare * CREDITS_PER_VIDEO + (1 - videoShare) * CREDITS_PER_IMAGE;

  return Math.round(monthlyAssets * blendedCost);
}

export type PlanRecommendation = {
  recommendedPlan: OnboardingPlanSlug;
  estimatedMonthlyCredits: number;
  /**
   * true quando nem o Studio cobre o volume declarado. Dizer isso na cara é
   * intencional: a maior ansiedade do ICP é pagar e os créditos não darem —
   * prometer que o plano cobre quando não cobre gera churn no primeiro mês.
   */
  exceedsTopPlan: boolean;
};

export function recommendPlan(answers: OnboardingAnswers): PlanRecommendation {
  const estimatedMonthlyCredits = estimateMonthlyCredits(answers);
  const segment = resolveSegment(answers);
  const floor = SEGMENT_PLAN_FLOOR[segment];

  const byCredits =
    ONBOARDING_PLAN_SLUGS.find(
      (slug) => PLAN_CREDITS[slug] >= estimatedMonthlyCredits,
    ) ?? 'studio';

  const recommendedPlan =
    ONBOARDING_PLAN_SLUGS.indexOf(byCredits) >=
    ONBOARDING_PLAN_SLUGS.indexOf(floor)
      ? byCredits
      : floor;

  return {
    recommendedPlan,
    estimatedMonthlyCredits,
    exceedsTopPlan: estimatedMonthlyCredits > PLAN_CREDITS.studio,
  };
}
