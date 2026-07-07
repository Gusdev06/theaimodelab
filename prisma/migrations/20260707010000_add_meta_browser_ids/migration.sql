ALTER TABLE "users"
  ADD COLUMN "fbp" TEXT,
  ADD COLUMN "fbc" TEXT;

CREATE INDEX "users_fbc_idx" ON "users"("fbc");
