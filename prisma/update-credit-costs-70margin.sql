-- Ajuste de theaimodelab.credit_costs para ~70% de margem no PIOR plano (Studio, ~$0,001/cr).
-- Fórmula base: credits = custo_USD * 3333 (antes era * 2000 = ~50%).
-- Modelos com custo de provedor não documentado (THEAIMODELAB_FAST/QUALITY, SEEDREAM_LITE, GROK_IMAGINE)
--   receberam bump proporcional de +67% (v4→v5) para acompanhar as demais famílias.
-- NÃO toca planos/usuários. Espelha exatamente prisma/seed.ts (v5).
-- Gemini Omni e Bytedance Seedance 2.0 NÃO estão nesta tabela (preço hardcoded em plans.service.ts) — já ajustados no código.
-- Cole no SQL Editor do Supabase e rode.

BEGIN;

-- ============================================
-- IMAGENS
-- ============================================

-- Nano Banana 2 (NB2) — 1K/2K/4K, T2I e I2I
UPDATE theaimodelab.credit_costs SET credits_per_unit = 135 WHERE model_variant = 'NB2' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_1K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'NB2' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_2K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant = 'NB2' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_4K';

-- Sem censura (SEM_CENSURA) — espelha NB2 (sem 1K)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'SEM_CENSURA' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_2K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant = 'SEM_CENSURA' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_4K';

-- GPT Image 2 (GPT_IMAGE_2) — espelha NB2
UPDATE theaimodelab.credit_costs SET credits_per_unit = 135 WHERE model_variant = 'GPT_IMAGE_2' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_1K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'GPT_IMAGE_2' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_2K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant = 'GPT_IMAGE_2' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_4K';

-- Nano Banana Pro (NBP) — 1K/2K = 300, 4K = 400
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant = 'NBP' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution IN ('RES_1K','RES_2K');
UPDATE theaimodelab.credit_costs SET credits_per_unit = 400 WHERE model_variant = 'NBP' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_4K';

-- Seedream Lite (SEEDREAM_LITE) — bump +67% (custo não documentado)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 100 WHERE model_variant = 'SEEDREAM_LITE' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_2K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 135 WHERE model_variant = 'SEEDREAM_LITE' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_3K';

-- Deepdeep (DEEPDEEP) — custo fixo $0,10 → 335 cr
UPDATE theaimodelab.credit_costs SET credits_per_unit = 335 WHERE model_variant = 'DEEPDEEP' AND generation_type = 'IMAGE_TO_IMAGE';

-- Virtual Try-On — NB2 (espelha I2I NB2)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 135 WHERE model_variant = 'NB2' AND generation_type = 'VIRTUAL_TRY_ON' AND resolution = 'RES_1K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'NB2' AND generation_type = 'VIRTUAL_TRY_ON' AND resolution = 'RES_2K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant = 'NB2' AND generation_type = 'VIRTUAL_TRY_ON' AND resolution = 'RES_4K';

-- Virtual Try-On — NBP (espelha I2I NBP)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant = 'NBP' AND generation_type = 'VIRTUAL_TRY_ON' AND resolution IN ('RES_1K','RES_2K');
UPDATE theaimodelab.credit_costs SET credits_per_unit = 400 WHERE model_variant = 'NBP' AND generation_type = 'VIRTUAL_TRY_ON' AND resolution = 'RES_4K';

-- Face Swap — NB2 (espelha I2I NB2)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 135 WHERE model_variant = 'NB2' AND generation_type = 'FACE_SWAP' AND resolution = 'RES_1K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'NB2' AND generation_type = 'FACE_SWAP' AND resolution = 'RES_2K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant = 'NB2' AND generation_type = 'FACE_SWAP' AND resolution = 'RES_4K';

-- ============================================
-- VÍDEOS — por geração
-- ============================================

-- The AI Model Lab Fast (THEAIMODELAB_FAST) — bump +67% (custo não documentado) — T2V, I2V, REF
UPDATE theaimodelab.credit_costs SET credits_per_unit = 1000 WHERE model_variant = 'THEAIMODELAB_FAST' AND resolution IN ('RES_720P','RES_1080P') AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 935  WHERE model_variant = 'THEAIMODELAB_FAST' AND resolution IN ('RES_720P','RES_1080P') AND has_audio = true;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 2665 WHERE model_variant = 'THEAIMODELAB_FAST' AND resolution = 'RES_4K' AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 1865 WHERE model_variant = 'THEAIMODELAB_FAST' AND resolution = 'RES_4K' AND has_audio = true;

-- The AI Model Lab Quality (THEAIMODELAB_QUALITY) — bump +67% (custo não documentado) — T2V, I2V, REF
UPDATE theaimodelab.credit_costs SET credits_per_unit = 1665 WHERE model_variant = 'THEAIMODELAB_QUALITY' AND resolution IN ('RES_720P','RES_1080P') AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 2065 WHERE model_variant = 'THEAIMODELAB_QUALITY' AND resolution IN ('RES_720P','RES_1080P') AND has_audio = true;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 3335 WHERE model_variant = 'THEAIMODELAB_QUALITY' AND resolution = 'RES_4K' AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 2900 WHERE model_variant = 'THEAIMODELAB_QUALITY' AND resolution = 'RES_4K' AND has_audio = true;

-- Veo 3.1 Fast (VEO_FAST) — KIE, ×3333 — T2V, I2V, REF
UPDATE theaimodelab.credit_costs SET credits_per_unit = 1920 WHERE model_variant = 'VEO_FAST' AND resolution IN ('RES_720P','RES_1080P');
UPDATE theaimodelab.credit_costs SET credits_per_unit = 3810 WHERE model_variant = 'VEO_FAST' AND resolution = 'RES_4K';

-- Veo 3.1 Quality (VEO_MAX) — KIE, ×3333 — T2V, I2V, REF
UPDATE theaimodelab.credit_costs SET credits_per_unit = 4260 WHERE model_variant = 'VEO_MAX' AND resolution IN ('RES_720P','RES_1080P');
UPDATE theaimodelab.credit_costs SET credits_per_unit = 6010 WHERE model_variant = 'VEO_MAX' AND resolution = 'RES_4K';

-- ============================================
-- VÍDEOS — por segundo
-- ============================================

-- Motion Control (Kling 2.6) — sem model_variant
UPDATE theaimodelab.credit_costs SET credits_per_unit = 100 WHERE model_variant IS NULL AND generation_type = 'MOTION_CONTROL' AND resolution = 'RES_720P';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 155 WHERE model_variant IS NULL AND generation_type = 'MOTION_CONTROL' AND resolution = 'RES_1080P';

-- Grok Imagine (GROK_IMAGINE) — bump +67% (custo não documentado)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 67  WHERE model_variant = 'GROK_IMAGINE' AND resolution = 'RES_480P';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 135 WHERE model_variant = 'GROK_IMAGINE' AND resolution = 'RES_720P';

-- Kling V3 Turbo (KLING_V3_TURBO) — $0,11/$0,14 por s → 370/470 cr/s
UPDATE theaimodelab.credit_costs SET credits_per_unit = 370 WHERE model_variant = 'KLING_V3_TURBO' AND resolution = 'RES_720P';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 470 WHERE model_variant = 'KLING_V3_TURBO' AND resolution = 'RES_1080P';

-- ComfyDeploy WAN (COMFYDEPLOY_WAN) — $0,06/s → 200 cr/s
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'COMFYDEPLOY_WAN' AND resolution IN ('RES_480P','RES_720P');

-- WaveSpeed LTX 2.3 Spicy (WAVESPEED_LTX_SPICY)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 70  WHERE model_variant = 'WAVESPEED_LTX_SPICY' AND resolution = 'RES_480P';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 135 WHERE model_variant = 'WAVESPEED_LTX_SPICY' AND resolution = 'RES_720P';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'WAVESPEED_LTX_SPICY' AND resolution = 'RES_1080P';

-- WaveSpeed Seedance 2.0 Fast Spicy (WAVESPEED_SEEDANCE_SPICY)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 335  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_480P'  AND has_audio = true;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 670  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_720P'  AND has_audio = true;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 1670 WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_1080P' AND has_audio = true;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 170  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_480P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 335  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_720P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 835  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_1080P' AND has_audio = false;

-- Confere o resultado antes de dar COMMIT:
SELECT model_variant, generation_type, resolution, has_audio, credits_per_unit, is_per_second
FROM theaimodelab.credit_costs
WHERE is_active = true
ORDER BY model_variant, generation_type, resolution, has_audio;

COMMIT;
