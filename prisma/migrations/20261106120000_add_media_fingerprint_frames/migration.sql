-- Quadros de vídeo na impressão visual (own-media): só ADD COLUMN, nada muda nas linhas que já existem.
ALTER TABLE "media_fingerprints" ADD COLUMN "frame_index" INTEGER;
