-- ==========================================================
-- Reconfiguração completa da vitrine de pacotes de crédito
-- Schema: theaimodelab  (Supabase)
-- Idempotente: pode rodar mais de uma vez.
--   1. cria a coluna checkout_url
--   2. cria/atualiza os 4 pacotes ativos (Creator, Pro, Advanced, Studio)
--   3. desativa qualquer outro pacote (Boost, Ultra Basic, Basic, legados...)
-- ==========================================================

-- 1. Coluna checkout_url (não falha se já existir)
ALTER TABLE "theaimodelab"."credit_packages"
  ADD COLUMN IF NOT EXISTS "checkout_url" TEXT;

-- 2. Upsert dos 4 pacotes da vitrine (por "name", que é UNIQUE)
INSERT INTO "theaimodelab"."credit_packages"
  ("id", "name", "credits", "price_cents", "is_active", "sort_order", "checkout_url")
VALUES
  (gen_random_uuid()::text, 'Creator',  12000,  8990, true, 0, 'https://checkout.centerpag.com/pay/PPU38CQDQHP?'),
  (gen_random_uuid()::text, 'Pro',      30000, 17990, true, 1, 'https://checkout.centerpag.com/pay/PPU38CQDQID?'),
  (gen_random_uuid()::text, 'Advanced', 50000, 24990, true, 2, 'https://checkout.centerpag.com/pay/PPU38CQDQIE?'),
  (gen_random_uuid()::text, 'Studio',   80000, 36990, true, 3, 'https://checkout.centerpag.com/pay/PPU38CQDQIG?')
ON CONFLICT ("name") DO UPDATE SET
  "credits"      = EXCLUDED."credits",
  "price_cents"  = EXCLUDED."price_cents",
  "is_active"    = EXCLUDED."is_active",
  "sort_order"   = EXCLUDED."sort_order",
  "checkout_url" = EXCLUDED."checkout_url";

-- 3. Desativa todos os outros pacotes (fora da vitrine)
UPDATE "theaimodelab"."credit_packages"
  SET "is_active" = false
  WHERE "name" NOT IN ('Creator', 'Pro', 'Advanced', 'Studio');

-- Conferência (opcional)
-- SELECT name, credits, price_cents, is_active, sort_order, checkout_url
-- FROM "theaimodelab"."credit_packages" ORDER BY is_active DESC, sort_order;
