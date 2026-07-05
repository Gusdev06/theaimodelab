import { PrismaClient, Plan, CreditPackage } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// Modelos liberados em modo ilimitado por plano.
// modelVariant + resolutions válidos. Atualize aqui ao mudar a oferta dos planos.
const UNLIMITED_MODELS = {
  creator: [
    { modelVariant: 'THEAIMODELAB_FAST', resolutions: ['RES_720P'] },
  ],
  pro: [
    { modelVariant: 'THEAIMODELAB_FAST', resolutions: ['RES_720P', 'RES_1080P'] },
  ],
  advanced: [
    { modelVariant: 'THEAIMODELAB_FAST', resolutions: ['RES_720P'] },
    { modelVariant: 'THEAIMODELAB_QUALITY', resolutions: ['RES_720P'] },
    { modelVariant: 'NB2', resolutions: ['RES_1K'] },
  ],
  studio: [
    { modelVariant: 'THEAIMODELAB_FAST', resolutions: ['RES_720P', 'RES_1080P'] },
    { modelVariant: 'THEAIMODELAB_QUALITY', resolutions: ['RES_720P', 'RES_1080P'] },
    { modelVariant: 'NB2', resolutions: ['RES_1K'] },
    { modelVariant: 'NBP', resolutions: ['RES_1K'] },
  ],
} as const;

// Stripe Price IDs — lidos do .env (dev usa test IDs, prod usa live IDs)
const STRIPE = {
  // ── v5 plans (BRL) ──
  planUltraBasic: process.env.STRIPE_PRICE_PLAN_ULTRABASIC ?? '',
  planBasic: process.env.STRIPE_PRICE_PLAN_BASIC ?? '',
  planAdvanced: process.env.STRIPE_PRICE_PLAN_ADVANCED ?? '',
  // ── v5 plans USD ──
  planUltraBasicUsd: process.env.STRIPE_PRICE_PLAN_ULTRABASIC_USD ?? '',
  planBasicUsd: process.env.STRIPE_PRICE_PLAN_BASIC_USD ?? '',
  planAdvancedUsd: process.env.STRIPE_PRICE_PLAN_ADVANCED_USD ?? '',
  // ── v5 plans EUR ──
  planUltraBasicEur: process.env.STRIPE_PRICE_PLAN_ULTRABASIC_EUR ?? '',
  planBasicEur: process.env.STRIPE_PRICE_PLAN_BASIC_EUR ?? '',
  planAdvancedEur: process.env.STRIPE_PRICE_PLAN_ADVANCED_EUR ?? '',
  // ── Legacy plans (kept for grandfathering existing subscribers) ──
  planStarter: process.env.STRIPE_PRICE_PLAN_STARTER ?? '',
  planCreator: process.env.STRIPE_PRICE_PLAN_CREATOR ?? '',
  planPro: process.env.STRIPE_PRICE_PLAN_PRO ?? '',
  planStudio: process.env.STRIPE_PRICE_PLAN_STUDIO ?? '',
  planStarterUsd: process.env.STRIPE_PRICE_PLAN_STARTER_USD ?? '',
  planCreatorUsd: process.env.STRIPE_PRICE_PLAN_CREATOR_USD ?? '',
  planProUsd: process.env.STRIPE_PRICE_PLAN_PRO_USD ?? '',
  planStudioUsd: process.env.STRIPE_PRICE_PLAN_STUDIO_USD ?? '',
  planStarterEur: process.env.STRIPE_PRICE_PLAN_STARTER_EUR ?? '',
  planCreatorEur: process.env.STRIPE_PRICE_PLAN_CREATOR_EUR ?? '',
  planProEur: process.env.STRIPE_PRICE_PLAN_PRO_EUR ?? '',
  planStudioEur: process.env.STRIPE_PRICE_PLAN_STUDIO_EUR ?? '',
  // ── Legacy products (inactive) ──
  priceStarter: process.env.STRIPE_PRICE_STARTER ?? '',
  pricePro: process.env.STRIPE_PRICE_PRO ?? '',
  priceBusiness: process.env.STRIPE_PRICE_BUSINESS ?? '',
  priceCredits500: process.env.STRIPE_PRICE_CREDITS_500 ?? '',
  priceCredits1000: process.env.STRIPE_PRICE_CREDITS_1000 ?? '',
  priceCredits5000: process.env.STRIPE_PRICE_CREDITS_5000 ?? '',
  // ── Boost packages (avulsos) ──
  priceBoostP: process.env.STRIPE_PRICE_BOOST_P ?? '',
  priceBoostM: process.env.STRIPE_PRICE_BOOST_M ?? '',
  priceBoostG: process.env.STRIPE_PRICE_BOOST_G ?? '',
  priceBoostXg: process.env.STRIPE_PRICE_BOOST_XG ?? '',
  priceBoostXxg: process.env.STRIPE_PRICE_BOOST_XXG ?? '',
  priceBoostPUsd: process.env.STRIPE_PRICE_BOOST_P_USD ?? '',
  priceBoostMUsd: process.env.STRIPE_PRICE_BOOST_M_USD ?? '',
  priceBoostGUsd: process.env.STRIPE_PRICE_BOOST_G_USD ?? '',
  priceBoostXgUsd: process.env.STRIPE_PRICE_BOOST_XG_USD ?? '',
  priceBoostXxgUsd: process.env.STRIPE_PRICE_BOOST_XXG_USD ?? '',
  priceBoostPEur: process.env.STRIPE_PRICE_BOOST_P_EUR ?? '',
  priceBoostMEur: process.env.STRIPE_PRICE_BOOST_M_EUR ?? '',
  priceBoostGEur: process.env.STRIPE_PRICE_BOOST_G_EUR ?? '',
  priceBoostXgEur: process.env.STRIPE_PRICE_BOOST_XG_EUR ?? '',
  priceBoostXxgEur: process.env.STRIPE_PRICE_BOOST_XXG_EUR ?? '',
};

// ── Links de checkout externos (sem Stripe) — um por pacote de créditos ──
// Preencher via env quando os links do novo provedor estiverem prontos.
const CHECKOUT = {
  creator: process.env.CHECKOUT_URL_CREATOR ?? 'https://checkout.centerpag.com/pay/PPU38CQDQHP?',
  pro: process.env.CHECKOUT_URL_PRO ?? 'https://checkout.centerpag.com/pay/PPU38CQDQID?',
  advanced: process.env.CHECKOUT_URL_ADVANCED ?? 'https://checkout.centerpag.com/pay/PPU38CQDQIE?',
  studio: process.env.CHECKOUT_URL_STUDIO ?? 'https://checkout.centerpag.com/pay/PPU38CQDQIG?',
};

// ── Códigos de PLANO na Perfect Pay (mapeiam o postback → pacote de crédito) ──
// O produto é único (ex: PPPBEKMJ); cada pacote é um "plano" com preço próprio.
// Preencher via env com o plan.code de cada plano criado na Perfect Pay.
const PERFECTPAY = {
  creator: process.env.PERFECTPAY_PLAN_CREATOR ?? 'PPLQQPT4G',
  pro: process.env.PERFECTPAY_PLAN_PRO ?? 'PPLQQPT4L',
  advanced: process.env.PERFECTPAY_PLAN_ADVANCED ?? 'PPLQQPT4M',
  studio: process.env.PERFECTPAY_PLAN_STUDIO ?? 'PPLQQPT4O',
};

async function main() {
  console.log('🌱 Starting database seed...');

  // ============================================
  // Seed Plans
  // ============================================
  console.log('📋 Creating plans...');

  const planData = [
    // ── v5 plans (nova precificação 2026-04) ──
    // Free: 0 créditos/mês para novos cadastros. Usuários legados mantêm saldo
    // via cron (que ignora renovação quando creditsPerMonth === 0).
    { slug: 'free', update: { name: 'Free', priceCents: 0, creditsPerMonth: 0, maxConcurrentGenerations: 1, hasWatermark: false, galleryRetentionDays: 7, hasApiAccess: false, isActive: true, sortOrder: 0, avatar_clone_enabled: false, avatar_clone_limit: 0 }, create: { slug: 'free', name: 'Free', priceCents: 0, creditsPerMonth: 0, maxConcurrentGenerations: 1, hasWatermark: false, galleryRetentionDays: 7, hasApiAccess: false, sortOrder: 0, avatar_clone_enabled: false, avatar_clone_limit: 0 } },
    { slug: 'ultra-basic', update: { name: 'Ultra Basic', priceCents: 1290, creditsPerMonth: 700, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, isActive: true, sortOrder: 1, stripePriceId: STRIPE.planUltraBasic, avatar_clone_enabled: false, avatar_clone_limit: 0 }, create: { slug: 'ultra-basic', name: 'Ultra Basic', priceCents: 1290, creditsPerMonth: 700, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, sortOrder: 1, stripePriceId: STRIPE.planUltraBasic, avatar_clone_enabled: false, avatar_clone_limit: 0 } },
    { slug: 'basic', update: { name: 'Basic', priceCents: 5990, creditsPerMonth: 7000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, isActive: true, sortOrder: 3, stripePriceId: STRIPE.planBasic, avatar_clone_enabled: true, avatar_clone_limit: 1 }, create: { slug: 'basic', name: 'Basic', priceCents: 5990, creditsPerMonth: 7000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, sortOrder: 3, stripePriceId: STRIPE.planBasic, avatar_clone_enabled: true, avatar_clone_limit: 1 } },
    { slug: 'advanced', update: { name: 'Advanced', priceCents: 24990, creditsPerMonth: 50000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: null as number | null, hasApiAccess: true, isActive: true, sortOrder: 6, stripePriceId: STRIPE.planAdvanced, avatar_clone_enabled: true, avatar_clone_limit: 8 }, create: { slug: 'advanced', name: 'Advanced', priceCents: 24990, creditsPerMonth: 50000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: null as number | null, hasApiAccess: true, sortOrder: 6, stripePriceId: STRIPE.planAdvanced, avatar_clone_enabled: true, avatar_clone_limit: 8 } },
    // ── Planos anteriores (mantidos como estavam) ──
    { slug: 'starter', update: { name: 'Starter', priceCents: 3990, creditsPerMonth: 4000, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, isActive: true, sortOrder: 2, stripePriceId: STRIPE.planStarter, avatar_clone_enabled: true, avatar_clone_limit: 1 }, create: { slug: 'starter', name: 'Starter', priceCents: 3990, creditsPerMonth: 4000, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, sortOrder: 2, stripePriceId: STRIPE.planStarter, avatar_clone_enabled: true, avatar_clone_limit: 1 } },
    { slug: 'creator', update: { name: 'Creator', priceCents: 8990, creditsPerMonth: 12000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, isActive: true, sortOrder: 4, stripePriceId: STRIPE.planCreator, avatar_clone_enabled: true, avatar_clone_limit: 2 }, create: { slug: 'creator', name: 'Creator', priceCents: 8990, creditsPerMonth: 12000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, sortOrder: 4, stripePriceId: STRIPE.planCreator, avatar_clone_enabled: true, avatar_clone_limit: 2 } },
    { slug: 'pro', update: { name: 'Pro', priceCents: 17990, creditsPerMonth: 30000, maxConcurrentGenerations: 5, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: false, isActive: true, sortOrder: 5, stripePriceId: STRIPE.planPro, avatar_clone_enabled: true, avatar_clone_limit: 5 }, create: { slug: 'pro', name: 'Pro', priceCents: 17990, creditsPerMonth: 30000, maxConcurrentGenerations: 5, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: false, sortOrder: 5, stripePriceId: STRIPE.planPro, avatar_clone_enabled: true, avatar_clone_limit: 5 } },
    { slug: 'studio', update: { name: 'Studio', priceCents: 36990, creditsPerMonth: 80000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: true, isActive: true, sortOrder: 7, stripePriceId: STRIPE.planStudio, avatar_clone_enabled: true, avatar_clone_limit: 10 }, create: { slug: 'studio', name: 'Studio', priceCents: 36990, creditsPerMonth: 80000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: true, sortOrder: 7, stripePriceId: STRIPE.planStudio, avatar_clone_enabled: true, avatar_clone_limit: 10 } },
    { slug: 'free', update: { name: 'Free', priceCents: 0, creditsPerMonth: 0, maxConcurrentGenerations: 1, hasWatermark: false, galleryRetentionDays: 7, hasApiAccess: false, isActive: true, sortOrder: 0 }, create: { slug: 'free', name: 'Free', priceCents: 0, creditsPerMonth: 0, maxConcurrentGenerations: 1, hasWatermark: false, galleryRetentionDays: 7, hasApiAccess: false, sortOrder: 0 } },
    { slug: 'ultra-basic', update: { name: 'Ultra Basic', priceCents: 1290, creditsPerMonth: 700, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, isActive: true, sortOrder: 1, stripePriceId: STRIPE.planUltraBasic }, create: { slug: 'ultra-basic', name: 'Ultra Basic', priceCents: 1290, creditsPerMonth: 700, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, sortOrder: 1, stripePriceId: STRIPE.planUltraBasic } },
    { slug: 'basic', update: { name: 'Basic', priceCents: 5990, creditsPerMonth: 7000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, isActive: true, sortOrder: 3, stripePriceId: STRIPE.planBasic }, create: { slug: 'basic', name: 'Basic', priceCents: 5990, creditsPerMonth: 7000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, sortOrder: 3, stripePriceId: STRIPE.planBasic } },
    { slug: 'advanced', update: { name: 'Advanced', priceCents: 24990, creditsPerMonth: 50000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: null as number | null, hasApiAccess: true, isActive: true, sortOrder: 6, stripePriceId: STRIPE.planAdvanced, unlimitedPriority: 2, unlimitedModels: UNLIMITED_MODELS.advanced }, create: { slug: 'advanced', name: 'Advanced', priceCents: 24990, creditsPerMonth: 50000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: null as number | null, hasApiAccess: true, sortOrder: 6, stripePriceId: STRIPE.planAdvanced, unlimitedPriority: 2, unlimitedModels: UNLIMITED_MODELS.advanced } },
    // ── Planos anteriores (mantidos como estavam) ──
    { slug: 'starter', update: { name: 'Starter', priceCents: 3990, creditsPerMonth: 4000, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, isActive: true, sortOrder: 2, stripePriceId: STRIPE.planStarter }, create: { slug: 'starter', name: 'Starter', priceCents: 3990, creditsPerMonth: 4000, maxConcurrentGenerations: 2, hasWatermark: false, galleryRetentionDays: 90, hasApiAccess: false, sortOrder: 2, stripePriceId: STRIPE.planStarter } },
    { slug: 'creator', update: { name: 'Creator', priceCents: 8990, creditsPerMonth: 12000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, isActive: true, sortOrder: 4, stripePriceId: STRIPE.planCreator, unlimitedPriority: 4, unlimitedModels: UNLIMITED_MODELS.creator }, create: { slug: 'creator', name: 'Creator', priceCents: 8990, creditsPerMonth: 12000, maxConcurrentGenerations: 3, hasWatermark: false, galleryRetentionDays: 180, hasApiAccess: false, sortOrder: 4, stripePriceId: STRIPE.planCreator, unlimitedPriority: 4, unlimitedModels: UNLIMITED_MODELS.creator } },
    { slug: 'pro', update: { name: 'Pro', priceCents: 17990, creditsPerMonth: 30000, maxConcurrentGenerations: 5, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: false, isActive: true, sortOrder: 5, stripePriceId: STRIPE.planPro, unlimitedPriority: 3, unlimitedModels: UNLIMITED_MODELS.pro }, create: { slug: 'pro', name: 'Pro', priceCents: 17990, creditsPerMonth: 30000, maxConcurrentGenerations: 5, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: false, sortOrder: 5, stripePriceId: STRIPE.planPro, unlimitedPriority: 3, unlimitedModels: UNLIMITED_MODELS.pro } },
    { slug: 'studio', update: { name: 'Studio', priceCents: 36990, creditsPerMonth: 80000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: true, isActive: true, sortOrder: 7, stripePriceId: STRIPE.planStudio, unlimitedPriority: 1, unlimitedModels: UNLIMITED_MODELS.studio }, create: { slug: 'studio', name: 'Studio', priceCents: 36990, creditsPerMonth: 80000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: 365, hasApiAccess: true, sortOrder: 7, stripePriceId: STRIPE.planStudio, unlimitedPriority: 1, unlimitedModels: UNLIMITED_MODELS.studio } },
    // ── Legacy (Business — já estava inativo antes) ──
    { slug: 'business', update: { isActive: false, sortOrder: 99 }, create: { slug: 'business', name: 'Business', priceCents: 24990, creditsPerMonth: 10000, maxConcurrentGenerations: 10, hasWatermark: false, galleryRetentionDays: null as number | null, hasApiAccess: true, sortOrder: 99, isActive: false, stripePriceId: STRIPE.priceBusiness } },
  ];

  const plans: Plan[] = [];
  for (const plan of planData) {
    plans.push(
      await prisma.plan.upsert({
        where: { slug: plan.slug },
        update: plan.update,
        create: plan.create as any,
      }),
    );
  }

  console.log(`✅ Created ${plans.length} plans`);

  // ============================================
  // Seed Plan Prices (multi-currency)
  // ============================================
  console.log('💱 Creating plan prices (multi-currency)...');

  const planPriceData: Array<{ slug: string; currency: string; priceCents: number; stripePriceId: string }> = [
    // ── v5 plans ──
    // BRL
    { slug: 'ultra-basic', currency: 'BRL', priceCents: 1290, stripePriceId: STRIPE.planUltraBasic },
    { slug: 'basic', currency: 'BRL', priceCents: 5990, stripePriceId: STRIPE.planBasic },
    { slug: 'advanced', currency: 'BRL', priceCents: 24990, stripePriceId: STRIPE.planAdvanced },
    // USD
    { slug: 'ultra-basic', currency: 'USD', priceCents: 290, stripePriceId: STRIPE.planUltraBasicUsd },
    { slug: 'basic', currency: 'USD', priceCents: 1290, stripePriceId: STRIPE.planBasicUsd },
    { slug: 'advanced', currency: 'USD', priceCents: 5490, stripePriceId: STRIPE.planAdvancedUsd },
    // EUR
    { slug: 'ultra-basic', currency: 'EUR', priceCents: 290, stripePriceId: STRIPE.planUltraBasicEur },
    { slug: 'basic', currency: 'EUR', priceCents: 1290, stripePriceId: STRIPE.planBasicEur },
    { slug: 'advanced', currency: 'EUR', priceCents: 5490, stripePriceId: STRIPE.planAdvancedEur },
    // ── Legacy plans (mantidos para grandfathering — não expostos em /plans) ──
    // BRL
    { slug: 'starter', currency: 'BRL', priceCents: 3990, stripePriceId: STRIPE.planStarter },
    { slug: 'creator', currency: 'BRL', priceCents: 8990, stripePriceId: STRIPE.planCreator },
    { slug: 'pro', currency: 'BRL', priceCents: 17990, stripePriceId: STRIPE.planPro },
    { slug: 'studio', currency: 'BRL', priceCents: 36990, stripePriceId: STRIPE.planStudio },
    // USD
    { slug: 'starter', currency: 'USD', priceCents: 990, stripePriceId: STRIPE.planStarterUsd },
    { slug: 'creator', currency: 'USD', priceCents: 1990, stripePriceId: STRIPE.planCreatorUsd },
    { slug: 'pro', currency: 'USD', priceCents: 3990, stripePriceId: STRIPE.planProUsd },
    { slug: 'studio', currency: 'USD', priceCents: 7990, stripePriceId: STRIPE.planStudioUsd },
    // EUR
    { slug: 'starter', currency: 'EUR', priceCents: 890, stripePriceId: STRIPE.planStarterEur },
    { slug: 'creator', currency: 'EUR', priceCents: 1890, stripePriceId: STRIPE.planCreatorEur },
    { slug: 'pro', currency: 'EUR', priceCents: 3790, stripePriceId: STRIPE.planProEur },
    { slug: 'studio', currency: 'EUR', priceCents: 7490, stripePriceId: STRIPE.planStudioEur },
  ];

  const plansBySlug = new Map(plans.map((p) => [p.slug, p]));
  let planPriceCount = 0;
  for (const pp of planPriceData) {
    const plan = plansBySlug.get(pp.slug);
    if (!plan || !pp.stripePriceId) continue;
    await prisma.planPrice.upsert({
      where: { planId_currency: { planId: plan.id, currency: pp.currency } },
      update: { priceCents: pp.priceCents, stripePriceId: pp.stripePriceId, isActive: true },
      create: { planId: plan.id, currency: pp.currency, priceCents: pp.priceCents, stripePriceId: pp.stripePriceId },
    });
    planPriceCount++;
  }
  console.log(`✅ Created ${planPriceCount} plan prices`);

  // ============================================
  // Seed Credit Costs
  // ============================================
  console.log('💰 Creating credit costs...');

  const creditCosts = [
    // Images - Nano Banana 2 (NB2) — v4 pricing
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_1K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 90, isPerSecond: false },
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 130, isPerSecond: false },
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_4K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_1K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 90, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 130, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_4K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 190, isPerSecond: false },

    // Images - Sem censura (SEM_CENSURA) — matches NB2 pricing, no 1K
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'SEM_CENSURA', creditsPerUnit: 130, isPerSecond: false },
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_4K', hasAudio: false, modelVariant: 'SEM_CENSURA', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'SEM_CENSURA', creditsPerUnit: 130, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_4K', hasAudio: false, modelVariant: 'SEM_CENSURA', creditsPerUnit: 190, isPerSecond: false },

    // Images - Nano Banana Pro (NBP) — v4 pricing
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_1K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_4K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 250, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_1K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_4K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 250, isPerSecond: false },

    // Motion Control (no model variant) — per second pricing
    { generationType: 'MOTION_CONTROL', resolution: 'RES_720P', hasAudio: false, modelVariant: null, creditsPerUnit: 70, isPerSecond: true },
    { generationType: 'MOTION_CONTROL', resolution: 'RES_1080P', hasAudio: false, modelVariant: null, creditsPerUnit: 100, isPerSecond: true },

    // The AI Model Lab Fast (THEAIMODELAB_FAST) — theaimodelab-provider — Text to Video
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 600, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_1080P', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 600, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 560, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 560, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_4K', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 1600, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 1120, isPerSecond: false },

    // The AI Model Lab Fast (THEAIMODELAB_FAST) — theaimodelab-provider — Image to Video
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 600, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_1080P', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 600, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 560, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 560, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_4K', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 1600, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 1120, isPerSecond: false },

    // The AI Model Lab Fast (THEAIMODELAB_FAST) — theaimodelab-provider — Reference Video
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 600, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_1080P', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 600, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 560, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 560, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_4K', hasAudio: false, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 1600, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'THEAIMODELAB_FAST', creditsPerUnit: 1120, isPerSecond: false },

    // The AI Model Lab Quality (THEAIMODELAB_QUALITY) — theaimodelab-provider — Text to Video
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1000, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_1080P', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1000, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1240, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1240, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_4K', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 2000, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1740, isPerSecond: false },

    // The AI Model Lab Quality (THEAIMODELAB_QUALITY) — theaimodelab-provider — Image to Video
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1000, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_1080P', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1000, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1240, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1240, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_4K', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 2000, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1740, isPerSecond: false },

    // The AI Model Lab Quality (THEAIMODELAB_QUALITY) — theaimodelab-provider — Reference Video
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1000, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_1080P', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1000, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1240, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1240, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_4K', hasAudio: false, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 2000, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'THEAIMODELAB_QUALITY', creditsPerUnit: 1740, isPerSecond: false },

    // Veo 3.1 Fast (VEO_FAST) — KIE API — always hasAudio=true — more expensive than The AI Model Lab
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 810, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 810, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 1610, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 810, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 810, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 1610, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 810, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 810, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'VEO_FAST', creditsPerUnit: 1610, isPerSecond: false },

    // Veo 3.1 Quality (VEO_MAX) — KIE API — always hasAudio=true — more expensive than The AI Model Lab
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 1800, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 1800, isPerSecond: false },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 2540, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 1800, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 1800, isPerSecond: false },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 2540, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_720P', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 1800, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_1080P', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 1800, isPerSecond: false },
    { generationType: 'REFERENCE_VIDEO', resolution: 'RES_4K', hasAudio: true, modelVariant: 'VEO_MAX', creditsPerUnit: 2540, isPerSecond: false },

    // Grok Imagine (GROK_IMAGINE) — KIE API — Fast mode (normal), no audio, duration 6-30s charged per second
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_480P', hasAudio: false, modelVariant: 'GROK_IMAGINE', creditsPerUnit: 40, isPerSecond: true },
    { generationType: 'IMAGE_TO_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'GROK_IMAGINE', creditsPerUnit: 80, isPerSecond: true },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_480P', hasAudio: false, modelVariant: 'GROK_IMAGINE', creditsPerUnit: 40, isPerSecond: true },
    { generationType: 'TEXT_TO_VIDEO', resolution: 'RES_720P', hasAudio: false, modelVariant: 'GROK_IMAGINE', creditsPerUnit: 80, isPerSecond: true },

    // Seedream Lite (SEEDREAM_LITE) — KIE API — 60cr basic (2K) / 80cr high (3K), T2I e I2I
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'SEEDREAM_LITE', creditsPerUnit: 60, isPerSecond: false },
    { generationType: 'TEXT_TO_IMAGE', resolution: 'RES_3K', hasAudio: false, modelVariant: 'SEEDREAM_LITE', creditsPerUnit: 80, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'SEEDREAM_LITE', creditsPerUnit: 60, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_3K', hasAudio: false, modelVariant: 'SEEDREAM_LITE', creditsPerUnit: 80, isPerSecond: false },

    // Deepdeep (DEEPDEEP) — n88ed API — image-to-image, resolução fixa (front manda RES_2K).
    // 250 créditos. Custo real US$0,10 (~R$0,567), margem ≥51% em todos os planos.
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_1K', hasAudio: false, modelVariant: 'DEEPDEEP', creditsPerUnit: 250, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_2K', hasAudio: false, modelVariant: 'DEEPDEEP', creditsPerUnit: 250, isPerSecond: false },
    { generationType: 'IMAGE_TO_IMAGE', resolution: 'RES_4K', hasAudio: false, modelVariant: 'DEEPDEEP', creditsPerUnit: 250, isPerSecond: false },

    // Virtual Try-On — NB2 (mirrors IMAGE_TO_IMAGE NB2 pricing)
    { generationType: 'VIRTUAL_TRY_ON', resolution: 'RES_1K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 90, isPerSecond: false },
    { generationType: 'VIRTUAL_TRY_ON', resolution: 'RES_2K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 130, isPerSecond: false },
    { generationType: 'VIRTUAL_TRY_ON', resolution: 'RES_4K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 190, isPerSecond: false },

    // Virtual Try-On — NBP (mirrors IMAGE_TO_IMAGE NBP pricing)
    { generationType: 'VIRTUAL_TRY_ON', resolution: 'RES_1K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'VIRTUAL_TRY_ON', resolution: 'RES_2K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 190, isPerSecond: false },
    { generationType: 'VIRTUAL_TRY_ON', resolution: 'RES_4K', hasAudio: false, modelVariant: 'NBP', creditsPerUnit: 250, isPerSecond: false },

    // Face Swap — NB2 (mirrors IMAGE_TO_IMAGE NB2 pricing)
    { generationType: 'FACE_SWAP', resolution: 'RES_1K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 90, isPerSecond: false },
    { generationType: 'FACE_SWAP', resolution: 'RES_2K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 130, isPerSecond: false },
    { generationType: 'FACE_SWAP', resolution: 'RES_4K', hasAudio: false, modelVariant: 'NB2', creditsPerUnit: 190, isPerSecond: false },
  ];

  // Deactivate all existing credit costs, then upsert new ones
  await prisma.creditCost.updateMany({ data: { isActive: false } });

  for (const cost of creditCosts) {
    // For nullable modelVariant in compound unique, we need to find-or-create manually
    const existing = await prisma.creditCost.findFirst({
      where: {
        generationType: cost.generationType as any,
        resolution: cost.resolution as any,
        hasAudio: cost.hasAudio,
        modelVariant: cost.modelVariant,
      },
    });

    if (existing) {
      await prisma.creditCost.update({
        where: { id: existing.id },
        data: {
          creditsPerUnit: cost.creditsPerUnit,
          isPerSecond: cost.isPerSecond,
          isActive: true,
        },
      });
    } else {
      await prisma.creditCost.create({
        data: cost as any,
      });
    }
  }

  console.log(`✅ Created ${creditCosts.length} credit costs`);

  // ============================================
  // Seed Credit Packages
  // ============================================
  console.log('📦 Creating credit packages...');

  const packageData = [
    // ── Pacotes de crédito avulsos convertidos dos antigos planos (checkout externo, sem Stripe) ──
    { name: 'Creator', update: { credits: 12000, priceCents: 8990, sortOrder: 0, isActive: true, checkoutUrl: CHECKOUT.creator || null, perfectpayPlanCode: PERFECTPAY.creator || null }, create: { name: 'Creator', credits: 12000, priceCents: 8990, sortOrder: 0, checkoutUrl: CHECKOUT.creator || null, perfectpayPlanCode: PERFECTPAY.creator || null } },
    { name: 'Pro', update: { credits: 30000, priceCents: 17990, sortOrder: 1, isActive: true, checkoutUrl: CHECKOUT.pro || null, perfectpayPlanCode: PERFECTPAY.pro || null }, create: { name: 'Pro', credits: 30000, priceCents: 17990, sortOrder: 1, checkoutUrl: CHECKOUT.pro || null, perfectpayPlanCode: PERFECTPAY.pro || null } },
    { name: 'Advanced', update: { credits: 50000, priceCents: 24990, sortOrder: 2, isActive: true, checkoutUrl: CHECKOUT.advanced || null, perfectpayPlanCode: PERFECTPAY.advanced || null }, create: { name: 'Advanced', credits: 50000, priceCents: 24990, sortOrder: 2, checkoutUrl: CHECKOUT.advanced || null, perfectpayPlanCode: PERFECTPAY.advanced || null } },
    { name: 'Studio', update: { credits: 80000, priceCents: 36990, sortOrder: 3, isActive: true, checkoutUrl: CHECKOUT.studio || null, perfectpayPlanCode: PERFECTPAY.studio || null }, create: { name: 'Studio', credits: 80000, priceCents: 36990, sortOrder: 3, checkoutUrl: CHECKOUT.studio || null, perfectpayPlanCode: PERFECTPAY.studio || null } },
    // ── Boost packages (desativados — substituídos pelos pacotes acima) ──
    { name: 'Boost P', update: { isActive: false, sortOrder: 80 }, create: { name: 'Boost P', credits: 550, priceCents: 1690, sortOrder: 80, isActive: false, stripePriceId: STRIPE.priceBoostP } },
    { name: 'Boost M', update: { isActive: false, sortOrder: 81 }, create: { name: 'Boost M', credits: 1700, priceCents: 2690, sortOrder: 81, isActive: false, stripePriceId: STRIPE.priceBoostM } },
    { name: 'Boost G', update: { isActive: false, sortOrder: 82 }, create: { name: 'Boost G', credits: 3200, priceCents: 3690, sortOrder: 82, isActive: false, stripePriceId: STRIPE.priceBoostG } },
    { name: 'Boost XG', update: { isActive: false, sortOrder: 83 }, create: { name: 'Boost XG', credits: 6500, priceCents: 6990, sortOrder: 83, isActive: false, stripePriceId: STRIPE.priceBoostXg } },
    { name: 'Boost XXG', update: { isActive: false, sortOrder: 84 }, create: { name: 'Boost XXG', credits: 14000, priceCents: 14990, sortOrder: 84, isActive: false, stripePriceId: STRIPE.priceBoostXxg } },
    // ── Pacotes convertidos dos planos v5 — desativados (fora da vitrine) ──
    { name: 'Ultra Basic', update: { isActive: false, sortOrder: 85 }, create: { name: 'Ultra Basic', credits: 700, priceCents: 1290, sortOrder: 85, isActive: false } },
    { name: 'Basic', update: { isActive: false, sortOrder: 86 }, create: { name: 'Basic', credits: 7000, priceCents: 5990, sortOrder: 86, isActive: false } },
    // Legacy packages (kept for backward compatibility, marked inactive)
    { name: 'Starter', update: { isActive: false, sortOrder: 90 }, create: { name: 'Starter', credits: 600, priceCents: 3900, sortOrder: 90, isActive: false } },
    { name: 'Pacote 500', update: { isActive: false }, create: { name: 'Pacote 500', credits: 500, priceCents: 1790, sortOrder: 94, isActive: false, stripePriceId: STRIPE.priceCredits500 } },
    { name: 'Pacote 1.000', update: { isActive: false }, create: { name: 'Pacote 1.000', credits: 1000, priceCents: 2990, sortOrder: 95, isActive: false, stripePriceId: STRIPE.priceCredits1000 } },
    { name: 'Pacote 5.000', update: { isActive: false }, create: { name: 'Pacote 5.000', credits: 5000, priceCents: 12990, sortOrder: 96, isActive: false, stripePriceId: STRIPE.priceCredits5000 } },
  ];

  const packages: CreditPackage[] = [];
  for (const pkg of packageData) {
    packages.push(
      await prisma.creditPackage.upsert({
        where: { name: pkg.name },
        update: pkg.update,
        create: pkg.create as any,
      }),
    );
  }

  console.log(`✅ Created ${packages.length} credit packages`);

  // ============================================
  // Seed Credit Package Prices (multi-currency)
  // ============================================
  console.log('💱 Creating credit package prices (multi-currency)...');

  const packagePriceData: Array<{ name: string; currency: string; priceCents: number; stripePriceId: string }> = [
    // BRL
    { name: 'Boost P', currency: 'BRL', priceCents: 1690, stripePriceId: STRIPE.priceBoostP },
    { name: 'Boost M', currency: 'BRL', priceCents: 2690, stripePriceId: STRIPE.priceBoostM },
    { name: 'Boost G', currency: 'BRL', priceCents: 3690, stripePriceId: STRIPE.priceBoostG },
    { name: 'Boost XG', currency: 'BRL', priceCents: 6990, stripePriceId: STRIPE.priceBoostXg },
    { name: 'Boost XXG', currency: 'BRL', priceCents: 14990, stripePriceId: STRIPE.priceBoostXxg },
    // USD
    { name: 'Boost P', currency: 'USD', priceCents: 390, stripePriceId: STRIPE.priceBoostPUsd },
    { name: 'Boost M', currency: 'USD', priceCents: 690, stripePriceId: STRIPE.priceBoostMUsd },
    { name: 'Boost G', currency: 'USD', priceCents: 990, stripePriceId: STRIPE.priceBoostGUsd },
    { name: 'Boost XG', currency: 'USD', priceCents: 1890, stripePriceId: STRIPE.priceBoostXgUsd },
    { name: 'Boost XXG', currency: 'USD', priceCents: 3990, stripePriceId: STRIPE.priceBoostXxgUsd },
    // EUR
    { name: 'Boost P', currency: 'EUR', priceCents: 390, stripePriceId: STRIPE.priceBoostPEur },
    { name: 'Boost M', currency: 'EUR', priceCents: 650, stripePriceId: STRIPE.priceBoostMEur },
    { name: 'Boost G', currency: 'EUR', priceCents: 890, stripePriceId: STRIPE.priceBoostGEur },
    { name: 'Boost XG', currency: 'EUR', priceCents: 1890, stripePriceId: STRIPE.priceBoostXgEur },
    { name: 'Boost XXG', currency: 'EUR', priceCents: 3990, stripePriceId: STRIPE.priceBoostXxgEur },
    // ── Pacotes convertidos dos planos (checkout externo CenterPag, sem Stripe) ──
    // BRL
    { name: 'Creator', currency: 'BRL', priceCents: 8990, stripePriceId: '' },
    { name: 'Pro', currency: 'BRL', priceCents: 17990, stripePriceId: '' },
    { name: 'Advanced', currency: 'BRL', priceCents: 24990, stripePriceId: '' },
    { name: 'Studio', currency: 'BRL', priceCents: 36990, stripePriceId: '' },
    // USD
    { name: 'Creator', currency: 'USD', priceCents: 1990, stripePriceId: '' },
    { name: 'Pro', currency: 'USD', priceCents: 3990, stripePriceId: '' },
    { name: 'Advanced', currency: 'USD', priceCents: 5490, stripePriceId: '' },
    { name: 'Studio', currency: 'USD', priceCents: 7990, stripePriceId: '' },
  ];

  const packagesByName = new Map(packages.map((p) => [p.name, p]));
  let packagePriceCount = 0;
  for (const pp of packagePriceData) {
    const pkg = packagesByName.get(pp.name);
    // Pacotes com checkout externo não têm stripePriceId — ainda assim precisam
    // da linha de preço por moeda (BRL/USD) para o valor correto ser resolvido.
    if (!pkg) continue;
    await prisma.creditPackagePrice.upsert({
      where: { creditPackageId_currency: { creditPackageId: pkg.id, currency: pp.currency } },
      update: { priceCents: pp.priceCents, stripePriceId: pp.stripePriceId, isActive: true },
      create: { creditPackageId: pkg.id, currency: pp.currency, priceCents: pp.priceCents, stripePriceId: pp.stripePriceId },
    });
    packagePriceCount++;
  }
  console.log(`✅ Created ${packagePriceCount} credit package prices`);

  // ============================================
  // Seed AI Models (video)
  // ============================================
  console.log('🎬 Creating AI video models...');

  const videoModels = [
    { slug: 'gemini-omni-video', label: 'Gemini Omni', provider: 'KIE' as const, modelVariant: 'GEMINI_OMNI', sortOrder: 0 },
    { slug: 'bytedance-seedance-2', label: 'Seedance 2', provider: 'KIE' as const, modelVariant: 'SEEDANCE_2', sortOrder: 1 },
    { slug: 'grok-imagine', label: 'Grok Imagine', provider: 'KIE' as const, modelVariant: 'GROK_IMAGINE', sortOrder: 2 },
    { slug: 'theaimodelab-quality', label: 'Veo 3.1 Quality', provider: 'THEAIMODELAB' as const, modelVariant: 'THEAIMODELAB_QUALITY', sortOrder: 3 },
    { slug: 'theaimodelab-fast', label: 'Veo 3.1 Fast', provider: 'THEAIMODELAB' as const, modelVariant: 'THEAIMODELAB_FAST', sortOrder: 4 },
    { slug: 'veo3', label: 'The AI Model Lab Quality', provider: 'KIE' as const, modelVariant: 'VEO_MAX', sortOrder: 5 },
    { slug: 'veo3_fast', label: 'The AI Model Lab Fast', provider: 'KIE' as const, modelVariant: 'VEO_FAST', sortOrder: 6 },
    {
      slug: 'avatar-video',
      label: 'Vídeo com avatar (HeyGen)',
      provider: 'HEYGEN' as const,
      modelVariant: 'heygen/avatar_iv+avatar_v',
      sortOrder: 101,
    },
    {
      slug: 'motion-control',
      label: 'Motion Control (Kling)',
      provider: 'KIE' as const,
      modelVariant: 'kling-2.6/motion-control',
      sortOrder: 102,
    },
  ];

  for (const model of videoModels) {
    await prisma.aiModel.upsert({
      where: { slug: model.slug },
      update: {}, // não sobrescrever se admin já togou
      create: {
        slug: model.slug,
        label: model.label,
        provider: model.provider,
        modelVariant: model.modelVariant,
        sortOrder: model.sortOrder,
        type: 'VIDEO',
        isActive: true,
      },
    });
  }

  console.log(`✅ Created ${videoModels.length} AI video models`);

  // ============================================
  // Seed AI Models (image)
  // ============================================
  console.log('🖼️  Creating AI image models...');

  const imageModels = [
    { slug: 'seedream-5-lite', label: 'Seedream Lite', provider: 'KIE' as const, modelVariant: 'SEEDREAM_LITE', sortOrder: 0 },
    { slug: 'sem-censura', label: 'The AI Model Lab Unlocked', provider: 'THEAIMODELAB' as const, modelVariant: 'SEM_CENSURA', sortOrder: 1 },
    { slug: 'deepdeep', label: 'DeepDeep', provider: 'KIE' as const, modelVariant: 'DEEPDEEP', sortOrder: 2 },
  ];

  for (const model of imageModels) {
    await prisma.aiModel.upsert({
      where: { slug: model.slug },
      update: {}, // não sobrescrever se admin já togou
      create: {
        slug: model.slug,
        label: model.label,
        provider: model.provider,
        modelVariant: model.modelVariant,
        sortOrder: model.sortOrder,
        type: 'IMAGE',
        isActive: true,
      },
    });
  }

  console.log(`✅ Created ${imageModels.length} AI image models`);

  // ============================================
  // Seed AI Models (audio)
  // ============================================
  console.log('🎙️  Creating AI audio models...');

  const audioModels = [
    {
      slug: 'audio-generation',
      label: 'Geração de áudio',
      description:
        'Gateway para geração de áudio (TTS Inworld 1.5 Max + clonagem OmniVoice). Desativar este modelo bloqueia todas as gerações de áudio temporariamente.',
      provider: 'WAVESPEED' as const,
      modelVariant: 'wavespeed/inworld+omnivoice',
      sortOrder: 100,
    },
  ];

  for (const model of audioModels) {
    await prisma.aiModel.upsert({
      where: { slug: model.slug },
      update: {}, // não sobrescrever se admin já togou
      create: {
        slug: model.slug,
        label: model.label,
        description: model.description,
        provider: model.provider,
        modelVariant: model.modelVariant,
        sortOrder: model.sortOrder,
        type: 'AUDIO',
        isActive: true,
      },
    });
  }

  console.log(`✅ Created ${audioModels.length} AI audio models`);

  // ============================================
  // Seed Test Users (Development only)
  // ============================================
  if (process.env.NODE_ENV === 'development') {
    console.log('👤 Creating test users...');

    // Admin user
    const adminUser = await prisma.user.upsert({
      where: { email: 'admin@theaimodelab.com' },
      update: {},
      create: {
        email: 'admin@theaimodelab.com',
        name: 'Admin User',
        passwordHash: await bcrypt.hash('admin123', 10),
        role: 'ADMIN',
        emailVerified: true,
      },
    });

    // Regular test users with different plans
    const testUsers = [
      { email: 'business@test.com', name: 'Business User', plan: 'business' },
    ];

    for (const userData of testUsers) {
      const user = await prisma.user.upsert({
        where: { email: userData.email },
        update: {},
        create: {
          email: userData.email,
          name: userData.name,
          passwordHash: await bcrypt.hash('password123', 10),
          role: 'USER',
          emailVerified: true,
        },
      });

      // Create subscription for the user
      const plan = plans.find(p => p.slug === userData.plan);
      if (plan) {
        const now = new Date();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + 1);

        await prisma.subscription.upsert({
          where: { id: (await prisma.subscription.findFirst({ where: { userId: user.id } }))?.id ?? '' },
          update: { planId: plan.id, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: endDate },
          create: {
            userId: user.id,
            planId: plan.id,
            status: 'ACTIVE',
            currentPeriodStart: now,
            currentPeriodEnd: endDate,
            paymentProvider: 'stripe',
          },
        });

        // Create credit balance
        await prisma.creditBalance.upsert({
          where: { userId: user.id },
          update: {
            planCreditsRemaining: plan.creditsPerMonth,
            planCreditsUsed: 0,
            periodStart: now,
            periodEnd: endDate,
          },
          create: {
            userId: user.id,
            planCreditsRemaining: plan.creditsPerMonth,
            bonusCreditsRemaining: 0,
            planCreditsUsed: 0,
            periodStart: now,
            periodEnd: endDate,
          },
        });

        // Create initial credit transaction
        await prisma.creditTransaction.create({
          data: {
            userId: user.id,
            type: 'SUBSCRIPTION_RENEWAL',
            amount: plan.creditsPerMonth,
            source: 'plan',
            description: `Initial ${plan.name} plan credits`,
          },
        });
      }
    }

    console.log(`✅ Created ${testUsers.length + 1} test users`);

    // Create some sample generations for the Pro user
    const proUser = await prisma.user.findUnique({
      where: { email: 'pro@test.com' },
    });

  }

  console.log('🎉 Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });