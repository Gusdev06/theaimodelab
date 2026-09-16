-- Vitrine x vida do plano são coisas diferentes: is_active=false quebra a renovação
-- (o webhook da Perfect Pay só casa plano ativo). is_public=false só tira o plano da
-- vitrine (USD e BRL) — quem já assina continua renovando, fazendo upgrade e gerando.
ALTER TABLE "plans" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT true;

-- Creator sai da vitrine (decisão 2026-09-16): entrada passa a ser o Pro.
UPDATE "plans" SET "is_public" = false WHERE "slug" = 'creator';
