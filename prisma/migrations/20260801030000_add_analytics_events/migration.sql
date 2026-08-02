-- CreateTable
-- Eventos de analytics de produto (paywall shown/clicked, etc.) enviados pelo frontend.
-- Auth opcional: user_id preenchido quando há JWT válido, NULL para visitantes anônimos.
CREATE TABLE "theaimodelab"."analytics_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "event_name" TEXT NOT NULL,
    "action" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_events_user_id_idx" ON "theaimodelab"."analytics_events"("user_id");

-- CreateIndex
CREATE INDEX "analytics_events_created_at_idx" ON "theaimodelab"."analytics_events"("created_at");

-- CreateIndex
CREATE INDEX "analytics_events_event_name_created_at_idx" ON "theaimodelab"."analytics_events"("event_name", "created_at");
