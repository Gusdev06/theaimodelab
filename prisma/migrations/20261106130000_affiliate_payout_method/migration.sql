-- Afiliado fora do Brasil recebe por PayPal ou Wise: forma de recebimento e e-mail da conta. Colunas novas e opcionais; quem já tem chave Pix não muda.
ALTER TABLE "affiliates" ADD COLUMN "payout_method" TEXT;
ALTER TABLE "affiliates" ADD COLUMN "payout_email" TEXT;
