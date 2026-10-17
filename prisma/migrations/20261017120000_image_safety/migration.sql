-- Segurança de imagem (17/10/2026): checagem da foto/vídeo de entrada antes do provedor, do resultado antes do link
-- público e do texto pelo classificador; lista de bloqueio por hash; registro de acesso da revisão e da aplicação
-- (Marco Civil, art. 15). Só aditiva: tipos e tabelas novos, valores novos em enum e uma coluna anulável em
-- generations. Nenhum dado existente muda. Sem FK de propósito (a trilha sobrevive à exclusão da conta).
-- ALTER TYPE ... ADD VALUE exige PostgreSQL 12+ dentro de uma migração; nenhum valor novo é usado nesta migração.
--
-- ORDEM DE DEPLOY (obrigatória): aplicar as migrações ANTES de subir o código desta versão:
--   1) npx prisma migrate deploy  (aplica 20261015120000_content_safety e depois esta)
--   2) npx prisma migrate status  (confere que não ficou nenhuma pendente)
--   3) só então subir a imagem nova da API.
-- O client novo lê generations.safety_checked_at em toda consulta sem select (criar geração, cron de presas): com o
-- código no ar e a coluna faltando, TODA geração falha (P2022), mesmo com IMAGE_SAFETY_MODE=off. O inverso é seguro:
-- esta migração só acrescenta, então pode ser aplicada dias antes com o código antigo no ar.

-- CreateEnum
CREATE TYPE "ContentSafetyScanStage" AS ENUM ('INPUT', 'INPUT_FRAME', 'OUTPUT', 'OUTPUT_FRAME', 'TEXT');

-- CreateEnum
CREATE TYPE "ContentSafetyScanVerdict" AS ENUM ('CLEAN', 'GRAY', 'HOLD', 'BLOCK', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "ContentSafetyStrength" AS ENUM ('STRONG', 'MEDIUM', 'LIGHT', 'NONE');

-- AlterEnum
ALTER TYPE "GenerationStatus" ADD VALUE 'IN_REVIEW';

-- AlterEnum
ALTER TYPE "ContentSafetyEventKind" ADD VALUE 'IMAGE_MINOR_BLOCKED';
ALTER TYPE "ContentSafetyEventKind" ADD VALUE 'INPUT_HELD';
ALTER TYPE "ContentSafetyEventKind" ADD VALUE 'OUTPUT_HELD';
ALTER TYPE "ContentSafetyEventKind" ADD VALUE 'OUTPUT_MINOR_BLOCKED';
ALTER TYPE "ContentSafetyEventKind" ADD VALUE 'TEXT_CLASSIFIER_FLAGGED';
ALTER TYPE "ContentSafetyEventKind" ADD VALUE 'REFINER_BLOCKED';

-- AlterTable (coluna anulável: as linhas existentes ficam com NULL)
ALTER TABLE "generations" ADD COLUMN "safety_checked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "content_safety_scans" (
    "id" TEXT NOT NULL,
    "generation_id" TEXT,
    "user_id" TEXT,
    "stage" "ContentSafetyScanStage" NOT NULL,
    "media_key" TEXT,
    "sha256" TEXT,
    "phash" TEXT,
    "scores" JSONB,
    "verdict" "ContentSafetyScanVerdict" NOT NULL,
    "rule_id" TEXT,
    "strength" "ContentSafetyStrength" NOT NULL DEFAULT 'NONE',
    "rules_version" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "enforced" BOOLEAN NOT NULL DEFAULT false,
    "scanner" TEXT NOT NULL,
    "region" TEXT,
    "latency_ms" INTEGER,
    "evidence_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_safety_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_hash_blocks" (
    "id" TEXT NOT NULL,
    "phash" TEXT NOT NULL,
    "sha256" TEXT,
    "strength" "ContentSafetyStrength" NOT NULL,
    "origin" TEXT NOT NULL,
    "event_id" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_hash_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_safety_access_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_safety_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_log" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "route" TEXT NOT NULL,
    "generation_id" TEXT,
    "ip" TEXT,
    "port" INTEGER,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_safety_scans_generation_id_idx" ON "content_safety_scans"("generation_id");

-- CreateIndex
CREATE INDEX "content_safety_scans_user_id_created_at_idx" ON "content_safety_scans"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "content_safety_scans_sha256_idx" ON "content_safety_scans"("sha256");

-- CreateIndex
CREATE INDEX "content_hash_blocks_phash_idx" ON "content_hash_blocks"("phash");

-- CreateIndex
CREATE INDEX "content_hash_blocks_sha256_idx" ON "content_hash_blocks"("sha256");

-- CreateIndex
CREATE INDEX "content_hash_blocks_created_at_idx" ON "content_hash_blocks"("created_at");

-- CreateIndex
CREATE INDEX "content_safety_access_log_target_type_target_id_idx" ON "content_safety_access_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "content_safety_access_log_actor_id_created_at_idx" ON "content_safety_access_log"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "content_safety_access_log_created_at_idx" ON "content_safety_access_log"("created_at");

-- CreateIndex
CREATE INDEX "access_log_user_id_created_at_idx" ON "access_log"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "access_log_generation_id_idx" ON "access_log"("generation_id");

-- CreateIndex
CREATE INDEX "access_log_created_at_idx" ON "access_log"("created_at");
