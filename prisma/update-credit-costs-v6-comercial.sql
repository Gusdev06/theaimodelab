-- OPCIONAL — decisão comercial do dono (NÃO rodar junto com o v6 sem o OK dele).
-- Unlocked (SEM_CENSURA) 2K/4K: 200/300 → 250/375 cr (+25%). Custo real misto ~US$ 0,08 (2K) / 0,12 (4K):
-- hoje a margem no pior plano mensal é 60% (38% de todo o consumo); 250/375 leva a 68%.
-- Avisar os clientes 7 dias antes (e-mail + faixa na Início) e atualizar `creditsFrom` no guia de modelos do site.
-- Seed: ao aplicar, trocar as 4 linhas SEM_CENSURA em prisma/seed.ts (200 → 250, 300 → 375).

BEGIN;

UPDATE theaimodelab.credit_costs SET credits_per_unit = 250 WHERE model_variant = 'SEM_CENSURA' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_2K';
UPDATE theaimodelab.credit_costs SET credits_per_unit = 375 WHERE model_variant = 'SEM_CENSURA' AND generation_type IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE') AND resolution = 'RES_4K';

SELECT generation_type, resolution, model_variant, credits_per_unit
FROM theaimodelab.credit_costs
WHERE is_active = true AND model_variant = 'SEM_CENSURA'
ORDER BY generation_type, resolution;

COMMIT;
