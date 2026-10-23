import { Logger } from '@nestjs/common';
import { GenerationStatus } from '@prisma/client';
import {
  MINIMIZED_SCAN_SCORES,
  ScanRetentionCron,
  expiredScansWhere,
  minimizeAccountScans,
  minimizedScanData,
} from '../scan-retention';

/**
 * Guarda mínima das checagens: depois do prazo, a linha fica só com veredito, regra, força e data. Nunca toca na
 * evidência, no sinal forte, na geração em revisão nem na geração com evento de imagem sem liberação. Banco simulado.
 */

const NOW = new Date('2026-10-17T12:00:00Z');

describe('ScanRetentionCron', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('filtro: sem evidência, ainda com hash; limpo/dúvida depois de 30 dias; leve/médio depois de 90; forte nunca', () => {
    const where = expiredScansWhere(NOW) as Record<string, any>;
    expect(where.evidenceKey).toBeNull();
    const [notMinimized, byVerdict] = where.AND;
    expect(notMinimized).toEqual({
      OR: [{ sha256: { not: null } }, { phash: { not: null } }],
    });
    const [recent, signal] = byVerdict.OR;
    expect(recent.verdict.in).toEqual(['CLEAN', 'GRAY', 'UNAVAILABLE']);
    expect(recent.createdAt.lt).toEqual(new Date('2026-09-17T12:00:00Z'));
    expect(signal.verdict.in).toEqual(['HOLD', 'BLOCK']);
    expect(signal.strength.in).not.toContain('STRONG');
    expect(signal.createdAt.lt).toEqual(new Date('2026-07-19T12:00:00Z'));
  });

  it('minimiza o que venceu e pula a geração em revisão ou com evidência em guarda', async () => {
    const rows = [
      { id: 'a', stage: 'INPUT', generationId: 'g-ok' },
      { id: 'b', stage: 'TEXT', generationId: 'g-ok' },
      { id: 'c', stage: 'INPUT', generationId: 'g-review' },
      { id: 'd', stage: 'OUTPUT', generationId: 'g-evidence' },
      { id: 'e', stage: 'INPUT', generationId: null },
    ];
    const prisma = {
      contentSafetyScan: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(rows)
          .mockResolvedValueOnce([]),
        updateMany: jest.fn(
          async (args: { where: { id: { in: string[] } } }) => ({
            count: args.where.id.in.length,
          }),
        ),
      },
      generation: {
        findMany: jest.fn(async () => [{ id: 'g-review' }]),
      },
      contentSafetyEvent: {
        findMany: jest.fn(async () => [{ generationId: 'g-evidence' }]),
      },
    };
    const cron = new ScanRetentionCron(prisma as never);

    await expect(cron.minimize(NOW)).resolves.toEqual({
      minimized: 3,
      skippedHeld: 2,
    });
    expect(prisma.generation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: GenerationStatus.IN_REVIEW }),
      }),
    );
    expect(prisma.contentSafetyScan.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'e'] } },
      data: minimizedScanData('media'),
    });
    expect(prisma.contentSafetyScan.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['b'] } },
      data: minimizedScanData('text'),
    });
  });

  it('o que fica: sem hash, sem pHash, sem sinais; a chave só sai nas etapas de mídia', () => {
    expect(minimizedScanData('media')).toEqual({
      sha256: null,
      phash: null,
      scores: MINIMIZED_SCAN_SCORES,
      mediaKey: null,
    });
    expect(minimizedScanData('text')).not.toHaveProperty('mediaKey');
  });

  it('exclusão LGPD: as checagens da conta sem evidência perdem hash, chave e sinais', async () => {
    const db = {
      contentSafetyScan: { updateMany: jest.fn(async () => ({ count: 2 })) },
    };
    await expect(minimizeAccountScans(db as never, 'u1')).resolves.toBe(4);
    expect(db.contentSafetyScan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'u1', evidenceKey: null }),
      }),
    );
  });

  it('erro no banco: a rodada termina sem lançar', async () => {
    const prisma = {
      contentSafetyScan: {
        findMany: jest.fn(async () => {
          throw new Error('banco fora');
        }),
      },
    };
    const cron = new ScanRetentionCron(prisma as never);
    await expect(cron.minimize(NOW)).resolves.toEqual({
      minimized: 0,
      skippedHeld: 0,
    });
  });
});
