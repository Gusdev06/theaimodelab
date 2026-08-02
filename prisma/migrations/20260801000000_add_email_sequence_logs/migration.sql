-- CreateTable
-- Log das sequências automáticas de email (onboarding e pós-assinatura).
-- Unique (user_id, email_key) garante idempotência do cron de envio.
CREATE TABLE "theaimodelab"."email_sequence_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sequence" TEXT NOT NULL,
    "email_key" TEXT NOT NULL,
    "resend_email_id" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_sequence_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_sequence_logs_user_id_email_key_key" ON "theaimodelab"."email_sequence_logs"("user_id", "email_key");

-- CreateIndex
CREATE INDEX "email_sequence_logs_user_id_idx" ON "theaimodelab"."email_sequence_logs"("user_id");

-- CreateIndex
CREATE INDEX "email_sequence_logs_sequence_sent_at_idx" ON "theaimodelab"."email_sequence_logs"("sequence", "sent_at");

-- AddForeignKey
ALTER TABLE "theaimodelab"."email_sequence_logs" ADD CONSTRAINT "email_sequence_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "theaimodelab"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
