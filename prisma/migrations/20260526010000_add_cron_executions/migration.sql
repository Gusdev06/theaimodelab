-- CreateTable
CREATE TABLE "cron_executions" (
    "id" TEXT NOT NULL,
    "cron_name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cron_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cron_executions_cron_name_started_at_idx" ON "cron_executions"("cron_name", "started_at" DESC);

-- CreateIndex
CREATE INDEX "cron_executions_status_idx" ON "cron_executions"("status");

-- CreateIndex
CREATE INDEX "cron_executions_started_at_idx" ON "cron_executions"("started_at");
