CREATE TABLE "marketing_leads" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "source" TEXT NOT NULL DEFAULT 'sales_quiz',
    "quiz_result" TEXT,
    "quiz_answers" JSONB,
    "attribution" JSONB,
    "fbclid" TEXT,
    "fbp" TEXT,
    "fbc" TEXT,
    "gclid" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "landing_page" TEXT,
    "referrer" TEXT,
    "event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_leads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_leads_email_source_key" ON "marketing_leads"("email", "source");
CREATE INDEX "marketing_leads_source_idx" ON "marketing_leads"("source");
CREATE INDEX "marketing_leads_quiz_result_idx" ON "marketing_leads"("quiz_result");
CREATE INDEX "marketing_leads_utm_campaign_idx" ON "marketing_leads"("utm_campaign");
CREATE INDEX "marketing_leads_created_at_idx" ON "marketing_leads"("created_at");
