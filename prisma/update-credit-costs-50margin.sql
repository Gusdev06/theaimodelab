-- Ajuste de theaimodelab.credit_costs para ~50% de margem no PIOR plano (Studio, ~$0,001/cr).
-- Fórmula: credits = custo_USD * 2000.
-- Aplica só nas 5 famílias com custo real documentado. NÃO toca planos/usuários.
-- Cole no SQL Editor do Supabase e rode.

BEGIN;

-- LTX 2.3 Spicy (WAVESPEED_LTX_SPICY) — IMAGE_TO_VIDEO, sem áudio
UPDATE theaimodelab.credit_costs SET credits_per_unit = 40  WHERE model_variant = 'WAVESPEED_LTX_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_480P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 80  WHERE model_variant = 'WAVESPEED_LTX_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_720P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 120 WHERE model_variant = 'WAVESPEED_LTX_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_1080P' AND has_audio = false;

-- ComfyDeploy WAN (COMFYDEPLOY_WAN) — IMAGE_TO_VIDEO, sem áudio ($0,06/s)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 120 WHERE model_variant = 'COMFYDEPLOY_WAN' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution IN ('RES_480P','RES_720P') AND has_audio = false;

-- Seedance 2.0 Fast Spicy (WAVESPEED_SEEDANCE_SPICY) — IMAGE_TO_VIDEO
-- Áudio ON: $0,10 / $0,20 / $0,50 por s
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_480P'  AND has_audio = true;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 400  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_720P'  AND has_audio = true;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 1000 WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_1080P' AND has_audio = true;
-- Áudio OFF: metade do custo
UPDATE theaimodelab.credit_costs SET credits_per_unit = 100  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_480P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_720P'  AND has_audio = false;
UPDATE theaimodelab.credit_costs SET credits_per_unit = 500  WHERE model_variant = 'WAVESPEED_SEEDANCE_SPICY' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_1080P' AND has_audio = false;

-- Kling V3 Turbo (KLING_V3_TURBO) — IMAGE_TO_VIDEO ($0,11/s 720p, $0,14/s 1080p; áudio grátis)
UPDATE theaimodelab.credit_costs SET credits_per_unit = 220 WHERE model_variant = 'KLING_V3_TURBO' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_720P';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 280 WHERE model_variant = 'KLING_V3_TURBO' AND generation_type = 'IMAGE_TO_VIDEO' AND resolution = 'RES_1080P';

-- Deepdeep (DEEPDEEP) — IMAGE_TO_IMAGE, custo fixo $0,10
UPDATE theaimodelab.credit_costs SET credits_per_unit = 200 WHERE model_variant = 'DEEPDEEP' AND generation_type = 'IMAGE_TO_IMAGE';

-- Confere o resultado antes de dar COMMIT:
SELECT model_variant, generation_type, resolution, has_audio, credits_per_unit, is_per_second
FROM theaimodelab.credit_costs
WHERE model_variant IN ('WAVESPEED_LTX_SPICY','COMFYDEPLOY_WAN','WAVESPEED_SEEDANCE_SPICY','KLING_V3_TURBO','DEEPDEEP')
ORDER BY model_variant, generation_type, resolution, has_audio;

COMMIT;
