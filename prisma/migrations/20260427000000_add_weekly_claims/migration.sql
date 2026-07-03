-- CreateTable
CREATE TABLE "weekly_claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "week_key" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 4,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_claims_user_id_idx" ON "weekly_claims"("user_id");

-- CreateIndex
CREATE INDEX "weekly_claims_week_key_idx" ON "weekly_claims"("week_key");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_claims_user_id_week_key_key" ON "weekly_claims"("user_id", "week_key");

-- AddForeignKey
ALTER TABLE "weekly_claims" ADD CONSTRAINT "weekly_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
