-- GPT Image 2 credit costs (TEXT_TO_IMAGE + IMAGE_TO_IMAGE @ 1K/2K/4K)
-- Mirrors NB2 pricing: 90 / 130 / 190. Idempotent via unique (generation_type, resolution, has_audio, model_variant).
INSERT INTO credit_costs (id, generation_type, resolution, has_audio, model_variant, credits_per_unit, is_per_second, is_active)
VALUES
  (gen_random_uuid(), 'TEXT_TO_IMAGE',  'RES_1K', false, 'GPT_IMAGE_2', 90,  false, true),
  (gen_random_uuid(), 'TEXT_TO_IMAGE',  'RES_2K', false, 'GPT_IMAGE_2', 130, false, true),
  (gen_random_uuid(), 'TEXT_TO_IMAGE',  'RES_4K', false, 'GPT_IMAGE_2', 190, false, true),
  (gen_random_uuid(), 'IMAGE_TO_IMAGE', 'RES_1K', false, 'GPT_IMAGE_2', 90,  false, true),
  (gen_random_uuid(), 'IMAGE_TO_IMAGE', 'RES_2K', false, 'GPT_IMAGE_2', 130, false, true),
  (gen_random_uuid(), 'IMAGE_TO_IMAGE', 'RES_4K', false, 'GPT_IMAGE_2', 190, false, true)
ON CONFLICT (generation_type, resolution, has_audio, model_variant)
DO UPDATE SET credits_per_unit = EXCLUDED.credits_per_unit, is_active = true;
