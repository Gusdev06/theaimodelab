-- ============================================================
-- DeepDeep — registro do modelo + custos de credito
-- Rodar UMA vez direto no banco. Idempotente (pode rodar de novo sem duplicar).
-- Schema: theaimodelab (o mesmo do DATABASE_URL ?schema=theaimodelab).
-- ============================================================

-- 1) Modelo em ai_models (usado pelo guard assertActiveBySlug + toggle admin).
--    SEM esta linha a API retorna: "O modelo deepdeep nao existe".
--    id e TEXT sem default no Postgres (cuid e gerado pelo Prisma), por isso informamos.
INSERT INTO theaimodelab.ai_models
  (id, slug, label, description, provider, type, model_variant, is_active, sort_order, created_at, updated_at)
VALUES
  ('aimodel_deepdeep', 'deepdeep', 'DeepDeep',
   'Transformacao image-to-image (API n88ed). Exposto no frontend como ferramenta.',
   'KIE', 'IMAGE', 'DEEPDEEP', true, 2, now(), now())
ON CONFLICT (slug) DO NOTHING;

-- 2) Custos de credito para o variant DEEPDEEP (somente IMAGE_TO_IMAGE).
--    250 creditos por geracao. Resolucao e fixa (o front manda sempre RES_2K);
--    mantemos as tres linhas so por robustez, todas no mesmo preco.
--    Custo real: US$0,10 (~R$0,567). Margem >=51% em todos os planos.
INSERT INTO theaimodelab.credit_costs
  (id, generation_type, resolution, has_audio, model_variant, credits_per_unit, is_per_second, is_active, created_at, updated_at)
VALUES
  ('cc_deepdeep_i2i_1k', 'IMAGE_TO_IMAGE', 'RES_1K', false, 'DEEPDEEP', 250, false, true, now(), now()),
  ('cc_deepdeep_i2i_2k', 'IMAGE_TO_IMAGE', 'RES_2K', false, 'DEEPDEEP', 250, false, true, now(), now()),
  ('cc_deepdeep_i2i_4k', 'IMAGE_TO_IMAGE', 'RES_4K', false, 'DEEPDEEP', 250, false, true, now(), now())
ON CONFLICT (generation_type, resolution, has_audio, model_variant) DO UPDATE
  SET credits_per_unit = EXCLUDED.credits_per_unit,
      is_active        = true,
      updated_at       = now();

-- 3) Conferir
SELECT slug, label, provider, type, model_variant, is_active
  FROM theaimodelab.ai_models WHERE slug = 'deepdeep';

SELECT generation_type, resolution, model_variant, credits_per_unit, is_active
  FROM theaimodelab.credit_costs WHERE model_variant = 'DEEPDEEP'
  ORDER BY resolution;
