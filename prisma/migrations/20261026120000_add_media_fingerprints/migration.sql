-- Impressões visuais das imagens geradas (desvio para modelo sem censura com a foto da própria cliente).
-- Só CREATE: nenhuma tabela existente muda.

-- CreateTable
CREATE TABLE "media_fingerprints" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "generation_id" TEXT NOT NULL,
    "output_order" INTEGER NOT NULL,
    "dhash" TEXT NOT NULL,
    "aspect" DOUBLE PRECISION NOT NULL,
    "clean_lineage" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_fingerprints_user_id_clean_lineage_created_at_idx" ON "media_fingerprints"("user_id", "clean_lineage", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "media_fingerprints_generation_id_output_order_key" ON "media_fingerprints"("generation_id", "output_order");

-- AddForeignKey
ALTER TABLE "media_fingerprints" ADD CONSTRAINT "media_fingerprints_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_fingerprints" ADD CONSTRAINT "media_fingerprints_generation_id_fkey" FOREIGN KEY ("generation_id") REFERENCES "generations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

