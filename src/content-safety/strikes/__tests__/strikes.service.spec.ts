import { Logger } from '@nestjs/common';
import { CommunityPostStatus, ContentSafetyEventKind } from '@prisma/client';
import {
  activeUserCache,
  setActiveUserBroadcast,
} from '../../../auth/strategies/jwt.strategy';
import { AccountSuspendedSafetyError } from '../strikes.errors';
import { StrikesService } from '../strikes.service';
import {
  SAFETY_SUSPENSION_POST_REJECTION_REASON,
  STRIKE_ACCESS_ACTIONS,
  STRIKES_ACTOR_ID,
} from '../strikes.types';
import {
  APPROVED,
  FakeQueue,
  PENDING,
  fakeEffects,
  memoryDb,
  memoryPrisma,
  strikesConfig,
  type MemoryDb,
} from './strikes.harness';

/**
 * Camada 6 · StrikesService: suspensão por sinal forte (conta, sessões, fila, JWT, aviso), pontos médios em 90 dias,
 * repetição por hash na conta e entre contas (sombra × enforce) e o limite de novas tentativas com foto.
 */

const USER = 'cmuser000000000000000001';
const OTHER = 'cmuser000000000000000002';
const NOW = new Date('2026-10-22T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);
const PHASH = '0123456789abcdef';
const SHA = 'a'.repeat(64);

function seedAccounts(): MemoryDb {
  return memoryDb({
    users: [
      {
        id: USER,
        isActive: true,
        email: 'pessoa@exemplo.com',
        name: 'Pessoa',
        locale: 'pt-BR',
      },
      {
        id: OTHER,
        isActive: true,
        email: 'outra@exemplo.com',
        name: 'Outra',
        locale: 'en',
      },
    ],
    refreshTokens: [
      { userId: USER, revoked: false },
      { userId: USER, revoked: false },
      { userId: OTHER, revoked: false },
    ],
    posts: [
      { userId: USER, status: APPROVED, rejectionReason: null },
      { userId: USER, status: PENDING, rejectionReason: null },
      { userId: OTHER, status: APPROVED, rejectionReason: null },
    ],
    generations: [
      { id: 'g-old', userId: USER, expiresAt: daysAgo(-5) },
      { id: 'g-other', userId: OTHER, expiresAt: daysAgo(-5) },
    ],
  });
}

function build(
  mode: 'off' | 'shadow' | 'enforce' = 'shadow',
  db: MemoryDb = seedAccounts(),
  countRecent = 0,
) {
  const prisma = memoryPrisma(db);
  const queue = new FakeQueue();
  const unlimited = new FakeQueue();
  const effects = fakeEffects([
    { name: 'generation', queue, unlimited: false },
    { name: 'generation-unlimited', queue: unlimited, unlimited: true },
  ]);
  const blocklist = {
    match: jest.fn(async () => null),
    add: jest.fn(async () => 'block-x'),
    countRecent: jest.fn(async () => countRecent),
  };
  const env: Record<string, string> = {
    SAFETY_REVIEW_CONTACT: 'revisao@exemplo.com',
  };
  const service = new StrikesService(
    strikesConfig(mode),
    prisma as never,
    blocklist as never,
    effects,
    { get: (key: string) => env[key] } as never,
  );
  return { service, prisma, db, queue, unlimited, effects, blocklist };
}

const userOf = (db: MemoryDb, id: string) =>
  db.users.find((row) => row.id === id)!;

describe('StrikesService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    setActiveUserBroadcast(null);
    activeUserCache.invalidate(USER);
    activeUserCache.invalidate(OTHER);
    jest.restoreAllMocks();
  });

  describe('modo off', () => {
    it('não roda: nada lido, nada gravado, nenhum job tocado', async () => {
      const ctx = build('off');
      ctx.queue.add('j1', { userId: USER, generationId: 'g1' });
      const outcome = await ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
        layer: 'input',
        match: 'E2/STRONG',
        generationId: 'g0',
        now: NOW,
      });
      expect(outcome.action).toBe('none');
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
      expect(ctx.queue.getJobs).not.toHaveBeenCalled();
      expect(userOf(ctx.db, USER).isActive).toBe(true);
      await expect(ctx.service.isSuspended(USER)).resolves.toBe(false);
      await expect(
        ctx.service.photoRetryAllowed(USER, { currentGenerationId: null }),
      ).resolves.toBe(true);
      expect(ctx.service.enabled).toBe(false);
    });
  });

  describe('sinal forte', () => {
    it('suspende na hora: conta inativa, sessões revogadas, posts fora do feed, galeria sem prazo e trilha', async () => {
      const ctx = build('shadow');
      const outcome = await ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
        layer: 'input',
        match: 'E2/STRONG',
        generationId: 'g0',
        now: NOW,
      });
      expect(outcome).toMatchObject({
        action: 'suspended',
        causes: ['strong'],
      });
      expect(userOf(ctx.db, USER).isActive).toBe(false);
      expect(userOf(ctx.db, OTHER).isActive).toBe(true);
      expect(
        ctx.db.refreshTokens.filter(
          (row) => row.userId === USER && !row.revoked,
        ),
      ).toHaveLength(0);
      expect(
        ctx.db.refreshTokens.find((row) => row.userId === OTHER)?.revoked,
      ).toBe(false);
      expect(ctx.db.posts.filter((row) => row.userId === USER)).toEqual([
        expect.objectContaining({
          status: CommunityPostStatus.REJECTED,
          rejectionReason: SAFETY_SUSPENSION_POST_REJECTION_REASON,
        }),
        expect.objectContaining({ status: CommunityPostStatus.REJECTED }),
      ]);
      expect(
        ctx.db.generations.find((row) => row.id === 'g-old')?.expiresAt,
      ).toBeNull();
      expect(
        ctx.db.generations.find((row) => row.id === 'g-other')?.expiresAt,
      ).not.toBeNull();
      expect(ctx.db.accessLog).toEqual([
        expect.objectContaining({
          actorId: STRIKES_ACTOR_ID,
          action: STRIKE_ACCESS_ACTIONS.suspend,
          targetType: 'user',
          targetId: USER,
          reason: expect.stringContaining(
            'sinal forte · input:E2/STRONG · evento evt-1',
          ),
        }),
        // prova do aviso (LGPD art. 20): só o código do resultado, nunca o e-mail
        expect.objectContaining({
          actorId: STRIKES_ACTOR_ID,
          action: STRIKE_ACCESS_ACTIONS.suspendNotice,
          targetType: 'user',
          targetId: USER,
          reason: 'sent',
        }),
      ]);
    });

    it('conta com 3 jobs na fila: os 3 saem e encerram com estorno; job já rodando fica para o preflight; outra conta intacta', async () => {
      const ctx = build('shadow');
      ctx.queue.add('j1', { userId: USER, generationId: 'g1' });
      ctx.queue.add('j2', { userId: USER, generationId: 'g2' }, 'delayed');
      ctx.queue.add('j3', { userId: USER, generationId: 'g3' }, 'prioritized');
      ctx.queue.add('j4', { userId: USER, generationId: 'g4' }, 'active');
      ctx.queue.add('jo', { userId: OTHER, generationId: 'go' });
      // saiu da espera para o worker entre a leitura e a remoção: o BullMQ recusa (travado)
      const racing = ctx.queue.add('j5', { userId: USER, generationId: 'g5' });
      racing.remove = jest.fn(async () => {
        throw new Error(
          'Job j5 could not be removed because it is locked by another worker',
        );
      });
      ctx.unlimited.add('ju', { userId: USER, generationId: 'gu' }, 'delayed');

      await ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
        layer: 'input',
        match: 'E1/STRONG',
        generationId: 'g0',
        now: NOW,
      });

      expect(ctx.queue.jobs.map((job) => job.id)).toEqual(['j4', 'jo', 'j5']);
      expect(ctx.unlimited.jobs).toHaveLength(0);
      const failed = ctx.effects.failGeneration.mock.calls.map(([id]) => id);
      expect(failed.sort()).toEqual(['g1', 'g2', 'g3', 'gu']);
      for (const [, error] of ctx.effects.failGeneration.mock.calls) {
        expect(error).toBeInstanceOf(AccountSuspendedSafetyError);
        expect((error as AccountSuspendedSafetyError).failureCode).toBe(
          'IMAGE_SAFETY_BLOCKED',
        );
        expect((error as AccountSuspendedSafetyError).evidencePending).toBe(
          true,
        );
      }
      expect(ctx.effects.releaseUnlimitedLock).toHaveBeenCalledWith(USER);
      expect(ctx.effects.holdUncheckedOutputs).toHaveBeenCalledWith(USER);
    });

    it('JWT invalidado na hora: cache deste processo limpo e aviso às outras instâncias', async () => {
      const ctx = build('shadow');
      const broadcast = jest.fn();
      setActiveUserBroadcast(broadcast);
      await activeUserCache.resolve(USER, async () => true);
      const lookup = jest.fn(async () => false);
      await expect(activeUserCache.resolve(USER, lookup)).resolves.toBe(true);
      expect(lookup).not.toHaveBeenCalled();

      await ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
        layer: 'output',
        match: 'S1/STRONG',
        generationId: 'g0',
        now: NOW,
      });

      expect(broadcast).toHaveBeenCalledWith(USER);
      await expect(activeUserCache.resolve(USER, lookup)).resolves.toBe(false);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it('aviso com canal de revisão só na 1ª suspensão; o e-mail nunca vai para o log', async () => {
      const ctx = build('shadow');
      const warn = jest.spyOn(Logger.prototype, 'warn');
      await ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
        layer: 'input',
        match: 'E2/STRONG',
        generationId: 'g0',
        now: NOW,
      });
      await ctx.service.applySignal(USER, 'STRONG', 'evt-2', {
        layer: 'input',
        match: 'E6/STRONG',
        generationId: 'g9',
        now: NOW,
      });
      expect(ctx.effects.sendNotice).toHaveBeenCalledTimes(1);
      expect(ctx.effects.sendNotice).toHaveBeenCalledWith({
        to: 'pessoa@exemplo.com',
        subject: 'Sua conta foi suspensa para revisão',
        html: expect.stringContaining('mailto:revisao@exemplo.com'),
      });
      expect(ctx.db.accessLog.map((row) => row.action)).toEqual([
        STRIKE_ACCESS_ACTIONS.suspend,
        STRIKE_ACCESS_ACTIONS.suspendNotice,
      ]);
      // o 2º sinal forte não muda a conta, mas varre de novo a fila e a quarentena (job que entrou no meio)
      expect(ctx.effects.holdUncheckedOutputs).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'pessoa@exemplo.com',
      );
      expect(JSON.stringify(ctx.db.accessLog)).not.toContain(
        'pessoa@exemplo.com',
      );
    });

    it.each([
      ['e-mail desligado', 'failed:not_sent', false],
      ['provedor recusou', 'failed:error', new Error('Resend error')],
    ] as const)(
      'aviso que não sai (%s): a trilha grava a falha e a suspensão segue igual',
      async (_label, expected, outcome) => {
        const ctx = build('shadow');
        if (outcome instanceof Error) {
          ctx.effects.sendNotice.mockRejectedValueOnce(outcome);
        } else {
          ctx.effects.sendNotice.mockResolvedValueOnce(outcome);
        }
        await expect(
          ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
            layer: 'input',
            match: 'E2/STRONG',
            generationId: 'g0',
            now: NOW,
          }),
        ).resolves.toMatchObject({ action: 'suspended' });
        expect(userOf(ctx.db, USER).isActive).toBe(false);
        expect(ctx.db.accessLog).toContainEqual(
          expect.objectContaining({
            action: STRIKE_ACCESS_ACTIONS.suspendNotice,
            targetId: USER,
            reason: expected,
          }),
        );
      },
    );

    it('conta sem e-mail: a trilha grava que o aviso não tinha para onde ir', async () => {
      const ctx = build('shadow');
      userOf(ctx.db, USER).email = null;
      await ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
        layer: 'input',
        match: 'E2/STRONG',
        generationId: 'g0',
        now: NOW,
      });
      expect(ctx.effects.sendNotice).not.toHaveBeenCalled();
      expect(ctx.db.accessLog).toContainEqual(
        expect.objectContaining({
          action: STRIKE_ACCESS_ACTIONS.suspendNotice,
          reason: 'skipped:no_email',
        }),
      );
    });

    it('banco fora na transação: nunca lança, só registra o erro', async () => {
      const ctx = build('shadow');
      ctx.prisma.$transaction.mockRejectedValueOnce(new Error('banco fora'));
      const error = jest.spyOn(Logger.prototype, 'error');
      await expect(
        ctx.service.applySignal(USER, 'STRONG', 'evt-1', {
          layer: 'input',
          match: 'E2/STRONG',
          generationId: 'g0',
          now: NOW,
        }),
      ).resolves.toMatchObject({ causes: ['strong'] });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('não aplicado'),
      );
    });
  });

  describe('pontos médios (3 em 90 dias)', () => {
    const mediumEvent = (
      id: string,
      createdAt: Date,
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      userId: USER,
      kind: ContentSafetyEventKind.INPUT_HELD,
      match: 'E3a/MEDIUM',
      route: 'input:generate',
      generationId: `gen-${id}`,
      releasedAt: null,
      createdAt,
      ...overrides,
    });

    it('1º e 2º ponto não suspendem; o 3º dentro de 90 dias suspende até a revisão', async () => {
      const db = seedAccounts();
      db.events.push(mediumEvent('e1', daysAgo(80)));
      const ctx = build('shadow', db);
      const signal = {
        layer: 'input' as const,
        match: 'E3a/MEDIUM',
        generationId: 'gen-e2',
        now: NOW,
      };

      db.events.push(mediumEvent('e2', daysAgo(1)));
      await expect(
        ctx.service.applySignal(USER, 'MEDIUM', 'e2', signal),
      ).resolves.toMatchObject({
        action: 'point',
        points: 2,
        causes: [],
      });
      expect(userOf(db, USER).isActive).toBe(true);

      db.events.push(mediumEvent('e3', NOW));
      await expect(
        ctx.service.applySignal(USER, 'MEDIUM', 'e3', {
          ...signal,
          generationId: 'gen-e3',
        }),
      ).resolves.toMatchObject({
        action: 'suspended',
        points: 3,
        causes: ['medium_points'],
      });
      expect(userOf(db, USER).isActive).toBe(false);
      expect(ctx.db.accessLog[0].reason).toContain(
        '3 pontos médios em 90 dias',
      );
    });

    it('fora da janela, liberado pelo revisor, forte, sem força e de outra conta não contam; mesma geração conta 1', async () => {
      const db = seedAccounts();
      db.events.push(
        mediumEvent('velho', daysAgo(91)),
        mediumEvent('liberado', daysAgo(2), { releasedAt: daysAgo(1) }),
        mediumEvent('forte', daysAgo(2), { match: 'E2/STRONG' }),
        mediumEvent('texto', daysAgo(2), {
          kind: ContentSafetyEventKind.MINOR_BLOCKED,
          match: '<TERMO_DA_TRAVA>',
        }),
        mediumEvent('outra', daysAgo(2), { userId: OTHER }),
        mediumEvent('a', daysAgo(3), { generationId: 'mesma' }),
        mediumEvent('b', daysAgo(3), { generationId: 'mesma' }),
      );
      const ctx = build('shadow', db);
      await expect(ctx.service.mediumPoints(USER, NOW, 'b')).resolves.toBe(1);
      // o evento deste sinal não foi gravado: soma 1
      await expect(ctx.service.mediumPoints(USER, NOW, null)).resolves.toBe(2);
    });

    it('leve e sem força: nenhum ponto, nenhuma consulta', async () => {
      const ctx = build('shadow');
      await expect(
        ctx.service.applySignal(USER, 'LIGHT', null, {
          layer: 'input',
          match: 'E2/LIGHT',
          generationId: 'g1',
          now: NOW,
        }),
      ).resolves.toMatchObject({ action: 'none', points: 0 });
      expect(ctx.prisma.contentSafetyEvent.findMany).not.toHaveBeenCalled();
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('repetição por hash', () => {
    const photo = { phash: PHASH, sha256: SHA, blockId: null };

    it('3 bloqueios de foto parecida em 24 h: na sombra só registra "teria suspendido"', async () => {
      const ctx = build('shadow', seedAccounts(), 3);
      const outcome = await ctx.service.applySignal(USER, 'MEDIUM', 'evt-1', {
        layer: 'input',
        match: 'E3a/MEDIUM',
        generationId: 'g1',
        photos: [photo],
        now: NOW,
      });
      expect(ctx.blocklist.countRecent).toHaveBeenCalledWith(
        USER,
        PHASH,
        24,
        8,
      );
      expect(outcome).toMatchObject({
        causes: [],
        shadowCauses: ['repeat_hash'],
      });
      expect(userOf(ctx.db, USER).isActive).toBe(true);
      expect(ctx.db.accessLog).toEqual([
        expect.objectContaining({
          action: STRIKE_ACCESS_ACTIONS.suspendShadow,
          targetId: USER,
        }),
      ]);
    });

    it('em enforce, 3 bloqueios de foto parecida em 24 h suspendem para revisão', async () => {
      const ctx = build('enforce', seedAccounts(), 3);
      const outcome = await ctx.service.applySignal(USER, 'MEDIUM', 'evt-1', {
        layer: 'input',
        match: 'E3a/MEDIUM',
        generationId: 'g1',
        photos: [photo],
        now: NOW,
      });
      expect(outcome).toMatchObject({
        action: 'suspended',
        causes: ['repeat_hash'],
      });
      expect(userOf(ctx.db, USER).isActive).toBe(false);
    });

    it('2 bloqueios não bastam', async () => {
      const ctx = build('enforce', seedAccounts(), 2);
      await expect(
        ctx.service.applySignal(USER, 'MEDIUM', 'evt-1', {
          layer: 'input',
          match: 'E3a/MEDIUM',
          generationId: 'g1',
          photos: [photo],
          now: NOW,
        }),
      ).resolves.toMatchObject({ causes: [], shadowCauses: [] });
      expect(userOf(ctx.db, USER).isActive).toBe(true);
    });

    it('entre contas pela lista de bloqueio: em enforce as duas contas vão para revisão', async () => {
      const db = seedAccounts();
      db.blocks.push({ id: 'block-1', eventId: 'evt-da-outra' });
      db.events.push({
        id: 'evt-da-outra',
        userId: OTHER,
        kind: ContentSafetyEventKind.IMAGE_MINOR_BLOCKED,
      });
      const ctx = build('enforce', db);
      const outcome = await ctx.service.applySignal(USER, 'MEDIUM', 'evt-1', {
        layer: 'input',
        match: 'E5/MEDIUM',
        generationId: 'g1',
        photos: [{ phash: PHASH, sha256: null, blockId: 'block-1' }],
        now: NOW,
      });
      expect(outcome).toMatchObject({
        action: 'suspended',
        causes: ['cross_account'],
        linkedAccounts: [OTHER],
      });
      expect(userOf(db, USER).isActive).toBe(false);
      expect(userOf(db, OTHER).isActive).toBe(false);
      expect(
        db.accessLog
          .filter((row) => row.action === STRIKE_ACCESS_ACTIONS.suspend)
          .map((row) => row.targetId)
          .sort(),
      ).toEqual([USER, OTHER].sort());
      expect(ctx.effects.sendNotice).toHaveBeenCalledTimes(2);
    });

    it('entre contas pelo mesmo arquivo barrado (sha256): na sombra só registra, nenhuma conta muda', async () => {
      const db = seedAccounts();
      db.scans.push({
        userId: OTHER,
        generationId: 'g-outra',
        sha256: SHA,
        stage: 'INPUT',
        verdict: 'HOLD',
        enforced: true,
        createdAt: daysAgo(3),
      });
      const ctx = build('shadow', db);
      const outcome = await ctx.service.applySignal(USER, 'MEDIUM', 'evt-1', {
        layer: 'input',
        match: 'E3a/MEDIUM',
        generationId: 'g1',
        photos: [photo],
        now: NOW,
      });
      expect(outcome).toMatchObject({
        causes: [],
        shadowCauses: ['cross_account'],
        linkedAccounts: [OTHER],
      });
      expect(userOf(db, USER).isActive).toBe(true);
      expect(userOf(db, OTHER).isActive).toBe(true);
      expect(db.accessLog).toEqual([
        expect.objectContaining({
          action: STRIKE_ACCESS_ACTIONS.suspendShadow,
          reason: expect.stringContaining(`contas ligadas ${OTHER}`),
        }),
      ]);
    });

    it('a própria conta, linha não agida e arquivo de mais de 90 dias não ligam contas', async () => {
      const db = seedAccounts();
      db.scans.push(
        {
          userId: USER,
          sha256: SHA,
          stage: 'INPUT',
          verdict: 'BLOCK',
          enforced: true,
          createdAt: daysAgo(1),
        },
        {
          userId: OTHER,
          sha256: SHA,
          stage: 'INPUT',
          verdict: 'BLOCK',
          enforced: false,
          createdAt: daysAgo(1),
        },
        {
          userId: OTHER,
          sha256: SHA,
          stage: 'INPUT',
          verdict: 'BLOCK',
          enforced: true,
          createdAt: daysAgo(120),
        },
        {
          userId: OTHER,
          sha256: SHA,
          stage: 'OUTPUT',
          verdict: 'BLOCK',
          enforced: true,
          createdAt: daysAgo(1),
        },
      );
      db.blocks.push({ id: 'block-proprio', eventId: 'evt-proprio' });
      db.events.push({ id: 'evt-proprio', userId: USER });
      const ctx = build('enforce', db);
      await expect(
        ctx.service.applySignal(USER, 'MEDIUM', 'evt-1', {
          layer: 'input',
          match: 'E3a/MEDIUM',
          generationId: 'g1',
          photos: [{ ...photo, blockId: 'block-proprio' }],
          now: NOW,
        }),
      ).resolves.toMatchObject({ causes: [], linkedAccounts: [] });
    });
  });

  describe('limite de novas tentativas com foto', () => {
    const scanRow = (
      minutes: number,
      overrides: Record<string, unknown> = {},
    ) => ({
      userId: USER,
      generationId: `gen-${minutes}`,
      stage: 'INPUT',
      verdict: 'CLEAN',
      enforced: false,
      createdAt: minutesAgo(minutes),
      ...overrides,
    });

    it('sem bloqueio: livre', async () => {
      const db = seedAccounts();
      db.scans.push(scanRow(1), scanRow(2), scanRow(3));
      const ctx = build('shadow', db);
      await expect(
        ctx.service.photoRetryAllowed(USER, {
          currentGenerationId: 'nova',
          now: NOW,
        }),
      ).resolves.toBe(true);
    });

    it('depois de um bloqueio de foto: 1 a cada 10 min', async () => {
      const db = seedAccounts();
      db.scans.push(scanRow(4, { verdict: 'BLOCK', enforced: true }));
      const ctx = build('shadow', db);
      await expect(
        ctx.service.photoRetryAllowed(USER, {
          currentGenerationId: 'nova',
          now: NOW,
        }),
      ).resolves.toBe(false);
      await expect(
        ctx.service.photoRetryAllowed(USER, {
          currentGenerationId: 'nova',
          now: new Date(NOW.getTime() + 7 * 60_000),
        }),
      ).resolves.toBe(true);
    });

    it('5 em 24 h depois do bloqueio', async () => {
      const db = seedAccounts();
      db.scans.push(
        scanRow(300, { verdict: 'BLOCK', enforced: true }),
        scanRow(200),
        scanRow(150),
        scanRow(100),
        scanRow(50),
      );
      const ctx = build('shadow', db);
      await expect(
        ctx.service.photoRetryAllowed(USER, {
          currentGenerationId: 'nova',
          now: NOW,
        }),
      ).resolves.toBe(false);
    });

    it('rota sem fila: bloqueio leve anterior (sem evento, sem geração) também limita a próxima chamada', async () => {
      const db = seedAccounts();
      db.scans.push(
        scanRow(3, { generationId: null, verdict: 'BLOCK', enforced: true }),
      );
      const ctx = build('shadow', db);
      await expect(
        ctx.service.photoRetryAllowed(USER, {
          currentGenerationId: null,
          now: NOW,
        }),
      ).resolves.toBe(false);
      expect(ctx.prisma.contentSafetyEvent.count).not.toHaveBeenCalled();
    });

    it('bloqueio de foto sem revisão há mais de 24 h ainda limita; liberado pelo revisor não', async () => {
      const db = seedAccounts();
      db.scans.push(scanRow(5));
      db.events.push({
        id: 'evt-velho',
        userId: USER,
        kind: ContentSafetyEventKind.INPUT_HELD,
        route: 'input:generate',
        releasedAt: null,
        createdAt: daysAgo(10),
      });
      const ctx = build('shadow', db);
      await expect(
        ctx.service.photoRetryAllowed(USER, {
          currentGenerationId: 'nova',
          now: NOW,
        }),
      ).resolves.toBe(false);
      db.events[0].releasedAt = daysAgo(1);
      await expect(
        ctx.service.photoRetryAllowed(USER, {
          currentGenerationId: 'nova',
          now: NOW,
        }),
      ).resolves.toBe(true);
    });
  });

  it('isSuspended lê a conta (inativa = suspensa)', async () => {
    const ctx = build('shadow');
    await expect(ctx.service.isSuspended(USER)).resolves.toBe(false);
    userOf(ctx.db, USER).isActive = false;
    await expect(ctx.service.isSuspended(USER)).resolves.toBe(true);
    await expect(ctx.service.isSuspended(null)).resolves.toBe(false);
    await expect(ctx.service.isSuspended('sem-conta-000000')).resolves.toBe(
      false,
    );
  });
});
