import { Logger } from '@nestjs/common';
import { GalleryCleanupService } from '../gallery-cleanup.service';
import { erasedEmailFor } from '../../users/account-erasure.service';

type Row = Record<string, any>;

const cid = (tag: string): string => `c${tag}${'0'.repeat(24 - tag.length)}`;
const NOW = new Date('2026-10-16T03:00:00.000Z');
const PAST = new Date('2026-10-01T00:00:00.000Z');
const FUTURE = new Date('2026-12-01T00:00:00.000Z');

interface Seed {
  users: Row[];
  generations: Row[];
  reports?: Row[];
  safetyEvents?: Row[];
  posts?: Row[];
}

/** Prisma em memória com só os filtros que o cron usa. */
function createPrisma(seed: Seed) {
  const users = new Map(seed.users.map((user) => [user.id, user]));
  const generations = seed.generations;
  const reports = seed.reports ?? [];
  const safetyEvents = seed.safetyEvents ?? [];
  const posts = seed.posts ?? [];

  const generationMatches = (generation: Row, where: Row): boolean => {
    if (where.id?.in && !where.id.in.includes(generation.id)) return false;
    if (where.id?.gt && !(generation.id > where.id.gt)) return false;
    if (where.id?.lte && !(generation.id <= where.id.lte)) return false;
    if (
      where.isDeleted !== undefined &&
      generation.isDeleted !== where.isDeleted
    )
      return false;
    if (where.expiresAt?.lte) {
      if (!generation.expiresAt || generation.expiresAt > where.expiresAt.lte)
        return false;
    }
    if (where.user?.isActive !== undefined) {
      if (users.get(generation.userId)?.isActive !== where.user.isActive)
        return false;
    }
    return true;
  };

  const prisma = {
    generation: {
      findMany: jest.fn(async (args: Row) => {
        const rows = generations
          .filter((generation) => generationMatches(generation, args.where))
          .sort((left, right) => (left.id < right.id ? -1 : 1))
          .slice(0, args.take ?? undefined);
        return rows.map((generation) => ({
          id: generation.id,
          userId: generation.userId,
          userAvatarId: generation.userAvatarId ?? null,
          voiceProfileId: generation.voiceProfileId ?? null,
          user: {
            id: generation.userId,
            email: users.get(generation.userId)?.email,
          },
        }));
      }),
      updateMany: jest.fn(async (args: Row) => {
        const rows = generations.filter((generation) =>
          generationMatches(generation, args.where),
        );
        rows.forEach((generation) => Object.assign(generation, args.data));
        return { count: rows.length };
      }),
    },
    contentReport: {
      findMany: jest.fn(async (args: Row) =>
        reports
          .filter(
            (report) =>
              report.status !== args.where.status.not &&
              (!args.where.id?.gt || report.id > args.where.id.gt),
          )
          .sort((left, right) => (left.id < right.id ? -1 : 1))
          .slice(0, args.take),
      ),
    },
    contentSafetyEvent: {
      findMany: jest.fn(async (args: Row) =>
        safetyEvents
          .filter(
            (event) =>
              event.kind === args.where.kind &&
              (args.where.releasedAt !== null || !event.releasedAt) &&
              args.where.generationId.in.includes(event.generationId),
          )
          .map((event) => ({ generationId: event.generationId })),
      ),
    },
    communityPost: {
      findMany: jest.fn(async (args: Row) =>
        posts.filter((post) =>
          args.where.generationId.in.includes(post.generationId),
        ),
      ),
    },
  };
  return prisma;
}

function setup(seed: Seed) {
  const prisma = createPrisma(seed);
  const uploads = {
    deleteByPrefix: jest.fn(async (_prefix: string): Promise<number> => 1),
  };
  const cronLogger = {
    wrap: jest.fn(
      async (_opts: unknown, fn: () => Promise<unknown>): Promise<unknown> =>
        fn(),
    ),
  };
  const service = new GalleryCleanupService(
    prisma as never,
    uploads as never,
    cronLogger as never,
  );
  return { service, prisma, uploads, seed };
}

const generation = (id: string, userId: string, extra: Row = {}): Row => ({
  id,
  userId,
  expiresAt: PAST,
  isDeleted: false,
  userAvatarId: null,
  voiceProfileId: null,
  ...extra,
});

const report = (id: string, target: string, extra: Row = {}): Row => ({
  id,
  category: 'MINOR',
  status: 'OPEN',
  target,
  description: 'Denúncia.',
  evidenceReleasedAt: null,
  ...extra,
});

/** Espera as exclusões de arquivo disparadas sem await pelo cron. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Id de 25 caracteres que ordena pelo prefixo e pelo número. */
const seqId = (prefix: string, index: number): string =>
  `${prefix}${String(index).padStart(25 - prefix.length, '0')}`;

describe('GalleryCleanupService: a limpeza da galeria nunca apaga evidência', () => {
  const ACTIVE = cid('ativa');
  const INACTIVE = cid('inativa');
  const HELD = cid('guardada');
  const ERASED = cid('apagada');
  const G_FREE = cid('glivre');
  const G_FUTURE = cid('gfutura');
  const G_INACTIVE = cid('ginativa');
  const G_HELD = cid('gguardada');
  const G_REPORTED = cid('gdenunciada');
  const G_POST = cid('gpost');
  const P_POST = cid('ppost');
  const G_MINOR = cid('gmenor');
  const G_MINOR_RELEASED = cid('gmenorliberado');
  const G_DISMISSED = cid('gdescartada');
  const G_RELEASED = cid('gliberada');
  const G_AVATAR = cid('gavatar');
  const A1 = cid('avatara');

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick'] });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function baseSeed(): Seed {
    return {
      users: [
        { id: ACTIVE, email: 'ativa@exemplo.com', isActive: true },
        // conta excluída ou bloqueada sem guarda: as gerações vencem como sempre
        { id: INACTIVE, email: 'inativa@exemplo.com', isActive: false },
        // conta sob guarda legal: a guarda tirou o prazo de todas as gerações (expiresAt = null)
        { id: HELD, email: 'guardada@exemplo.com', isActive: false },
      ],
      generations: [
        generation(G_FREE, ACTIVE),
        generation(G_FUTURE, ACTIVE, { expiresAt: FUTURE }),
        generation(G_INACTIVE, INACTIVE),
        generation(G_HELD, HELD, { expiresAt: null }),
        generation(G_REPORTED, ACTIVE),
        generation(G_POST, ACTIVE),
        generation(G_MINOR, ACTIVE),
        generation(G_MINOR_RELEASED, ACTIVE),
        generation(G_DISMISSED, ACTIVE),
        generation(G_RELEASED, ACTIVE),
        generation(G_AVATAR, ACTIVE, { userAvatarId: A1 }),
      ],
      posts: [{ id: P_POST, generationId: G_POST }],
      reports: [
        report(
          'r-gen',
          `https://www.theaimodelab.com/g/${G_REPORTED.toUpperCase()}`,
        ),
        report('r-post', `https://www.theaimodelab.com/comunidade/${P_POST}`, {
          category: 'COPYRIGHT',
          status: 'IN_REVIEW',
        }),
        report('r-avatar', A1, { category: 'IMPERSONATION' }),
        report('r-dismissed', G_DISMISSED, { status: 'DISMISSED' }),
        report('r-released', G_RELEASED, {
          status: 'ACTIONED',
          evidenceReleasedAt: new Date('2026-10-10T00:00:00.000Z'),
        }),
      ],
      safetyEvents: [
        {
          id: 'mb-1',
          kind: 'MINOR_BLOCKED',
          route: 'provider:veo3-fast',
          generationId: G_MINOR,
        },
        // liberado pelo jurídico: a geração volta a vencer
        {
          id: 'mb-2',
          kind: 'MINOR_BLOCKED',
          route: 'provider:veo3-fast',
          generationId: G_MINOR_RELEASED,
          releasedAt: new Date('2026-10-12T00:00:00.000Z'),
        },
        // evento de outro tipo não conta
        {
          id: 'ca-1',
          kind: 'CONSENT_ATTESTED',
          route: '/x',
          generationId: G_FREE,
        },
      ],
    };
  }

  it('pula geração citada por denúncia em aberto (geração, post, avatar) e bloqueio por menor; conta sem guarda vence como sempre', async () => {
    const ctx = setup(baseSeed());

    const result = await ctx.service.handleGalleryCleanup();
    await flush();

    expect(result).toEqual({
      expiredFound: 5,
      keptAsEvidence: 4,
      scanCapped: false,
    });
    const deleted = ctx.seed.generations
      .filter((row) => row.isDeleted)
      .map((row) => row.id)
      .sort();
    // descartada, com a evidência liberada, bloqueio liberado e conta inativa sem guarda voltam a vencer normalmente
    expect(deleted).toEqual(
      [G_DISMISSED, G_FREE, G_RELEASED, G_MINOR_RELEASED, G_INACTIVE].sort(),
    );
    for (const kept of [
      G_HELD,
      G_REPORTED,
      G_POST,
      G_MINOR,
      G_AVATAR,
      G_FUTURE,
    ]) {
      expect([
        kept,
        ctx.seed.generations.find((row) => row.id === kept)!.isDeleted,
      ]).toEqual([kept, false]);
    }
    const prefixes = ctx.uploads.deleteByPrefix.mock.calls.map(
      ([prefix]) => prefix,
    );
    for (const kept of [G_HELD, G_REPORTED, G_POST, G_MINOR, G_AVATAR]) {
      expect(prefixes.some((prefix) => prefix.includes(kept))).toBe(false);
    }
    // prefixo mantido de propósito até o TKT-132 (ver o comentário no serviço)
    expect(prefixes).toContain(`outputs/${G_FREE}/`);
    expect(prefixes).toContain(`thumbnails/${G_FREE}/`);
    // a consulta não filtra mais por conta ativa (quem protege a conta sob guarda é o prazo nulo)
    for (const [args] of ctx.prisma.generation.findMany.mock.calls) {
      expect(args.where.user).toBeUndefined();
    }
  });

  it('denúncia que cita o perfil ou o e-mail da dona segura todas as gerações dela', async () => {
    const seed = baseSeed();
    seed.reports = [
      report(
        'r-profile',
        `https://www.theaimodelab.com/community/users/${ACTIVE}`,
      ),
    ];
    seed.safetyEvents = [];
    const byProfile = setup(seed);
    await expect(byProfile.service.selectExpired(NOW)).resolves.toMatchObject({
      // só a da conta inativa sem guarda sai
      expired: [G_INACTIVE],
      keptAsEvidence: 8,
    });

    const byEmail = setup({
      ...baseSeed(),
      reports: [report('r-email', 'Conta ATIVA@exemplo.com')],
      safetyEvents: [],
    });
    await expect(byEmail.service.selectExpired(NOW)).resolves.toMatchObject({
      expired: [G_INACTIVE],
      keptAsEvidence: 8,
    });

    // conta já anonimizada: o e-mail original não está mais gravado, então só id citado segura
    const erased = setup({
      users: [{ id: ERASED, email: erasedEmailFor(ERASED), isActive: false }],
      generations: [generation(cid('gapagada'), ERASED)],
      reports: [report('r-original-email', 'Conta antiga@exemplo.com')],
    });
    await expect(erased.service.selectExpired(NOW)).resolves.toMatchObject({
      expired: [cid('gapagada')],
      keptAsEvidence: 0,
    });
  });

  it('as gerações que ficam não travam a fila: a leitura passa para a próxima página', async () => {
    const OWNER = cid('dona');
    const held = Array.from({ length: 200 }, (_, index) =>
      generation(seqId('ca', index), OWNER),
    );
    const free = Array.from({ length: 5 }, (_, index) =>
      generation(seqId('cb', index), ACTIVE),
    );
    const ctx = setup({
      users: [
        { id: OWNER, email: 'dona@exemplo.com', isActive: true },
        { id: ACTIVE, email: 'ativa@exemplo.com', isActive: true },
      ],
      generations: [...held, ...free],
      reports: [report('r-owner', `perfil ${OWNER}`)],
    });

    const selection = await ctx.service.selectExpired(NOW);

    expect(selection).toEqual({
      expired: free.map((row) => row.id),
      keptAsEvidence: 200,
      scanCapped: false,
    });
    expect(ctx.prisma.generation.findMany).toHaveBeenCalledTimes(2);
    // as denúncias são lidas uma vez por rodada
    expect(ctx.prisma.contentReport.findMany).toHaveBeenCalledTimes(1);
  });

  it('mais evidência do que o teto de páginas: a rodada seguinte continua de onde parou (a fila não trava)', async () => {
    const OWNER = cid('dona');
    const held = Array.from({ length: 2100 }, (_, index) =>
      generation(seqId('ca', index), OWNER),
    );
    const free = Array.from({ length: 5 }, (_, index) =>
      generation(seqId('cb', index), ACTIVE),
    );
    const ctx = setup({
      users: [
        { id: OWNER, email: 'dona@exemplo.com', isActive: true },
        { id: ACTIVE, email: 'ativa@exemplo.com', isActive: true },
      ],
      generations: [...held, ...free],
      reports: [report('r-owner', `perfil ${OWNER}`)],
    });

    // 1ª rodada: 10 páginas só de evidência; volta cedo, mas diz que parou no teto
    const first = await ctx.service.handleGalleryCleanup();
    expect(first).toEqual({
      expiredFound: 0,
      keptAsEvidence: 2000,
      scanCapped: true,
    });
    expect(ctx.prisma.generation.updateMany).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining('resumes from where this one stopped'),
    );

    // 2ª rodada: começa depois da última lida e acha as livres
    const second = await ctx.service.handleGalleryCleanup();
    await flush();
    expect(second).toMatchObject({ expiredFound: 5 });
    const firstPageOfSecondRun =
      ctx.prisma.generation.findMany.mock.calls[10][0];
    expect(firstPageOfSecondRun.where.id).toEqual({ gt: held[1999].id });
    expect(
      ctx.seed.generations.filter((row) => row.isDeleted).map((row) => row.id),
    ).toEqual(free.map((row) => row.id));
  });

  it('a leitura dá a volta: vencida com id menor que o ponto de partida é achada; a volta inteira recomeça do começo', async () => {
    const OWNER = cid('dona');
    const held = Array.from({ length: 2100 }, (_, index) =>
      generation(seqId('cb', index), OWNER),
    );
    const ctx = setup({
      users: [
        { id: OWNER, email: 'dona@exemplo.com', isActive: true },
        { id: ACTIVE, email: 'ativa@exemplo.com', isActive: true },
      ],
      generations: [...held],
      reports: [report('r-owner', `perfil ${OWNER}`)],
    });

    const first = await ctx.service.selectExpired(NOW);
    expect(first).toMatchObject({ expired: [], scanCapped: true });

    // vence depois da 1ª rodada, com id antes do ponto de partida
    const early = generation(seqId('ca', 1), ACTIVE);
    ctx.seed.generations.push(early);
    const second = await ctx.service.selectExpired(NOW);
    expect(second.expired).toEqual([early.id]);
    // 1 página até o fim (100) + a volta do começo
    expect(second.keptAsEvidence).toBeGreaterThanOrEqual(100);
    const calls = ctx.prisma.generation.findMany.mock.calls.slice(10);
    expect(calls[0][0].where.id).toEqual({ gt: held[1999].id });
    expect(calls[1][0].where.id).toEqual({ lte: held[1999].id });

    // terminou a volta (achou tudo dentro do teto): a próxima começa do começo
    const small = setup({
      users: [{ id: ACTIVE, email: 'ativa@exemplo.com', isActive: true }],
      generations: [generation(G_FREE, ACTIVE)],
    });
    await small.service.selectExpired(NOW);
    await small.service.selectExpired(NOW);
    for (const [args] of small.prisma.generation.findMany.mock.calls) {
      expect(args.where.id).toBeUndefined();
    }
  });

  it('trava na escrita: geração que perdeu o prazo entre a leitura e a escrita não sai', async () => {
    const ctx = setup(baseSeed());
    // a guarda legal roda no meio: tira o prazo de G_FREE
    ctx.prisma.generation.updateMany.mockImplementationOnce(
      async (args: Row) => {
        ctx.seed.generations.find((row) => row.id === G_FREE)!.expiresAt = null;
        const rows = ctx.seed.generations.filter(
          (row) =>
            args.where.id.in.includes(row.id) &&
            row.isDeleted === false &&
            row.expiresAt !== null &&
            row.expiresAt <= args.where.expiresAt.lte,
        );
        rows.forEach((row) => Object.assign(row, args.data));
        return { count: rows.length };
      },
    );

    const result = await ctx.service.handleGalleryCleanup();
    await flush();

    const where = ctx.prisma.generation.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      isDeleted: false,
      expiresAt: { lte: NOW },
    });
    // conta ativa não é mais trava: conta sem guarda vence normalmente
    expect(where.user).toBeUndefined();
    expect(result).toMatchObject({ expiredFound: 4, scanCapped: false });
    expect(
      ctx.seed.generations.find((row) => row.id === G_FREE)!.isDeleted,
    ).toBe(false);
    const prefixes = ctx.uploads.deleteByPrefix.mock.calls.map(
      ([prefix]) => prefix,
    );
    expect(prefixes.some((prefix) => prefix.includes(G_FREE))).toBe(false);
    expect(prefixes).toContain(`thumbnails/${G_DISMISSED}/`);
  });

  it('nada vencido: não escreve nada e ainda diz se a leitura parou no teto', async () => {
    const ctx = setup({
      users: [{ id: ACTIVE, email: 'ativa@exemplo.com', isActive: true }],
      generations: [generation(G_FUTURE, ACTIVE, { expiresAt: FUTURE })],
    });
    await expect(ctx.service.handleGalleryCleanup()).resolves.toEqual({
      expiredFound: 0,
      keptAsEvidence: 0,
      scanCapped: false,
    });
    expect(ctx.prisma.generation.updateMany).not.toHaveBeenCalled();
    expect(ctx.uploads.deleteByPrefix).not.toHaveBeenCalled();
  });
});
