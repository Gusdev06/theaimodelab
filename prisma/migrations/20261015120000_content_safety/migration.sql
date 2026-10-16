-- Segurança de conteúdo (15/10/2026): denúncias de conteúdo (menor, imagem íntima sem consentimento, uso de imagem
-- de terceiro, direito autoral) e registro de bloqueio/consentimento das ferramentas de foto. Só CREATE (aditiva):
-- nenhuma tabela existente muda. Sem FK para users de propósito (denúncia e evidência sobrevivem à exclusão da conta).

-- CreateEnum
CREATE TYPE "ContentReportCategory" AS ENUM ('MINOR', 'NON_CONSENSUAL', 'IMPERSONATION', 'COPYRIGHT', 'ILLEGAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ContentReportStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'ACTIONED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ContentSafetyEventKind" AS ENUM ('MINOR_BLOCKED', 'CONSENT_ATTESTED', 'CONSENT_MISSING');

-- CreateTable
CREATE TABLE "content_reports" (
    "id" TEXT NOT NULL,
    "category" "ContentReportCategory" NOT NULL,
    "status" "ContentReportStatus" NOT NULL DEFAULT 'OPEN',
    "target" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "reporter_email" TEXT,
    "reporter_user_id" TEXT,
    "is_depicted_person" BOOLEAN NOT NULL DEFAULT false,
    "ip_hash" TEXT,
    "admin_note" TEXT,
    "handled_by" TEXT,
    "handled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_safety_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "kind" "ContentSafetyEventKind" NOT NULL,
    "route" TEXT NOT NULL,
    "match" TEXT,
    "excerpt" TEXT,
    "terms_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_safety_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_reports_status_created_at_idx" ON "content_reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "content_reports_category_idx" ON "content_reports"("category");

-- CreateIndex
CREATE INDEX "content_safety_events_user_id_created_at_idx" ON "content_safety_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "content_safety_events_kind_created_at_idx" ON "content_safety_events"("kind", "created_at");

