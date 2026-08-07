-- Adiciona flag de descadastro de marketing (opt-out) ao User.
-- Rodar no SQL Editor do Supabase ANTES do deploy que inclui o endpoint /email/unsubscribe.
-- Idempotente (IF NOT EXISTS). Default false = todo mundo continua recebendo até optar por sair.

ALTER TABLE theaimodelab.users
  ADD COLUMN IF NOT EXISTS marketing_opt_out boolean NOT NULL DEFAULT false;
