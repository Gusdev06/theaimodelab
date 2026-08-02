-- ============================================================================
-- Pacotes de crédito avulsos em BRL via Cakto — alteração cirúrgica, sem
-- `prisma migrate` / `seed`. Tabelas no schema "theaimodelab".
-- Idempotente: pode rodar mais de uma vez sem duplicar nada.
--
-- IMPORTANTE: os `cakto_offer_code` abaixo estão como NULL (placeholder). Rode
--   `npx ts-node scripts/cakto-create-credit-packages.ts`
-- para criar o produto + as 5 ofertas na Cakto; o script imprime os offerIds e o
-- bloco UPDATE final desta migration já preenchido. Enquanto o offer code estiver
-- NULL, o endpoint NÃO retorna o pacote em BRL (o front esconde a seção) e o
-- webhook não casa a venda.
--
-- Preços BRL (âncora acima do câmbio, terminando em ,90 — padrão dos planos):
--   Plus  R$24,90 | Turbo R$59,90 | Mega R$109,90 | Ultra R$199,90 | Max R$429,90
-- ============================================================================
BEGIN;

-- 1) Colunas novas ----------------------------------------------------------
ALTER TABLE "theaimodelab"."credit_packages"       ADD COLUMN IF NOT EXISTS "cakto_offer_code" TEXT;
ALTER TABLE "theaimodelab"."credit_package_prices" ADD COLUMN IF NOT EXISTS "checkout_url"     TEXT;

-- 2) Preço BRL por pacote (upsert) ------------------------------------------
--    price_cents em centavos de BRL; is_active=true habilita o pacote em BRL.
--    stripe_price_id fica '' (Cakto não usa Stripe); id/updated_at gerados aqui
--    porque no schema Prisma são preenchidos pela aplicação (sem default no banco).
--    checkout_url fica NULL até o script Cakto rodar (passo 4).
INSERT INTO "theaimodelab"."credit_package_prices"
  ("id", "credit_package_id", "currency", "price_cents", "stripe_price_id", "is_active", "checkout_url", "created_at", "updated_at")
SELECT gen_random_uuid()::text, cp."id", 'BRL', v.cents, '', true, NULL, now(), now()
FROM (VALUES
  ('Plus',   2490),
  ('Turbo',  5990),
  ('Mega',  10990),
  ('Ultra', 19990),
  ('Max',   42990)
) AS v(name, cents)
JOIN "theaimodelab"."credit_packages" cp ON cp."name" = v.name
ON CONFLICT ("credit_package_id", "currency") DO UPDATE
SET "price_cents" = EXCLUDED."price_cents",
    "is_active"   = true,
    "updated_at"  = now();
    -- stripe_price_id e checkout_url NÃO são tocados no update: preservam o que já existir.

-- 3) Marca as migrations Prisma como aplicadas, pra um futuro `prisma migrate
--    deploy` não tentar recriar as colunas/tabela e falhar.
INSERT INTO "theaimodelab"."_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
SELECT gen_random_uuid()::text,
       '2a047a6a969f2b76b6259fb4e9fa35a2d08c528e527e3b4f60b657ca82e9d686',
       now(), '20260801020000_add_credit_package_cakto', now(), 1
WHERE NOT EXISTS (
  SELECT 1 FROM "theaimodelab"."_prisma_migrations" WHERE "migration_name" = '20260801020000_add_credit_package_cakto'
);

INSERT INTO "theaimodelab"."_prisma_migrations"
  ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
SELECT gen_random_uuid()::text,
       'e676bb390745be8277b858d49475c4eacc11cf0252a8646cdc9541ae90c695c3',
       now(), '20260801030000_add_analytics_events', now(), 1
WHERE NOT EXISTS (
  SELECT 1 FROM "theaimodelab"."_prisma_migrations" WHERE "migration_name" = '20260801030000_add_analytics_events'
);

-- 4) Tabela analytics_events (POST /api/v1/analytics/events) -----------------
CREATE TABLE IF NOT EXISTS "theaimodelab"."analytics_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "event_name" TEXT NOT NULL,
    "action" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "analytics_events_user_id_idx" ON "theaimodelab"."analytics_events"("user_id");
CREATE INDEX IF NOT EXISTS "analytics_events_created_at_idx" ON "theaimodelab"."analytics_events"("created_at");
CREATE INDEX IF NOT EXISTS "analytics_events_event_name_created_at_idx" ON "theaimodelab"."analytics_events"("event_name", "created_at");

COMMIT;

-- ---------------------------------------------------------------------------
-- 5) DEPOIS de rodar o script Cakto (scripts/cakto-create-credit-packages.ts),
--    preencha os offer codes + checkout_url. O script imprime este bloco pronto.
--    Exemplo (substitua os <offerId> reais):
--
--   BEGIN;
--   UPDATE "theaimodelab"."credit_packages" AS cp
--   SET    "cakto_offer_code" = v.offer
--   FROM (VALUES
--     ('Plus',  '<offerId_plus>'),
--     ('Turbo', '<offerId_turbo>'),
--     ('Mega',  '<offerId_mega>'),
--     ('Ultra', '<offerId_ultra>'),
--     ('Max',   '<offerId_max>')
--   ) AS v(name, offer)
--   WHERE cp."name" = v.name;
--
--   UPDATE "theaimodelab"."credit_package_prices" AS pp
--   SET    "checkout_url" = 'https://pay.cakto.com.br/' || v.offer
--   FROM (VALUES
--     ('Plus',  '<offerId_plus>'),
--     ('Turbo', '<offerId_turbo>'),
--     ('Mega',  '<offerId_mega>'),
--     ('Ultra', '<offerId_ultra>'),
--     ('Max',   '<offerId_max>')
--   ) AS v(name, offer)
--   JOIN "theaimodelab"."credit_packages" cp ON cp."name" = v.name
--   WHERE pp."credit_package_id" = cp."id" AND pp."currency" = 'BRL';
--   COMMIT;
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Conferência (rode depois; deve listar os 5 pacotes com preço BRL):
--   SELECT cp.name, cp.cakto_offer_code, pp.price_cents, pp.is_active, pp.checkout_url
--   FROM "theaimodelab"."credit_package_prices" pp
--   JOIN "theaimodelab"."credit_packages" cp ON cp.id = pp.credit_package_id
--   WHERE pp.currency = 'BRL' ORDER BY cp.sort_order;
-- ---------------------------------------------------------------------------
