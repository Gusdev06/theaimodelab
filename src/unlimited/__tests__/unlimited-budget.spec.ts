import { Resolution } from '@prisma/client';
import { UnlimitedService } from '../unlimited.service';

const NB2_PLAN = [{ modelVariant: 'NB2', resolutions: ['RES_1K', 'RES_2K'] }, { modelVariant: 'NBP', resolutions: ['RES_1K'] }];

function makeService(planSlug: string, rows: Array<{ modelVariant: string; resolution: string; n: number }>) {
  const prisma = {
    subscription: {
      findFirst: jest.fn().mockResolvedValue({ plan: { id: 'p1', slug: planSlug, unlimitedPriority: 1, unlimitedModels: NB2_PLAN } }),
    },
    unlimitedUsage: {
      count: jest.fn().mockResolvedValue(rows.reduce((s, r) => s + r.n, 0)),
      groupBy: jest.fn().mockResolvedValue(rows.map((r) => ({ modelVariant: r.modelVariant, resolution: r.resolution, _count: { _all: r.n } }))),
    },
  };
  const redis = { get: jest.fn().mockResolvedValue(null) };
  return new UnlimitedService(prisma as never, redis as never);
}

describe('uso justo da imagem ilimitada (prejuízo zero)', () => {
  it('orçamento por plano, anual e avulso de 30 dias usam o do mensal', () => {
    const s = makeService('advanced', []);
    expect(s.budgetFor('advanced')).toBe(7);
    expect(s.budgetFor('advanced-anual')).toBe(7);
    expect(s.budgetFor('studio-30d')).toBe(8);
    expect(s.budgetFor('agency')).toBe(22);
    expect(s.budgetFor('pro')).toBeNull();
  });

  it('NBP e 2K pesam 1,5; NB2 1K pesa 1', () => {
    const s = makeService('studio', []);
    expect(s.weightOf('NB2', 'RES_1K')).toBe(1);
    expect(s.weightOf('NB2', 'RES_2K')).toBe(1.5);
    expect(s.weightOf('NBP', 'RES_1K')).toBe(1.5);
  });

  it('libera dentro do orçamento e barra quando a próxima passaria dele', async () => {
    const dentro = makeService('advanced', [{ modelVariant: 'NB2', resolution: 'RES_1K', n: 6 }]);
    await expect(dentro.checkEligibility('u1', 'NB2', Resolution.RES_1K)).resolves.toMatchObject({ allowed: true });

    const cheio = makeService('advanced', [{ modelVariant: 'NB2', resolution: 'RES_1K', n: 7 }]);
    await expect(cheio.checkEligibility('u1', 'NB2', Resolution.RES_1K)).resolves.toMatchObject({ allowed: false, reason: 'daily_budget_reached' });
  });

  it('Studio: 5 NBP (7,5) barra a 6ª NBP mas não conta como teto de servidor', async () => {
    const s = makeService('studio', [{ modelVariant: 'NBP', resolution: 'RES_1K', n: 5 }]);
    await expect(s.checkEligibility('u1', 'NBP', Resolution.RES_1K)).resolves.toMatchObject({ allowed: false, reason: 'daily_budget_reached' });
  });

  it('plano sem orçamento (só vídeo) segue no teto antigo', async () => {
    const s = makeService('pro', [{ modelVariant: 'NB2', resolution: 'RES_1K', n: 20 }]);
    await expect(s.checkEligibility('u1', 'NB2', Resolution.RES_1K)).resolves.toMatchObject({ allowed: true });
  });
});
