-- CreateEnum
CREATE TYPE "AffiliateDiscountScope" AS ENUM ('FIRST_PURCHASE', 'ALL_PURCHASES');

-- AlterTable
ALTER TABLE "affiliates"
  ADD COLUMN "discount_percent" INTEGER,
  ADD COLUMN "discount_applies_to" "AffiliateDiscountScope" NOT NULL DEFAULT 'FIRST_PURCHASE',
  ADD COLUMN "stripe_coupon_id" TEXT,
  ADD COLUMN "stripe_promotion_code_id" TEXT;
