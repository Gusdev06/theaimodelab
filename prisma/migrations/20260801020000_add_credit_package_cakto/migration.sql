-- AlterTable
-- Pacotes de crédito avulsos em BRL via Cakto (coexiste com Perfect Pay em USD).
-- Produto de PAGAMENTO ÚNICO "THE AI MODEL LAB — Créditos" na Cakto; cada pacote é
-- uma OFERTA cujo short-code (id da oferta = segmento do link pay.cakto.com.br/<offer>)
-- casa no webhook via credit_packages.cakto_offer_code. O link de checkout Cakto por
-- moeda fica em credit_package_prices.checkout_url (espelha o padrão dos planos).
ALTER TABLE "theaimodelab"."credit_packages" ADD COLUMN "cakto_offer_code" TEXT;
ALTER TABLE "theaimodelab"."credit_package_prices" ADD COLUMN "checkout_url" TEXT;
