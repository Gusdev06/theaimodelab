-- Segundo nível do programa de afiliados: o afiliado que trouxe outro afiliado (pai) recebe uma fatia de cada comissão do filho, paga pela casa. Colunas novas e opcionais; comissão antiga sem nível conta como direta.
ALTER TABLE "affiliates" ADD COLUMN "parent_affiliate_id" TEXT;
ALTER TABLE "affiliate_earnings" ADD COLUMN "level" INTEGER;
ALTER TABLE "affiliate_earnings" ADD COLUMN "source_earning_id" TEXT;

CREATE INDEX "affiliates_parent_affiliate_id_idx" ON "affiliates"("parent_affiliate_id");

ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_parent_affiliate_id_fkey" FOREIGN KEY ("parent_affiliate_id") REFERENCES "affiliates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
