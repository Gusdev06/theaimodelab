-- AlterTable
-- Assinatura mensal via Perfect Pay: cada plano recorrente tem seu código de
-- plano (casado no webhook) e o link de checkout (redirecionamento no front).
ALTER TABLE "plans" ADD COLUMN "perfectpay_plan_code" TEXT;
ALTER TABLE "plans" ADD COLUMN "checkout_url" TEXT;
