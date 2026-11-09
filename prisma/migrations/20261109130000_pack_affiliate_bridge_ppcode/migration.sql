-- Ponte Pack → plataforma: o afiliado guarda o código dele na Perfect Pay (espaço de nomes separado do código da plataforma) e a isca guarda qual afiliado ela deu à conta, para o reembolso desfazer. Colunas novas e opcionais; nada muda nas linhas atuais.
ALTER TABLE "affiliates" ADD COLUMN "perfectpay_affiliate_code" TEXT;
CREATE UNIQUE INDEX "affiliates_perfectpay_affiliate_code_key" ON "affiliates"("perfectpay_affiliate_code");
ALTER TABLE "pending_free_generation_grants" ADD COLUMN "attributed_affiliate_code" TEXT;
