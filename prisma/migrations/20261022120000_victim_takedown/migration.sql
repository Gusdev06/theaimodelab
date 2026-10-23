-- Denúncia da própria pessoa retratada e remoção (22/10/2026): tipo novo de denúncia ("sou a pessoa da imagem", prazo
-- de 48 h do TAKE IT DOWN), o prazo e a conclusão da remoção na denúncia, e a tabela dos arquivos tirados do ar (para
-- onde cada um foi e a purga do CDN). Só aditiva: valor novo em enum, duas colunas anuláveis e uma tabela nova. Nenhum
-- dado existente muda. Sem FK de propósito (a trilha sobrevive à exclusão da conta).
-- ALTER TYPE ... ADD VALUE exige PostgreSQL 12+ dentro de uma migração; o valor novo não é usado nesta migração.
--
-- ORDEM DE DEPLOY (obrigatória): aplicar ANTES de subir o código desta versão (npx prisma migrate deploy e depois
-- npx prisma migrate status). O client novo lê content_reports.takedown_due_at em toda consulta de denúncia sem
-- select: com o código no ar e a coluna faltando, o canal de denúncias falha (P2022). O inverso é seguro.

-- AlterEnum
ALTER TYPE "ContentReportCategory" ADD VALUE 'SELF_DEPICTED';

-- AlterTable (colunas anuláveis: as linhas existentes ficam com NULL)
ALTER TABLE "content_reports" ADD COLUMN     "takedown_done_at" TIMESTAMP(3),
ADD COLUMN     "takedown_due_at" TIMESTAMP(3);

-- CreateTable (report_id nulo = arquivo retirado pela confirmação de uma checagem, com scan_id)
CREATE TABLE "content_takedown_items" (
    "id" TEXT NOT NULL,
    "report_id" TEXT,
    "scan_id" TEXT,
    "generation_id" TEXT,
    "source" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "area" TEXT,
    "media_key" TEXT,
    "public_url" TEXT,
    "sha256" TEXT,
    "phashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "block_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "evidence_key" TEXT,
    "purge_status" TEXT NOT NULL,
    "purge_error" TEXT,
    "purge_attempts" INTEGER NOT NULL DEFAULT 0,
    "purged_at" TIMESTAMP(3),
    "actor_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_takedown_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_takedown_items_report_id_idx" ON "content_takedown_items"("report_id");

-- CreateIndex
CREATE INDEX "content_takedown_items_scan_id_idx" ON "content_takedown_items"("scan_id");

-- CreateIndex
CREATE INDEX "content_takedown_items_generation_id_idx" ON "content_takedown_items"("generation_id");

-- CreateIndex
CREATE INDEX "content_takedown_items_purge_status_updated_at_idx" ON "content_takedown_items"("purge_status", "updated_at");

-- CreateIndex
CREATE INDEX "content_reports_takedown_due_at_idx" ON "content_reports"("takedown_due_at");
