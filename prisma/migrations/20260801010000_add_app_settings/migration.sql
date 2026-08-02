-- CreateTable
-- Configurações globais editáveis pelo admin (chave-valor).
-- Primeiro uso: 'onboarding_sequence_enabled' (toggle das sequências de email).
CREATE TABLE "theaimodelab"."app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);
