-- CreateTable
CREATE TABLE "user_onboarding_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT,
    "platform" TEXT,
    "model_status" TEXT,
    "content_mix" TEXT,
    "weekly_volume" TEXT,
    "answers" JSONB,
    "segment" TEXT,
    "recommended_plan" TEXT,
    "estimated_monthly_credits" INTEGER,
    "last_step_reached" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "starter_kit_granted_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_onboarding_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_onboarding_profiles_user_id_key" ON "user_onboarding_profiles"("user_id");

-- CreateIndex
CREATE INDEX "user_onboarding_profiles_segment_idx" ON "user_onboarding_profiles"("segment");

-- CreateIndex
CREATE INDEX "user_onboarding_profiles_recommended_plan_idx" ON "user_onboarding_profiles"("recommended_plan");

-- CreateIndex
CREATE INDEX "user_onboarding_profiles_completed_at_idx" ON "user_onboarding_profiles"("completed_at");

-- CreateIndex
CREATE INDEX "user_onboarding_profiles_activated_at_idx" ON "user_onboarding_profiles"("activated_at");

-- AddForeignKey
ALTER TABLE "user_onboarding_profiles" ADD CONSTRAINT "user_onboarding_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
