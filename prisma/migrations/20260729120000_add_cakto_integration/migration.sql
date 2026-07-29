-- AlterTable
-- Integração Cakto (gateway BRL do Brasil, coexiste com Perfect Pay em USD).
-- Produto único "THE AI MODEL LAB" na Cakto; cada plano é uma OFERTA cujo
-- short-code (id da oferta = segmento do link pay.cakto.com.br/<offer>) casa no
-- webhook. O link de checkout Cakto por moeda fica em plan_prices.checkout_url.
ALTER TABLE "plans" ADD COLUMN "cakto_offer_code" TEXT;
ALTER TABLE "plan_prices" ADD COLUMN "checkout_url" TEXT;
