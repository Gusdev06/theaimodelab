import { GenerationType, Resolution } from '@prisma/client';
import { PlansService } from '../plans.service';

/**
 * Preços hardcoded (Seedance 2.0/2.5, Omni) não passam pelo Prisma — dá para
 * testar a tabela sem banco. v6 (TKT-112): Seedance 2.5 1080p 2.650 / 1.600 cr/s.
 */
describe('PlansService — tabela hardcoded de vídeo (v6)', () => {
  const service = new PlansService({} as any, {} as any);

  it('Seedance 2.5 1080p sem vídeo de referência: 2.650 cr/s (kie US$ 0,79/s)', async () => {
    await expect(
      service.calculateGenerationCost(
        GenerationType.TEXT_TO_VIDEO,
        Resolution.RES_1080P,
        5,
        true,
        1,
        'SEEDANCE_2_5',
        false,
      ),
    ).resolves.toBe(2650 * 5);
  });

  it('Seedance 2.5 1080p com vídeo de referência: 1.600 cr/s (kie US$ 0,475/s)', async () => {
    await expect(
      service.calculateGenerationCost(
        GenerationType.REFERENCE_VIDEO,
        Resolution.RES_1080P,
        8,
        true,
        1,
        'SEEDANCE_2_5',
        true,
      ),
    ).resolves.toBe(1600 * 8);
  });

  it('Seedance 2.5 480p/720p e Seedance 2.0 não mudaram', async () => {
    await expect(
      service.calculateGenerationCost(GenerationType.TEXT_TO_VIDEO, Resolution.RES_480P, 5, true, 1, 'SEEDANCE_2_5'),
    ).resolves.toBe(470 * 5);
    await expect(
      service.calculateGenerationCost(GenerationType.TEXT_TO_VIDEO, Resolution.RES_720P, 5, true, 1, 'SEEDANCE_2_5'),
    ).resolves.toBe(1050 * 5);
    await expect(
      service.calculateGenerationCost(GenerationType.TEXT_TO_VIDEO, Resolution.RES_1080P, 5, true, 1, 'SEEDANCE_2'),
    ).resolves.toBe(1705 * 5);
  });

  it('Gemini Omni 1080p 8 s continua 2.510', async () => {
    await expect(
      service.calculateGenerationCost(GenerationType.TEXT_TO_VIDEO, Resolution.RES_1080P, 8, false, 1, 'GEMINI_OMNI'),
    ).resolves.toBe(2510);
  });
});
