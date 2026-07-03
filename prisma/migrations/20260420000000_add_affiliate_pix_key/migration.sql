-- CreateEnum
CREATE TYPE "PixKeyType" AS ENUM ('CPF', 'CNPJ', 'EMAIL', 'PHONE', 'RANDOM');

-- AlterTable
ALTER TABLE "affiliates"
  ADD COLUMN "pix_key" TEXT,
  ADD COLUMN "pix_key_type" "PixKeyType";
