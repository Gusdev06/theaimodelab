-- ============================================
-- Cria a coluna checkout_url em credit_packages
-- e grava os links de checkout externo (CenterPag)
-- Idempotente: pode rodar mais de uma vez sem erro.
-- ============================================

-- 1. Cria a coluna (não falha se já existir)
ALTER TABLE "credit_packages" ADD COLUMN IF NOT EXISTS "checkout_url" TEXT;

-- 2. Grava os links nos 4 pacotes da vitrine
UPDATE "credit_packages" SET "checkout_url" = 'https://checkout.centerpag.com/pay/PPU38CQDQHP?' WHERE "name" = 'Creator';
UPDATE "credit_packages" SET "checkout_url" = 'https://checkout.centerpag.com/pay/PPU38CQDQID?' WHERE "name" = 'Pro';
UPDATE "credit_packages" SET "checkout_url" = 'https://checkout.centerpag.com/pay/PPU38CQDQIE?' WHERE "name" = 'Advanced';
UPDATE "credit_packages" SET "checkout_url" = 'https://checkout.centerpag.com/pay/PPU38CQDQIG?' WHERE "name" = 'Studio';
