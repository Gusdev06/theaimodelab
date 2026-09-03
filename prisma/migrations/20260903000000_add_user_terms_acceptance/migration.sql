-- Aceite explícito do termo de uso (18+, responsabilidade pelo conteúdo, acesso da plataforma).
-- Nulo = ainda não aceitou; o front mostra o termo uma vez e grava aqui.
ALTER TABLE "users"
  ADD COLUMN "terms_accepted_at" TIMESTAMP(3),
  ADD COLUMN "terms_version" TEXT;
