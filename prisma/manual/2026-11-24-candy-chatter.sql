-- ============================================================================
-- candy-chatter (L20 · Mia Chatter pago na Fanvue) · 24/11/2026
-- Tabelas novas, sem `prisma migrate` / `db push`. Schema "theaimodelab".
-- Idempotente: pode rodar mais de uma vez. Só cria; não altera nem apaga nada que existe.
-- Ordem no servidor: diff-codigo.sh → backup-banco.sh → aplicar-sql.sh (este arquivo).
-- Com MIA_CHATTER_ENABLED off nada lê nem escreve aqui.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS "theaimodelab"."mia_chatter_accounts" (
  "id"                  TEXT          NOT NULL,
  "user_id"             TEXT          NOT NULL,
  "status"              TEXT          NOT NULL DEFAULT 'disconnected',
  "active"              BOOLEAN       NOT NULL DEFAULT false,
  "fanvue_creator_uuid" TEXT,
  "fanvue_handle"       TEXT,
  "access_token_enc"    TEXT,
  "refresh_token_enc"   TEXT,
  "token_expires_at"    TIMESTAMP(3),
  "scopes"              TEXT,
  "oauth_state"         TEXT,
  "oauth_verifier_enc"  TEXT,
  "oauth_started_at"    TIMESTAMP(3),
  "paid_until"          TIMESTAMP(3),
  "last_sale_code"      TEXT,
  "settings"            JSONB,
  "llm_month"           TEXT,
  "llm_cost_usd"        DECIMAL(10,4) NOT NULL DEFAULT 0,
  "stats"               JSONB,
  "last_polled_at"      TIMESTAMP(3),
  "last_error"          TEXT,
  "created_at"          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "mia_chatter_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mia_chatter_accounts_user_id_key"
  ON "theaimodelab"."mia_chatter_accounts"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "mia_chatter_accounts_oauth_state_key"
  ON "theaimodelab"."mia_chatter_accounts"("oauth_state");
CREATE INDEX IF NOT EXISTS "mia_chatter_accounts_status_active_idx"
  ON "theaimodelab"."mia_chatter_accounts"("status", "active");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mia_chatter_accounts_user_id_fkey') THEN
    ALTER TABLE "theaimodelab"."mia_chatter_accounts"
      ADD CONSTRAINT "mia_chatter_accounts_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "theaimodelab"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "theaimodelab"."mia_chatter_fans" (
  "id"                   TEXT          NOT NULL,
  "account_id"           TEXT          NOT NULL,
  "fan_uuid"             TEXT          NOT NULL,
  "handle"               TEXT,
  "step"                 TEXT          NOT NULL DEFAULT 'welcome',
  "spent_usd"            DECIMAL(10,2) NOT NULL DEFAULT 0,
  "purchases"            INTEGER       NOT NULL DEFAULT 0,
  "counted_purchase_ids" JSONB,
  "last_inbound_uuid"    TEXT,
  "last_inbound_at"      TIMESTAMP(3),
  "last_reply_at"        TIMESTAMP(3),
  "last_offer_at"        TIMESTAMP(3),
  "declined_at"          TIMESTAMP(3),
  "stopped"              BOOLEAN       NOT NULL DEFAULT false,
  "whale_alerted_at"     TIMESTAMP(3),
  "created_at"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "mia_chatter_fans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mia_chatter_fans_account_id_fan_uuid_key"
  ON "theaimodelab"."mia_chatter_fans"("account_id", "fan_uuid");
CREATE INDEX IF NOT EXISTS "mia_chatter_fans_account_id_spent_usd_idx"
  ON "theaimodelab"."mia_chatter_fans"("account_id", "spent_usd" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mia_chatter_fans_account_id_fkey') THEN
    ALTER TABLE "theaimodelab"."mia_chatter_fans"
      ADD CONSTRAINT "mia_chatter_fans_account_id_fkey"
      FOREIGN KEY ("account_id") REFERENCES "theaimodelab"."mia_chatter_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
