import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationType, Resolution } from '@prisma/client';

/**
 * Maps plan slugs to env var names for Stripe price IDs.
 * Allows dev/test to use different price IDs without touching the database.
 */
const PLAN_PRICE_ENV: Record<string, string> = {
  // v5 plans
  'ultra-basic': 'STRIPE_PRICE_PLAN_ULTRABASIC',
  basic: 'STRIPE_PRICE_PLAN_BASIC',
  advanced: 'STRIPE_PRICE_PLAN_ADVANCED',
  // legacy plans (mantidos para grandfathering)
  starter: 'STRIPE_PRICE_PLAN_STARTER',
  creator: 'STRIPE_PRICE_PLAN_CREATOR',
  pro: 'STRIPE_PRICE_PLAN_PRO',
  studio: 'STRIPE_PRICE_PLAN_STUDIO',
};

const PACKAGE_PRICE_ENV: Record<string, string> = {
  'boost p': 'STRIPE_PRICE_BOOST_P',
  'boost m': 'STRIPE_PRICE_BOOST_M',
  'boost g': 'STRIPE_PRICE_BOOST_G',
  'boost xg': 'STRIPE_PRICE_BOOST_XG',
  'boost xxg': 'STRIPE_PRICE_BOOST_XXG',
};

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Override stripePriceId with env var value when available.
   * This allows test mode to use different Stripe prices without touching the DB.
   */
  private overridePriceId<T extends { slug?: string; name?: string; stripePriceId: string | null }>(
    record: T,
    envMap: Record<string, string>,
    key: 'slug' | 'name' = 'slug',
  ): T {
    const lookup = (record[key] ?? '').toLowerCase();
    const envVar = envMap[lookup];
    if (envVar) {
      const envValue = this.configService.get<string>(envVar);
      if (envValue) {
        return { ...record, stripePriceId: envValue };
      }
    }
    return record;
  }

  async findAllPlans() {
    const plans = await this.prisma.plan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return plans.map((p) => this.overridePriceId(p, PLAN_PRICE_ENV));
  }

  async findPlanBySlug(slug: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { slug },
    });

    if (!plan) {
      throw new NotFoundException(`Plano "${slug}" não encontrado`);
    }

    return this.overridePriceId(plan, PLAN_PRICE_ENV);
  }

  async findPlanById(id: string) {
    const plan = await this.prisma.plan.findUnique({
      where: { id },
    });

    if (!plan) {
      throw new NotFoundException('Plano não encontrado');
    }

    return this.overridePriceId(plan, PLAN_PRICE_ENV);
  }

  async getCreditCost(
    generationType: GenerationType,
    resolution: Resolution,
    hasAudio: boolean,
    modelVariant?: string | null,
  ) {
    // Default to NB2 for image-based types when no variant is specified,
    // since all image credit_costs rows require a model variant.
    const IMAGE_TYPES: GenerationType[] = [
      GenerationType.TEXT_TO_IMAGE,
      GenerationType.IMAGE_TO_IMAGE,
      GenerationType.VIRTUAL_TRY_ON,
      GenerationType.FACE_SWAP,
    ];
    const resolvedVariant =
      !modelVariant && IMAGE_TYPES.includes(generationType)
        ? 'NB2'
        : (modelVariant ?? null);

    const cost = await this.prisma.creditCost.findFirst({
      where: {
        generationType,
        resolution,
        hasAudio,
        modelVariant: resolvedVariant,
        isActive: true,
      },
    });

    if (!cost) {
      throw new NotFoundException(
        `Custo de crédito não encontrado para ${generationType} ${resolution} (audio: ${hasAudio}, variant: ${modelVariant ?? 'default'})`,
      );
    }

    return cost;
  }

  async calculateGenerationCost(
    generationType: GenerationType,
    resolution: Resolution,
    durationSeconds?: number,
    hasAudio: boolean = false,
    sampleCount: number = 1,
    modelVariant?: string | null,
    hasVideoInput: boolean = false,
  ): Promise<number> {
    // Gemini Omni Video tem pricing variável por (resolution, duration, hasVideoInput)
    // que não cabe na tabela credit_costs — hardcoded aqui.
    if (modelVariant === 'GEMINI_OMNI') {
      return PlansService.calculateOmniCost(resolution, durationSeconds, hasVideoInput);
    }

    // Bytedance Seedance 2.0 — per-second, varia por resolution e hasVideoInput.
    if (modelVariant === 'SEEDANCE_2') {
      return PlansService.calculateSeedanceCost(resolution, durationSeconds, hasVideoInput);
    }

    const cost = await this.getCreditCost(generationType, resolution, hasAudio, modelVariant);

    let total = cost.creditsPerUnit;
    if (cost.isPerSecond && durationSeconds) {
      total = cost.creditsPerUnit * durationSeconds;
    }

    // Modelos Veo (THEAIMODELAB_FAST / THEAIMODELAB_QUALITY) cobram proporcional ao sampleCount.
    // Demais modelos mantêm a regra: 1-4 amostras custam o mesmo (preço de 1).
    const isVeoVideo =
      modelVariant === 'THEAIMODELAB_FAST' || modelVariant === 'THEAIMODELAB_QUALITY';
    const effectiveSamples = isVeoVideo
      ? sampleCount
      : sampleCount <= 4
        ? 1
        : sampleCount;
    return total * Math.max(effectiveSamples, 1);
  }

  // Pricing Gemini Omni Video — ancorado em VEO_MAX (~1408 cr/USD de custo KIE).
  // Sem vídeo: varia por (resolution, duration). Com vídeo: flat por resolution.
  private static readonly OMNI_PRICING_NO_VIDEO: Record<string, Record<number, number>> = {
    RES_720P:  { 4: 630,  6: 840,  8: 1060, 10: 1270 },
    RES_1080P: { 4: 630,  6: 840,  8: 1060, 10: 1270 },
    RES_4K:    { 4: 1480, 6: 1690, 8: 1900, 10: 2110 },
  };
  private static readonly OMNI_PRICING_WITH_VIDEO: Record<string, number> = {
    RES_720P:  1690,
    RES_1080P: 1690,
    RES_4K:    2530,
  };

  private static calculateOmniCost(
    resolution: Resolution,
    durationSeconds: number | undefined,
    hasVideoInput: boolean,
  ): number {
    if (hasVideoInput) {
      const price = PlansService.OMNI_PRICING_WITH_VIDEO[resolution];
      if (!price) {
        throw new NotFoundException(
          `Pricing Gemini Omni (com vídeo) não encontrado para resolution=${resolution}`,
        );
      }
      return price;
    }

    const byDuration = PlansService.OMNI_PRICING_NO_VIDEO[resolution];
    const price = byDuration?.[durationSeconds ?? 0];
    if (!price) {
      throw new NotFoundException(
        `Pricing Gemini Omni (sem vídeo) não encontrado para resolution=${resolution} duration=${durationSeconds}s`,
      );
    }
    return price;
  }

  // Pricing Bytedance Seedance 2.0 — per-second, varia por (resolution, hasVideoInput).
  // Ancorado em VEO_MAX (~1408 cr/USD). "With video" = tem reference_video_urls.
  private static readonly SEEDANCE_PRICING_NO_VIDEO: Record<string, number> = {
    RES_480P:  130,
    RES_720P:  290,
    RES_1080P: 720,
  };
  private static readonly SEEDANCE_PRICING_WITH_VIDEO: Record<string, number> = {
    RES_480P:   80,
    RES_720P:  175,
    RES_1080P: 440,
  };

  private static calculateSeedanceCost(
    resolution: Resolution,
    durationSeconds: number | undefined,
    hasVideoInput: boolean,
  ): number {
    const pricing = hasVideoInput
      ? PlansService.SEEDANCE_PRICING_WITH_VIDEO
      : PlansService.SEEDANCE_PRICING_NO_VIDEO;
    const perSecond = pricing[resolution];
    if (!perSecond) {
      throw new NotFoundException(
        `Pricing Seedance não encontrado para resolution=${resolution} (hasVideoInput=${hasVideoInput})`,
      );
    }
    const seconds = durationSeconds ?? 5;
    return perSecond * seconds;
  }

  async findAllPackages() {
    const packages = await this.prisma.creditPackage.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return packages.map((p) => this.overridePriceId(p, PACKAGE_PRICE_ENV, 'name'));
  }

  async findPackageById(id: string) {
    const pkg = await this.prisma.creditPackage.findUnique({
      where: { id },
    });

    if (!pkg) {
      throw new NotFoundException('Pacote de créditos não encontrado');
    }

    return this.overridePriceId(pkg, PACKAGE_PRICE_ENV, 'name');
  }

  /**
   * Resolve o PlanPrice para a moeda do usuário. Fallback: USD.
   */
  async resolvePlanPrice(
    planId: string,
    userCurrency: string,
  ): Promise<{ currency: string; priceCents: number; stripePriceId: string }> {
    const currency = userCurrency.toUpperCase();
    const primary = await this.prisma.planPrice.findUnique({
      where: { planId_currency: { planId, currency } },
    });
    if (primary?.isActive) return primary;

    if (currency !== 'USD') {
      const usd = await this.prisma.planPrice.findUnique({
        where: { planId_currency: { planId, currency: 'USD' } },
      });
      if (usd?.isActive) return usd;
    }

    throw new NotFoundException(
      `Preço não configurado para plano ${planId} em ${currency} ou USD`,
    );
  }

  /**
   * Resolve o CreditPackagePrice para a moeda do usuário. Fallback: USD.
   */
  async resolvePackagePrice(
    creditPackageId: string,
    userCurrency: string,
  ): Promise<{ currency: string; priceCents: number; stripePriceId: string }> {
    const currency = userCurrency.toUpperCase();
    const primary = await this.prisma.creditPackagePrice.findUnique({
      where: { creditPackageId_currency: { creditPackageId, currency } },
    });
    if (primary?.isActive) return primary;

    if (currency !== 'USD') {
      const usd = await this.prisma.creditPackagePrice.findUnique({
        where: { creditPackageId_currency: { creditPackageId, currency: 'USD' } },
      });
      if (usd?.isActive) return usd;
    }

    throw new NotFoundException(
      `Preço não configurado para pacote ${creditPackageId} em ${currency} ou USD`,
    );
  }
}
