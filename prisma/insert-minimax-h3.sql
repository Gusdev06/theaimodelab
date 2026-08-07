-- MiniMax H3 (WaveSpeed) — inserts para PRODUÇÃO (rodar no SQL Editor do Supabase antes do deploy).
-- O prisma/seed.ts é a fonte da verdade; este arquivo espelha as linhas novas para prod,
-- onde não rodamos o seed (que desativaria todas as outras credit_costs).
--
-- Modelo geral (não-NSFW), 3 modos (text/image/reference to video), áudio nativo sempre incluso.
-- Resoluções: 480p (RES_480P) e 768p (mapeado para RES_720P — evita migração do enum).
-- Custo real WaveSpeed: US$0,04/s (480p) e US$0,08/s (768p). créditos = custo_USD × 3333 → 135 / 270 cr/s.
--
-- Constraint única de credit_costs: (generation_type, resolution, has_audio, model_variant).

BEGIN;

-- ── credit_costs (6 linhas) ──────────────────────────────────
INSERT INTO theaimodelab.credit_costs
  (id, generation_type, resolution, has_audio, model_variant, credits_per_unit, is_per_second, is_active, created_at, updated_at)
VALUES
  (gen_random_uuid()::text, 'TEXT_TO_VIDEO',   'RES_480P', true, 'WAVESPEED_MINIMAX_H3', 135, true, true, now(), now()),
  (gen_random_uuid()::text, 'TEXT_TO_VIDEO',   'RES_720P', true, 'WAVESPEED_MINIMAX_H3', 270, true, true, now(), now()),
  (gen_random_uuid()::text, 'IMAGE_TO_VIDEO',  'RES_480P', true, 'WAVESPEED_MINIMAX_H3', 135, true, true, now(), now()),
  (gen_random_uuid()::text, 'IMAGE_TO_VIDEO',  'RES_720P', true, 'WAVESPEED_MINIMAX_H3', 270, true, true, now(), now()),
  (gen_random_uuid()::text, 'REFERENCE_VIDEO', 'RES_480P', true, 'WAVESPEED_MINIMAX_H3', 135, true, true, now(), now()),
  (gen_random_uuid()::text, 'REFERENCE_VIDEO', 'RES_720P', true, 'WAVESPEED_MINIMAX_H3', 270, true, true, now(), now())
ON CONFLICT (generation_type, resolution, has_audio, model_variant)
DO UPDATE SET credits_per_unit = EXCLUDED.credits_per_unit,
              is_per_second   = EXCLUDED.is_per_second,
              is_active       = true,
              updated_at      = now();

-- ── ai_models (1 linha) ──────────────────────────────────────
INSERT INTO theaimodelab.ai_models
  (id, slug, label, provider, type, model_variant, is_active, sort_order, created_at, updated_at)
VALUES
  (gen_random_uuid()::text, 'wavespeed-minimax-h3', 'MiniMax H3', 'WAVESPEED', 'VIDEO', 'WAVESPEED_MINIMAX_H3', true, 11, now(), now())
ON CONFLICT (slug)
DO UPDATE SET label = EXCLUDED.label,
              provider = EXCLUDED.provider,
              type = EXCLUDED.type,
              model_variant = EXCLUDED.model_variant,
              is_active = true,
              sort_order = EXCLUDED.sort_order,
              updated_at = now();

COMMIT;
