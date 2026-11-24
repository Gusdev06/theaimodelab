-- ============================================================================
-- candy-vitrine (24/11/2026): planos novos do clone das mecânicas de venda da Candy.ai
--   L03 creator-entrada    (1º mês US$ 14,90 / R$ 69,90; renova no Creator cheio)
--   L13 creator-trimestral (US$ 44,90 / R$ 219,90 a cada 3 meses, créditos mês a mês)
--   L13 pro-trimestral     (US$ 89,90 / R$ 489,90 a cada 3 meses, créditos mês a mês)
--   L21 creator-28d / pro-28d (preço do mensal, cobrado a cada 28 dias)
--
-- Só DADOS (nenhuma tabela/coluna nova): billing_interval é TEXT livre.
-- Sem `prisma migrate`. Tabelas no schema "theaimodelab". Idempotente (ON CONFLICT DO NOTHING).
-- Fluxo da casa: diff-codigo.sh → backup-banco.sh → aplicar-sql.sh.
--
-- Os planos nascem FORA da vitrine e fora dos fluxos antigos (is_active=false, sem checkout_url
-- e sem código de postback). O que liga cada um é a env da API:
--   CANDY_CHECKOUT_USD / CANDY_CHECKOUT_BRL = "slug=https://link,..."   (card aparece)
--   CANDY_PLAN_CODES                       = "CODIGO_POSTBACK=slug,..." (venda casa no webhook)
-- Limites, ilimitado e ordem copiados do plano mensal irmão (creator / pro) do próprio banco.
-- ============================================================================
BEGIN;

-- 1) Planos ------------------------------------------------------------------
INSERT INTO "theaimodelab"."plans" (
  "id", "slug", "name", "description", "price_cents", "credits_per_month",
  "max_concurrent_generations", "has_watermark", "gallery_retention_days", "has_api_access",
  "is_active", "is_public", "billing_interval", "base_plan_slug", "sort_order",
  "voice_clone_limit", "voice_clone_professional", "avatar_clone_enabled", "avatar_clone_limit",
  "unlimited_priority", "unlimited_models", "created_at", "updated_at"
)
SELECT
  'candy_' || md5(v.slug || clock_timestamp()::text), v.slug, b."name", b."description", v.brl, b."credits_per_month",
  b."max_concurrent_generations", b."has_watermark", b."gallery_retention_days", b."has_api_access",
  false, true, v.billing, b."slug", b."sort_order",
  b."voice_clone_limit", b."voice_clone_professional", b."avatar_clone_enabled", b."avatar_clone_limit",
  b."unlimited_priority", b."unlimited_models", now(), now()
FROM (VALUES
  ('creator-entrada',    'creator', 'month',   1490,  6990),
  ('creator-trimestral', 'creator', 'quarter', 4490, 21990),
  ('pro-trimestral',     'pro',     'quarter', 8990, 48990),
  ('creator-28d',        'creator', '28d',     1990,  8990),
  ('pro-28d',            'pro',     '28d',     3990, 17990)
) AS v(slug, base, billing, usd, brl)
JOIN "theaimodelab"."plans" b ON b."slug" = v.base
ON CONFLICT ("slug") DO NOTHING;

-- 2) Preços USD e BRL (sem link: o link vem da env) --------------------------
INSERT INTO "theaimodelab"."plan_prices" (
  "id", "plan_id", "currency", "price_cents", "stripe_price_id", "is_active", "checkout_url", "created_at", "updated_at"
)
SELECT
  'candy_' || md5(p."slug" || v.currency || clock_timestamp()::text), p."id", v.currency, v.cents, '', true, NULL, now(), now()
FROM (VALUES
  ('creator-entrada',    'USD',  1490), ('creator-entrada',    'BRL',  6990),
  ('creator-trimestral', 'USD',  4490), ('creator-trimestral', 'BRL', 21990),
  ('pro-trimestral',     'USD',  8990), ('pro-trimestral',     'BRL', 48990),
  ('creator-28d',        'USD',  1990), ('creator-28d',        'BRL',  8990),
  ('pro-28d',            'USD',  3990), ('pro-28d',            'BRL', 17990)
) AS v(slug, currency, cents)
JOIN "theaimodelab"."plans" p ON p."slug" = v.slug
ON CONFLICT ("plan_id", "currency") DO NOTHING;

COMMIT;

-- Conferência:
-- SELECT p.slug, p.billing_interval, p.is_active, p.is_public, p.credits_per_month, pp.currency, pp.price_cents
--   FROM "theaimodelab"."plans" p JOIN "theaimodelab"."plan_prices" pp ON pp.plan_id = p.id
--  WHERE p.slug IN ('creator-entrada','creator-trimestral','pro-trimestral','creator-28d','pro-28d')
--  ORDER BY p.slug, pp.currency;
--
-- Desfazer (nenhuma venda feita): DELETE FROM "theaimodelab"."plans" WHERE slug IN (...);  -- plan_prices cai em cascata
