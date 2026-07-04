-- ==========================================================
-- Reconfiguração completa da vitrine de pacotes de crédito
-- Schema: theaimodelab  (Supabase)
-- Idempotente: pode rodar mais de uma vez.
--   1. cria a coluna checkout_url
--   2. cria/atualiza os 4 pacotes ativos (Creator, Pro, Advanced, Studio)
--   3. desativa qualquer outro pacote (Boost, Ultra Basic, Basic, legados...)
--   4. grava os preços por moeda (BRL/USD) dos 4 pacotes
-- ==========================================================

-- 1. Colunas checkout_url e perfectpay_plan_code (não falham se já existirem)
ALTER TABLE "theaimodelab"."credit_packages"
  ADD COLUMN IF NOT EXISTS "checkout_url" TEXT;
ALTER TABLE "theaimodelab"."credit_packages"
  ADD COLUMN IF NOT EXISTS "perfectpay_plan_code" TEXT;

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

-- 4. Preços por moeda (BRL/USD). Sem esta parte, USD cai no fallback e mostra o valor de BRL.
INSERT INTO "theaimodelab"."credit_package_prices"
  ("id", "credit_package_id", "currency", "price_cents", "stripe_price_id", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid()::text, cp."id", v.currency, v.price_cents, '', true, now(), now()
FROM (VALUES
  ('Creator',  'BRL',  8990),
  ('Creator',  'USD',  1990),
  ('Pro',      'BRL', 17990),
  ('Pro',      'USD',  3990),
  ('Advanced', 'BRL', 24990),
  ('Advanced', 'USD',  5490),
  ('Studio',   'BRL', 36990),
  ('Studio',   'USD',  7990)
) AS v("name", currency, price_cents)
JOIN "theaimodelab"."credit_packages" cp ON cp."name" = v."name"
ON CONFLICT ("credit_package_id", "currency") DO UPDATE SET
  "price_cents" = EXCLUDED."price_cents",
  "is_active"   = true,
  "updated_at"  = now();

-- 5. Códigos de PLANO da Perfect Pay (mapeiam o postback → pacote).
--    O produto é único (PPPBEKMJ); cada pacote é um "plano" cujo código aparece
--    no final do link de checkout (.../pay/<CODE>).
UPDATE "theaimodelab"."credit_packages" SET "perfectpay_plan_code" = 'PPU38CQDQHP' WHERE "name" = 'Creator';
UPDATE "theaimodelab"."credit_packages" SET "perfectpay_plan_code" = 'PPU38CQDQID' WHERE "name" = 'Pro';
UPDATE "theaimodelab"."credit_packages" SET "perfectpay_plan_code" = 'PPU38CQDQIE' WHERE "name" = 'Advanced';
UPDATE "theaimodelab"."credit_packages" SET "perfectpay_plan_code" = 'PPU38CQDQIG' WHERE "name" = 'Studio';

-- Conferência (opcional)
-- SELECT cp.name, cp.credits, cp.is_active, cp.checkout_url, cp.perfectpay_plan_code,
--        pp.currency, pp.price_cents
-- FROM "theaimodelab"."credit_packages" cp
-- LEFT JOIN "theaimodelab"."credit_package_prices" pp ON pp.credit_package_id = cp.id
-- WHERE cp.is_active ORDER BY cp.sort_order, pp.currency;
