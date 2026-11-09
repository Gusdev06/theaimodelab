-- Comissão de afiliado passa a guardar a moeda e o gateway da venda. Colunas novas e opcionais: as comissões antigas ficam como estão.
ALTER TABLE "affiliate_earnings" ADD COLUMN "currency" TEXT;
ALTER TABLE "affiliate_earnings" ADD COLUMN "provider" TEXT;
