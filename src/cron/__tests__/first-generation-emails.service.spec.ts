import { FirstGenerationEmailsService } from '../first-generation-emails.service';

/** D-04: aviso da 1ª cena pronta (> 60 s, ~10 min depois) e da 1ª falha com estorno; 1 vez por conta. */
type Gen = {
  id: string;
  userId: string;
  status: 'COMPLETED' | 'FAILED' | 'PROCESSING';
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
};

const NOW = new Date('2026-11-13T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const user = { email: 'ana@mail.com', locale: 'pt-BR', country: 'BR', signupBrand: null };

function setup(gens: Gen[], refunds: string[] = []) {
  const logs: Array<{ id: string; userId: string; emailKey: string; sequence: string }> = [];
  const inRange = (value: Date | null, range: { gte?: Date; lte?: Date; lt?: Date; gt?: Date }) =>
    value != null &&
    (range.gte == null || value >= range.gte) &&
    (range.lte == null || value <= range.lte) &&
    (range.lt == null || value < range.lt) &&
    (range.gt == null || value > range.gt);
  const filter = (where: any) =>
    gens.filter((g) => {
      if (where.userId && g.userId !== where.userId) return false;
      if (typeof where.status === 'string' && g.status !== where.status) return false;
      if (where.status?.in && !where.status.in.includes(g.status)) return false;
      if (where.completedAt && !inRange(g.completedAt, where.completedAt)) return false;
      if (where.updatedAt && !inRange(g.updatedAt, where.updatedAt)) return false;
      if (where.createdAt && !inRange(g.createdAt, where.createdAt)) return false;
      if (where.user?.emailSequenceLogs?.none) {
        const prefix = where.user.emailSequenceLogs.none.emailKey.startsWith;
        if (logs.some((l) => l.userId === g.userId && l.emailKey.startsWith(prefix))) return false;
      }
      return true;
    });
  const prisma = {
    generation: {
      findMany: jest.fn(async ({ where }: any) => filter(where).map((g) => ({ ...g, user }))),
      count: jest.fn(async ({ where }: any) => filter(where).length),
    },
    creditTransaction: {
      count: jest.fn(async ({ where }: any) => (refunds.includes(where.generationId) ? 1 : 0)),
    },
    emailSequenceLog: {
      create: jest.fn(async ({ data }: any) => {
        if (logs.some((l) => l.userId === data.userId && l.emailKey === data.emailKey)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: `log-${logs.length + 1}`, ...data };
        logs.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
      delete: jest.fn(async ({ where }: any) => {
        logs.splice(logs.findIndex((l) => l.id === where.id), 1);
      }),
    },
  };
  const email = { sendRawEmail: jest.fn(async () => ({ id: 'resend-1' })) };
  const config = {
    get: (key: string) =>
      ({ LIFECYCLE_EMAILS_ENABLED: 'true', FRONTEND_URL: 'https://www.theaimodelab.com' })[key],
  };
  const service = new FirstGenerationEmailsService(prisma as any, email as any, config as any, {} as any);
  return { service, email, logs };
}

const gen = (extra: Partial<Gen>): Gen => ({
  id: 'g1',
  userId: 'u1',
  status: 'COMPLETED',
  createdAt: minutesAgo(17),
  completedAt: minutesAgo(15),
  updatedAt: minutesAgo(15),
  ...extra,
});

describe('FirstGenerationEmailsService', () => {
  it('1ª cena que levou > 60 s: avisa 1 vez, em pt, com banner e CTA para os Reels', async () => {
    const { service, email, logs } = setup([gen({})]);

    expect(await service.runOnce(NOW)).toEqual({ ready: 1, failed: 0 });
    expect(await service.runOnce(NOW)).toEqual({ ready: 0, failed: 0 });

    expect(email.sendRawEmail).toHaveBeenCalledTimes(1);
    const sent = (email.sendRawEmail.mock.calls[0] as any[])[0];
    expect(sent.to).toBe('ana@mail.com');
    expect(sent.subject).toBe('Sua 1ª cena ficou pronta');
    expect(sent.html).toContain('/assets/brand/banners/email-pt-');
    expect(sent.html).toContain('https://www.theaimodelab.com/pt-br/x/reels?utm_source=email&utm_campaign=first_scene_ready');
    expect(logs.map((l) => l.emailKey)).toEqual(['first-gen-ready-u1']);
  });

  it('geração rápida (≤ 60 s), que não é a 1ª, ou cliente que já gerou de novo: não avisa', async () => {
    const fast = setup([gen({ createdAt: minutesAgo(15.5) })]);
    expect((await fast.service.runOnce(NOW)).ready).toBe(0);

    const notFirst = setup([gen({}), gen({ id: 'g0', completedAt: minutesAgo(200), createdAt: minutesAgo(205) })]);
    expect((await notFirst.service.runOnce(NOW)).ready).toBe(0);

    const cameBack = setup([gen({}), gen({ id: 'g2', status: 'PROCESSING', createdAt: minutesAgo(12), completedAt: null })]);
    expect((await cameBack.service.runOnce(NOW)).ready).toBe(0);
  });

  it('ainda dentro dos 10 min: espera', async () => {
    const { service } = setup([gen({ createdAt: minutesAgo(8), completedAt: minutesAgo(5), updatedAt: minutesAgo(5) })]);
    expect((await service.runOnce(NOW)).ready).toBe(0);
  });

  it('1ª falha com estorno: avisa que os créditos voltaram; sem estorno, não avisa', async () => {
    const failed = gen({ status: 'FAILED', completedAt: null });
    const withRefund = setup([failed], ['g1']);
    expect(await withRefund.service.runOnce(NOW)).toEqual({ ready: 0, failed: 1 });
    const sent = (withRefund.email.sendRawEmail.mock.calls[0] as any[])[0];
    expect(sent.subject).toBe('Sua 1ª cena não saiu: os créditos voltaram');

    const noRefund = setup([failed]);
    expect((await noRefund.service.runOnce(NOW)).failed).toBe(0);
  });

  it('se o envio falha, libera a reserva para tentar na próxima rodada', async () => {
    const { service, email, logs } = setup([gen({})]);
    email.sendRawEmail.mockRejectedValueOnce(new Error('resend fora'));
    expect((await service.runOnce(NOW)).ready).toBe(0);
    expect(logs).toHaveLength(0);
    expect((await service.runOnce(NOW)).ready).toBe(1);
  });
});
