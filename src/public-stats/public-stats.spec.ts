import { displayCount, floorToTwoSignificant, isPublicStatsEnabled, PUBLIC_STATS_TTL_MS, toPublicStats } from './public-stats.math';
import { PublicStatsService } from './public-stats.service';

function makeService(env: Record<string, string | undefined>, counts = { users: 12_345, gens: 1_234_567, paying: 987 }) {
  const prisma = {
    user: { count: jest.fn().mockResolvedValue(counts.users) },
    generation: { count: jest.fn().mockResolvedValue(counts.gens) },
    payment: { groupBy: jest.fn().mockResolvedValue(Array.from({ length: counts.paying }, (_, i) => ({ userId: `u${i}` }))) },
  };
  const config = { get: jest.fn((key: string) => env[key]) };
  const service = new PublicStatsService(prisma as never, config as never);
  return { service, prisma };
}

describe('prova social real (L14)', () => {
  describe('arredondamento para baixo', () => {
    it.each([
      [12_345, 12_000],
      [1_534, 1_500],
      [987, 980],
      [1_234_567, 1_200_000],
      [99, 99],
      [0, 0],
      [-5, 0],
      [Number.NaN, 0],
    ])('%p → %p', (input, expected) => {
      expect(floorToTwoSignificant(input)).toBe(expected);
    });

    it('nunca mostra mais do que existe', () => {
      for (const n of [100, 101, 999, 1001, 25_999, 50_000_001]) {
        expect(floorToTwoSignificant(n)).toBeLessThanOrEqual(n);
      }
    });

    it('abaixo do piso = null (a tela fica com o texto de hoje)', () => {
      expect(displayCount(999, 1000)).toBeNull();
      expect(displayCount(1000, 1000)).toBe(1000);
      expect(toPublicStats({ accounts: 500, generations: 50_000, payingCreators: 20 }, new Date(0))).toEqual({
        accounts: null,
        generations: 50_000,
        payingCreators: null,
        updatedAt: new Date(0).toISOString(),
      });
    });
  });

  describe('flag', () => {
    it.each([undefined, '', 'off', 'false', '0'])('PUBLIC_STATS_ENABLED=%p desliga', (raw) => {
      expect(isPublicStatsEnabled(raw)).toBe(false);
    });
    it.each(['on', 'true', '1', 'ON'])('PUBLIC_STATS_ENABLED=%p liga', (raw) => {
      expect(isPublicStatsEnabled(raw)).toBe(true);
    });
  });

  describe('PublicStatsService', () => {
    it('flag off: devolve enabled:false sem tocar no banco', async () => {
      const { service, prisma } = makeService({});
      await expect(service.get()).resolves.toEqual({ enabled: false });
      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(prisma.generation.count).not.toHaveBeenCalled();
    });

    it('flag on: conta, arredonda e guarda 1 h em cache', async () => {
      const { service, prisma } = makeService({ PUBLIC_STATS_ENABLED: 'on' });
      const t0 = new Date('2026-11-24T12:00:00Z');
      const first = await service.get(t0);
      expect(first).toEqual(
        expect.objectContaining({ enabled: true, accounts: 12_000, generations: 1_200_000, payingCreators: 980 }),
      );
      await service.get(new Date(t0.getTime() + PUBLIC_STATS_TTL_MS - 1));
      expect(prisma.user.count).toHaveBeenCalledTimes(1);
      await service.get(new Date(t0.getTime() + PUBLIC_STATS_TTL_MS + 1));
      expect(prisma.user.count).toHaveBeenCalledTimes(2);
    });

    it('contagem falhou depois de um valor bom: devolve o último valor bom', async () => {
      const { service, prisma } = makeService({ PUBLIC_STATS_ENABLED: 'on' });
      const t0 = new Date('2026-11-24T12:00:00Z');
      await service.get(t0);
      prisma.user.count.mockRejectedValueOnce(new Error('db fora'));
      const later = await service.get(new Date(t0.getTime() + PUBLIC_STATS_TTL_MS + 1));
      expect(later).toEqual(expect.objectContaining({ enabled: true, accounts: 12_000 }));
    });

    it('contagem falhou sem valor anterior: enabled:false (a tela cai no texto de hoje)', async () => {
      const { service, prisma } = makeService({ PUBLIC_STATS_ENABLED: 'on' });
      prisma.generation.count.mockRejectedValueOnce(new Error('db fora'));
      await expect(service.get()).resolves.toEqual({ enabled: false });
    });
  });
});
