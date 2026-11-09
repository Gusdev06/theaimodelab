-- Declaração de responsabilidade pelas imagens, gravada na conta uma única vez (data e versão do texto).
-- Só colunas novas e opcionais: nada muda nas linhas existentes (as contas atuais ficam com NULL = ainda não declarou).
ALTER TABLE "users" ADD COLUMN "image_declaration_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "image_declaration_version" TEXT;
