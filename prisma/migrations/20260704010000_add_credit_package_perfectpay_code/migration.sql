-- AlterTable
-- Código do "plano" na Perfect Pay (o produto é único; cada plano tem preço/checkout próprios).
ALTER TABLE "credit_packages" ADD COLUMN "perfectpay_plan_code" TEXT;
