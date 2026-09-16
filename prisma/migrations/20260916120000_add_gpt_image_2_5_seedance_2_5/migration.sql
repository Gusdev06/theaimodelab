-- Modelos novos (KIE): GPT Image 2.5 (Flare) e Seedance 2.5. Só o enum de geração
-- grátis muda de schema; credit_costs/ai_models entram pelo seed.
ALTER TYPE "FreeGenerationType" ADD VALUE IF NOT EXISTS 'GPT_IMAGE_2_5';
ALTER TYPE "FreeGenerationType" ADD VALUE IF NOT EXISTS 'SEEDANCE_2_5';
