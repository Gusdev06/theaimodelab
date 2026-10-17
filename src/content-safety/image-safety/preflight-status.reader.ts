import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ImageSafetyConfig } from './image-safety.config';
import {
  preflightStatusFromScans,
  uncensoredFallbackStatus,
} from './image-safety.scans';
import type {
  PreflightStatusReader,
  PreflightStatusTarget,
} from './image-safety.tokens';

/**
 * Leitor do status do preflight para o ContentSafetyService (desvio depois de uma recusa do provedor): lê as checagens
 * de entrada e de texto gravadas da geração. Com IMAGE_SAFETY_MODE=off não lê nada e devolve `unavailable` (Onda 0);
 * erro de leitura também é `unavailable` (nunca libera o desvio). Para o desvio SEM CENSURA, a entrada é reavaliada
 * como pedido sexual (uncensoredFallbackStatus): o 'clean' do pedido original não vale para o destino sem filtro.
 */
export function createPreflightStatusReader(
  prisma: PrismaService,
  config: Pick<ImageSafetyConfig, 'imageMode' | 'textMode' | 'thresholds'>,
): PreflightStatusReader {
  const logger = new Logger('PreflightStatusReader');
  return {
    async statusFor(generationId, target?: PreflightStatusTarget) {
      if (config.imageMode === 'off' || !generationId) return 'unavailable';
      try {
        const rows = await prisma.contentSafetyScan.findMany({
          where: {
            generationId,
            stage: { in: ['INPUT', 'INPUT_FRAME', 'TEXT'] },
          },
          select: {
            stage: true,
            verdict: true,
            mediaKey: true,
            sha256: true,
            createdAt: true,
            scores: true,
          },
        });
        const status = preflightStatusFromScans(
          rows,
          config.textMode !== 'off',
        );
        return target === 'uncensored'
          ? uncensoredFallbackStatus(status, rows, config.thresholds)
          : status;
      } catch (error) {
        logger.warn(
          `gen=${generationId}: checagens não lidas (${(error as Error).message?.slice(0, 200)}) — sem checagem`,
        );
        return 'unavailable';
      }
    },
  };
}
