-- Marca do site em que a conta nasceu (null = The AI Model Lab). Coluna nova e opcional: nada muda nas contas atuais.
ALTER TABLE "users" ADD COLUMN "signup_brand" TEXT;
