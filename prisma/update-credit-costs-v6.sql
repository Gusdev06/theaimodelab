-- Tabela de créditos v6 (2026-10-14) — correções achadas na auditoria de créditos (TKT-112).
-- NÃO é decisão comercial: são linhas que vendiam abaixo do custo real do provedor ou com a regra
-- da casa (créditos = custo_USD × 3333 ≈ 70% de margem no pior plano mensal) quebrada.
-- Espelha exatamente prisma/seed.ts (v6). NÃO toca planos, packs nem usuários.
-- Seedance 2.5 1080p NÃO está nesta tabela (preço hardcoded em plans.service.ts: 2.650 / 1.600 cr/s) —
-- sobe junto com o deploy da API, não com este SQL.
-- Cole no SQL Editor do Supabase e rode.

BEGIN;

-- ============================================
-- VÍDEOS — por segundo
-- ============================================

-- WaveSpeed Seedance 2.0 Fast Spicy (WAVESPEED_SEEDANCE_SPICY) — a WaveSpeed cobra o MESMO com ou sem áudio
-- (US$ 0,10/s 480p · 0,20/s 720p · 0,40/s 1080p). As linhas sem áudio cobravam metade (170/335/835) e vendiam
-- a ~40% de margem. Agora = linhas com áudio.
UPDATE theaimodelab.credit_costs SET credits_per_unit = 335  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_480P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 670  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_720P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 1670 WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND resolution = 'RES_1080P' AND has_audio = false;

-- Motion Control (Kling 2.6, sem model_variant) — kie cobra US$ 0,055/s (720p) e 0,09/s (1080p):
-- 100/155 cr/s davam 45% e 42% de margem. Agora 185/300 (= custo × 3333).
UPDATE theaimodelab.credit_costs SET credits_per_unit = 185 WHERE model_variant IS NULL AND generation_type = 'MOTION_CONTROL' AND resolution = 'RES_720P';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 300 WHERE model_variant IS NULL AND generation_type = 'MOTION_CONTROL' AND resolution = 'RES_1080P';

-- ============================================
-- VÍDEOS — por geração
-- ============================================

-- Veo 3.1 Quality (VEO_MAX, kie `veo3`) — kie cobra US$ 2,00 por vídeo de 8 s (400 cr). 4.260 cr equivalia a
-- US$ 1,28 de custo: abaixo do custo no plano anual. 4K extrapolado 2× (a kie não lista 4K).
UPDATE theaimodelab.credit_costs SET credits_per_unit = 6700  WHERE model_variant = 'VEO_MAX' AND resolution IN ('RES_720P','RES_1080P');
UPDATE theaimodelab.credit_costs SET credits_per_unit = 10000 WHERE model_variant = 'VEO_MAX' AND resolution = 'RES_4K';

-- Confere o resultado antes de dar COMMIT (11 linhas esperadas):
SELECT generation_type, resolution, has_audio, model_variant, credits_per_unit, is_per_second
FROM theaimodelab.credit_costs
WHERE is_active = true
  AND (
    (model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND has_audio = false)
    OR (model_variant IS NULL AND generation_type = 'MOTION_CONTROL')
    OR model_variant = 'VEO_MAX'
  )
ORDER BY model_variant NULLS FIRST, generation_type, resolution, has_audio;

COMMIT;
