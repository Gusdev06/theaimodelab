-- CreateTable
CREATE TABLE "payment_recovery_campaigns" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_1_sent_at" TIMESTAMP(3),
    "email_2_sent_at" TIMESTAMP(3),
    "email_3_sent_at" TIMESTAMP(3),
    "recovered_at" TIMESTAMP(3),
    "abandoned_at" TIMESTAMP(3),
    "bonus_granted_at" TIMESTAMP(3),
    "bonus_credits" INTEGER NOT NULL DEFAULT 0,
    "decline_code" TEXT,
    "card_brand" TEXT,
    "card_last4" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_recovery_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_recovery_campaigns_subscription_id_key" ON "payment_recovery_campaigns"("subscription_id");

-- CreateIndex
CREATE INDEX "payment_recovery_campaigns_user_id_idx" ON "payment_recovery_campaigns"("user_id");

-- CreateIndex
CREATE INDEX "payment_recovery_campaigns_recovered_at_idx" ON "payment_recovery_campaigns"("recovered_at");

-- CreateIndex
CREATE INDEX "payment_recovery_campaigns_abandoned_at_idx" ON "payment_recovery_campaigns"("abandoned_at");

-- CreateIndex
CREATE INDEX "payment_recovery_campaigns_enrolled_at_idx" ON "payment_recovery_campaigns"("enrolled_at");

-- AddForeignKey
ALTER TABLE "payment_recovery_campaigns" ADD CONSTRAINT "payment_recovery_campaigns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_recovery_campaigns" ADD CONSTRAINT "payment_recovery_campaigns_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
