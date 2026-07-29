-- ============================================================================
-- Integração Cakto (BRL) — alteração cirúrgica, sem `prisma migrate` / `seed`.
-- Tabelas no schema "theaimodelab" (DATABASE_URL ?schema=theaimodelab).
-- Idempotente: pode rodar mais de uma vez sem duplicar nada.
-- ============================================================================
BEGIN;

-- 1) Colunas novas ----------------------------------------------------------
ALTER TABLE "theaimodelab"."plans"       ADD COLUMN IF NOT EXISTS "cakto_offer_code" TEXT;
ALTER TABLE "theaimodelab"."plan_prices" ADD COLUMN IF NOT EXISTS "checkout_url"     TEXT;

-- 2) Offer code da Cakto em cada plano (casa a venda no webhook) -------------
UPDATE "theaimodelab"."plans" AS p
SET    "cakto_offer_code" = v.offer
FROM (VALUES
  ('ultra-basic', '3bs2w2w'),
  ('starter',     '6y427as'),
  ('basic',       'uxrhbdr'),
  ('creator',     'sdqeha6'),
  ('pro',         '372vqec'),
  ('advanced',    'ooy9qkc'),
  ('studio',      '3a7idye')
) AS v(slug, offer)
WHERE p."slug" = v.slug;

-- 3) Preço BRL + link de checkout Cakto por plano (upsert) ------------------
--    price_cents em centavos; is_active=true habilita o plano na vitrine /pt-br.
--    stripe_price_id fica '' (Cakto não usa Stripe); id/updated_at gerados aqui
--    porque no schema Prisma são preenchidos pela aplicação (sem default no banco).
INSERT INTO "theaimodelab"."plan_prices"
  ("id", "plan_id", "currency", "price_cents", "stripe_price_id", "is_active", "checkout_url", "created_at", "updated_at")
SELECT gen_random_uuid()::text, p."id", 'BRL', v.cents, '', true,
       'https://pay.cakto.com.br/' || v.offer, now(), now()
FROM (VALUES
  ('ultra-basic',  1290, '3bs2w2w'),
  ('starter',      3990, '6y427as'),
  ('basic',        5990, 'uxrhbdr'),
  ('creator',      8990, 'sdqeha6'),
  ('pro',         17990, '372vqec'),
  ('advanced',    24990, 'ooy9qkc'),
  ('studio',      36990, '3a7idye')
) AS v(slug, cents, offer)
JOIN "theaimodelab"."plans" p ON p."slug" = v.slug
ON CONFLICT ("plan_id", "currency") DO UPDATE
SET "price_cents"  = EXCLUDED."price_cents",
    "checkout_url" = EXCLUDED."checkout_url",
    "is_active"    = true,
    "updated_at"   = now();
    -- stripe_price_id NÃO é tocado no update: preserva o que já existir.

-- 4) (Opcional, recomendado) Marca a migration como aplicada, pra um futuro
--    `prisma migrate deploy` não tentar recriar as colunas e falhar.
INSERT INTO "theaimodelab"."_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
SELECT gen_random_uuid()::text,
       '2e29563da1eb32b2087a6e0c46addf1af32b440602f14375fe34664e3a5af2d1',
       now(), '20260729120000_add_cakto_integration', now(), 1
WHERE NOT EXISTS (
  SELECT 1 FROM "theaimodelab"."_prisma_migrations" WHERE "migration_name" = '20260729120000_add_cakto_integration'
);

COMMIT;

-- ---------------------------------------------------------------------------
-- Conferência (rode depois; deve listar os 7 planos com preço BRL e link Cakto):
--   SELECT p.slug, p.cakto_offer_code, pp.price_cents, pp.is_active, pp.checkout_url
--   FROM "theaimodelab"."plan_prices" pp
--   JOIN "theaimodelab"."plans" p ON p.id = pp.plan_id
--   WHERE pp.currency = 'BRL' ORDER BY p.sort_order;
-- ---------------------------------------------------------------------------
