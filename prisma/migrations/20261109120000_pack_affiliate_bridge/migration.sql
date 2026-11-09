-- Ponte Pack → plataforma: a isca guarda o afiliado da Perfect Pay que fez a venda e o afiliado da plataforma guarda o e-mail dele lá. Colunas novas e opcionais; nada muda nas linhas atuais.
ALTER TABLE "pending_free_generation_grants" ADD COLUMN "affiliate_ref" TEXT;
ALTER TABLE "affiliates" ADD COLUMN "perfectpay_affiliate_email" TEXT;
CREATE UNIQUE INDEX "affiliates_perfectpay_affiliate_email_key" ON "affiliates"("perfectpay_affiliate_email");
