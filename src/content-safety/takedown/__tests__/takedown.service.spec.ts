import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { StorageReadError } from '../../../uploads/uploads.service';
import type { ImageSafetyConfig } from '../../image-safety/image-safety.config';
import type { SafetyMediaToolkit } from '../../image-safety/image-safety.service';
import type { BlocklistEntryInput } from '../../image-safety/types';
import type { PurgeOutcome } from '../cdn-purge.service';
import {
  PURGE_MAX_ATTEMPTS,
  PURGE_RETRY_MIN_AGE_MS,
  TAKEDOWN_POST_REJECTION_REASON,
  TakedownService,
} from '../takedown.service';

/*
 * Remoção com banco, storage, CDN, lista de bloqueio e leitor de mídia SIMULADOS: nenhuma imagem de verdade. Cada
 * "arquivo" é um texto `img:<pHash>:<variação>` (o leitor simulado devolve o pHash escrito nele) ou
 * `vid:<pHash>,<pHash>` (um pHash por quadro). O sha256 é o dos bytes, como no serviço.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const HOUR = 60 * 60_000;
const NEAR = 'fffffffffffffff0'; // distância 4 de FULL
const FULL = 'ffffffffffffffff';
const FAR = '0000000000000000'; // distância 64 de FULL

const gid = (n: number) => `cgen${String(n).padStart(21, '0')}`;
const publicUrl = (key: string) => `https://cdn.test/pub/${key}`;
const outputKey = (generationId: string, file = 'out.png') => `generations/${generationId}/u1/${file}`;
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex');

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key] ?? null;
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      return cond instanceof Date ? value instanceof Date && value.getTime() === cond.getTime() : value === cond;
    }
    const ops = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown; lt?: number | Date; lte?: number | Date };
    const num = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
    if (ops.in && !ops.in.includes(value)) return false;
    if (ops.notIn && ops.notIn.includes(value)) return false;
    if ('not' in ops && ops.not === null && value === null) return false;
    if (ops.lt !== undefined && !(num(value) < num(ops.lt))) return false;
    if (ops.lte !== undefined && !(num(value) <= num(ops.lte))) return false;
    return true;
  });
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    row[key] =
      value && typeof value === 'object' && 'increment' in (value as object)
        ? Number(row[key] ?? 0) + (value as { increment: number }).increment
        : value;
  }
}

interface GenerationFixture {
  id: string;
  userId: string;
  outputs: Array<{ id: string; url: string; thumbnailUrl: string | null }>;
  inputImages: Array<{ url: string | null }>;
}

interface Options {
  report?: Partial<Row>;
  generations?: GenerationFixture[];
  posts?: Row[];
  scans?: Row[];
  retained?: Set<string>;
  evidenceStorage?: boolean;
  cdnConfigured?: boolean;
  /** chaves cuja leitura falha (storage fora) */
  unreadable?: Set<string>;
  /** chaves que o storage se recusa a apagar */
  undeletable?: Set<string>;
  accessLogFails?: boolean;
}

function setup(opts: Options = {}) {
  const report: Row = {
    id: 'rep-1',
    category: 'SELF_DEPICTED',
    status: 'OPEN',
    target: 'é a minha foto',
    description: 'Sou eu nessa imagem e não autorizei.',
    isDepictedPerson: true,
    takedownDueAt: new Date(Date.now() + 40 * HOUR),
    takedownDoneAt: null,
    evidenceReleasedAt: null,
    evidenceReleasedBy: null,
    handledAt: null,
    handledBy: null,
    ...opts.report,
  };
  const generations: Row[] = (opts.generations ?? []).map((generation) => ({ ...generation, isDeleted: false }));
  const outputs: Row[] = generations.flatMap((generation) =>
    (generation.outputs as Row[]).map((output) => ({ ...output, generationId: generation.id, blurDataUrl: 'data:borrado' })),
  );
  const posts: Row[] = (opts.posts ?? []).map((post) => ({ ...post }));
  const items: Row[] = [];
  const accessLog: Row[] = [];
  const order: string[] = [];

  const prisma = {
    contentReport: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === report.id ? { ...report } : null)),
      update: jest.fn(async ({ data }: { data: Row }) => {
        apply(report, data);
        return { ...report };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        if (!matches(report, where)) return { count: 0 };
        apply(report, data);
        return { count: 1 };
      }),
    },
    generation: {
      findMany: jest.fn(async ({ where }: { where: Where }) => generations.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const hit = generations.filter((row) => matches(row, where));
        hit.forEach((row) => apply(row, data));
        return { count: hit.length };
      }),
    },
    generationOutput: {
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const hit = outputs.filter((row) => matches(row, where));
        hit.forEach((row) => apply(row, data));
        return { count: hit.length };
      }),
    },
    communityPost: {
      findMany: jest.fn(async ({ where }: { where: Where }) => posts.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const hit = posts.filter((row) => matches(row, where));
        hit.forEach((row) => apply(row, data));
        return { count: hit.length };
      }),
    },
    contentSafetyAccessLog: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (opts.accessLogFails) throw new Error('banco fora do ar');
        order.push('access_log');
        accessLog.push(data);
        return { id: `log-${accessLog.length}`, ...data };
      }),
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        accessLog.push(...data);
        return { count: data.length };
      }),
    },
    contentSafetyScan: {
      findMany: jest.fn(async ({ where, take }: { where: Where; take?: number }) =>
        (opts.scans ?? []).filter((row) => matches(row, where)).slice(0, take),
      ),
    },
    contentTakedownItem: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        const now = new Date();
        const row: Row = {
          id: `item-${items.length + 1}`,
          generationId: null,
          area: null,
          mediaKey: null,
          publicUrl: null,
          sha256: null,
          phashes: [],
          blockIds: [],
          detail: null,
          evidenceKey: null,
          purgeError: null,
          purgeAttempts: 0,
          purgedAt: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        items.push(row);
        return { ...row };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = items.find((item) => item.id === where.id) as Row;
        apply(row, { ...data, updatedAt: new Date() });
        return { ...row };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const hit = items.filter((row) => matches(row, where));
        hit.forEach((row) => apply(row, { ...data, updatedAt: new Date() }));
        return { count: hit.length };
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) => items.filter((row) => matches(row, where)).map((row) => ({ ...row }))),
      count: jest.fn(async ({ where }: { where: Where }) => items.filter((row) => matches(row, where)).length),
    },
  };

  /** storage simulado: `${área}:${chave}` → bytes */
  const storage = new Map<string, { body: Buffer; contentType: string }>();
  const deleted: string[] = [];
  const uploads = {
    privateInputsEnabled: false,
    locateStoredMedia: jest.fn((url: string | null | undefined) => {
      if (!url) return null;
      const clean = url.split('?')[0];
      for (const [prefix, area] of [
        ['https://cdn.test/pub/', 'public'],
        ['https://s3.test/quarantine/', 'quarantine'],
        ['https://s3.test/evidence/', 'evidence'],
      ] as const) {
        if (clean.startsWith(prefix)) return { area, key: clean.slice(prefix.length) };
      }
      return null;
    }),
    readStoredObject: jest.fn(async (area: string, key: string) => {
      if (opts.unreadable?.has(key)) throw new StorageReadError('failed', area as never);
      const stored = storage.get(`${area}:${key}`);
      if (!stored) throw new StorageReadError('not_found', area as never);
      return { ...stored };
    }),
    moveToEvidence: jest.fn(async (area: string, key: string, sha256: string | null, options: { body?: Buffer }) => {
      order.push(`evidence:${key}`);
      const evidenceKey = `evidence/${sha256}/x/${key.split('/').pop()}`;
      storage.set(`evidence:${evidenceKey}`, { body: options.body as Buffer, contentType: 'image/png' });
      // como o serviço real: apaga a origem "em silêncio" (falha vira log)
      if (!opts.undeletable?.has(key)) storage.delete(`${area}:${key}`);
      return evidenceKey;
    }),
    deleteStoredObject: jest.fn(async (area: string, key: string) => {
      if (area === 'evidence') throw new Error('o teste nunca deveria apagar evidência');
      if (opts.undeletable?.has(key)) throw new Error('AccessDenied');
      order.push(`delete:${key}`);
      deleted.push(`${area}:${key}`);
      storage.delete(`${area}:${key}`);
    }),
  };
  const put = (area: string, key: string, body: string, contentType = 'image/png') =>
    storage.set(`${area}:${key}`, { body: Buffer.from(body), contentType });

  const blocks: BlocklistEntryInput[] = [];
  const blocklist = {
    add: jest.fn(async (entry: BlocklistEntryInput) => {
      blocks.push(entry);
      return `block-${blocks.length}`;
    }),
    match: jest.fn(),
    countRecent: jest.fn(),
  };
  const config = {
    evidenceBucket: opts.evidenceStorage === false ? null : 'evidencia',
    thresholds: { phashMaxDistance: 8 },
    video: { maxFrames: 12, everySeconds: 2, sceneThreshold: 0.3 },
  } as unknown as ImageSafetyConfig;
  const phashOf = (body: Buffer) => {
    const text = body.toString();
    if (!text.startsWith('img:')) throw new Error('não é imagem');
    return text.slice(4, 20);
  };
  const media: SafetyMediaToolkit = {
    normalizeImage: jest.fn(),
    phash: jest.fn(async (image: Buffer) => phashOf(image)),
    sampleVideoFrames: jest.fn(async (buffer: Buffer) =>
      buffer
        .toString()
        .slice(4)
        .split(',')
        .map((phash, index) => ({ jpeg: Buffer.from(`img:${phash}`), position: { index, timeMs: index * 2000 } })),
    ),
  };
  const purged: string[][] = [];
  const cdn = {
    configured: opts.cdnConfigured ?? true,
    unavailableReason: opts.cdnConfigured === false ? 'CLOUDFLARE_PURGE_TOKEN e CLOUDFLARE_ZONE_ID ausentes: purga do CDN pendente' : null,
    purgeUrls: jest.fn(async (urls: string[]) => {
      order.push('purge');
      purged.push(urls);
      const outcome: PurgeOutcome = cdn.configured ? { status: 'done' } : { status: 'pending', reason: cdn.unavailableReason as string };
      return new Map<string, PurgeOutcome>(urls.map((url): [string, PurgeOutcome] => [url, outcome]));
    }),
  };
  const retention = {
    reasonsFor: jest.fn(
      async (subjects: Array<{ id: string }>): Promise<Map<string, string | null>> =>
        new Map(
          subjects.map((subject): [string, string | null] => [
            subject.id,
            opts.retained?.has(subject.id) ? 'guarda legal da conta (report)' : null,
          ]),
        ),
    ),
  };
  const service = new TakedownService(
    prisma as never,
    uploads as never,
    blocklist,
    config,
    media,
    cdn as never,
    retention as never,
  );
  const actor = { id: 'revisor-1', email: 'revisor@taml.com' };
  const run = (extra: Partial<Parameters<TakedownService['execute']>[0]> = {}) =>
    service.execute({ reportId: 'rep-1', reason: 'pedido válido da própria pessoa', actor, ip: '203.0.113.5', ...extra });
  return { service, prisma, uploads, put, storage, deleted, blocks, cdn, purged, report, generations, outputs, posts, items, accessLog, order, retention, run };
}

/** Geração com uma saída pública (imagem) e a miniatura. */
function generationWith(n: number, opts: { userId?: string; file?: string } = {}): GenerationFixture {
  const id = gid(n);
  const key = outputKey(id, opts.file);
  return {
    id,
    userId: opts.userId ?? 'dona-1',
    outputs: [{ id: `out-${n}`, url: publicUrl(key), thumbnailUrl: publicUrl(`thumbnails/${id}/u1/thumb.webp`) }],
    inputImages: [],
  };
}

describe('TakedownService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sem guarda legal: apaga do público (saída e miniatura), põe o hash na lista de bloqueio, purga o CDN e fecha o prazo', async () => {
    const generation = generationWith(1);
    const env = setup({
      report: { category: 'COPYRIGHT', isDepictedPerson: false, takedownDueAt: null, target: `https://www.theaimodelab.com/g/${generation.id}` },
      generations: [generation],
      posts: [{ id: 'post-1', generationId: generation.id, mediaUrl: generation.outputs[0].url, thumbnailUrl: null, status: 'APPROVED' }],
    });
    const body = `img:${FULL}:original`;
    env.put('public', outputKey(generation.id), body);
    env.put('public', `thumbnails/${generation.id}/u1/thumb.webp`, `img:${FULL}:miniatura`);

    const result = await env.run();

    expect(result.complete).toBe(true);
    expect(env.deleted).toEqual([`public:${outputKey(generation.id)}`, `public:thumbnails/${generation.id}/u1/thumb.webp`]);
    expect(env.uploads.moveToEvidence).not.toHaveBeenCalled();
    expect(env.storage.size).toBe(0);
    // registro ANTES de mexer em qualquer arquivo, purga só DEPOIS de todo arquivo sair
    expect(env.order[0]).toBe('access_log');
    expect(env.order[env.order.length - 1]).toBe('purge');
    expect(env.accessLog[0]).toMatchObject({ actorId: 'revisor-1', action: 'takedown', targetType: 'report', targetId: 'rep-1', ip: '203.0.113.5' });
    expect(env.accessLog).toContainEqual(expect.objectContaining({ targetType: 'generation', targetId: generation.id }));
    // lista de bloqueio: só a saída (miniatura é derivada), origem denúncia, força média, com o sha256 do arquivo
    expect(env.blocks).toEqual([{ phash: FULL, sha256: sha(Buffer.from(body)), strength: 'MEDIUM', origin: 'report', eventId: null }]);
    expect(env.purged).toEqual([[generation.outputs[0].url, generation.outputs[0].thumbnailUrl]]);
    expect(result.purge).toMatchObject({ done: 2, pending: 0 });
    expect(result.items.map((item) => [item.role, item.action, item.purgeStatus])).toEqual([
      ['output', 'deleted', 'done'],
      ['thumbnail', 'deleted', 'done'],
    ]);
    // galeria, borrado e comunidade
    expect(env.generations[0].isDeleted).toBe(true);
    expect(env.outputs[0].blurDataUrl).toBeNull();
    expect(env.posts[0]).toMatchObject({ status: 'REJECTED', rejectionReason: TAKEDOWN_POST_REJECTION_REASON });
    // denúncia: removida, com quem e quando
    expect(env.report).toMatchObject({ status: 'ACTIONED', handledBy: 'revisor@taml.com', takedownDoneAt: expect.any(Date) });
  });

  it('com guarda legal ("sou a pessoa da imagem"): o arquivo vai para a evidência e sai do público; a evidência nunca é apagada', async () => {
    const generation = generationWith(2);
    const env = setup({ report: { target: generation.outputs[0].url }, generations: [generation], retained: new Set([generation.id]) });
    env.put('public', outputKey(generation.id), `img:${FULL}:x`);
    env.put('public', `thumbnails/${generation.id}/u1/thumb.webp`, `img:${FULL}:t`);

    const result = await env.run();

    expect(result.complete).toBe(true);
    expect(env.uploads.moveToEvidence).toHaveBeenCalledTimes(2);
    // a mudança confere que a origem saiu (apaga de novo, idempotente)
    expect(env.deleted).toEqual([`public:${outputKey(generation.id)}`, `public:thumbnails/${generation.id}/u1/thumb.webp`]);
    expect([...env.storage.keys()].every((key) => key.startsWith('evidence:'))).toBe(true);
    expect(result.items.map((item) => [item.action, item.evidence])).toEqual([
      ['moved_to_evidence', true],
      ['moved_to_evidence', true],
    ]);
    expect(env.items[0].detail).toContain('guarda legal');
    expect(env.items[0].evidenceKey).toMatch(/^evidence\//);
    expect(env.report).toMatchObject({ status: 'ACTIONED', takedownDoneAt: expect.any(Date) });
    expect(result.report.takedown).toMatchObject({ state: 'done' });
  });

  it('arquivo que já é evidência não é tocado', async () => {
    const generation: GenerationFixture = {
      id: gid(3),
      userId: 'dona-1',
      outputs: [{ id: 'out-3', url: 'https://s3.test/evidence/evidence/abc/u/out.png?X-Amz-Expires=120', thumbnailUrl: null }],
      inputImages: [],
    };
    const env = setup({ report: { target: generation.id }, generations: [generation] });
    const result = await env.run();
    expect(result.items).toEqual([expect.objectContaining({ action: 'already_evidence', purgeStatus: 'none', evidence: true })]);
    expect(env.uploads.readStoredObject).not.toHaveBeenCalled();
    expect(env.uploads.deleteStoredObject).not.toHaveBeenCalled();
  });

  it('guarda legal sem bucket de evidência: 409 e nada é removido (nem registro de ação que não aconteceu)', async () => {
    const generation = generationWith(4);
    const env = setup({ report: { target: generation.id }, generations: [generation], retained: new Set([generation.id]), evidenceStorage: false });
    env.put('public', outputKey(generation.id), `img:${FULL}:x`);
    await expect(env.run()).rejects.toMatchObject({ response: { code: 'TAKEDOWN_EVIDENCE_STORAGE_MISSING' } });
    expect(env.storage.size).toBe(1);
    expect(env.accessLog).toHaveLength(0);
    expect(env.report.status).toBe('OPEN');
  });

  it('com guarda e storage fora: nada é apagado, item com falha, denúncia em análise e o prazo continua correndo', async () => {
    const generation = generationWith(5);
    const env = setup({
      report: { target: generation.id },
      generations: [generation],
      retained: new Set([generation.id]),
      unreadable: new Set([outputKey(generation.id)]),
    });
    env.put('public', outputKey(generation.id), `img:${FULL}:x`);
    env.put('public', `thumbnails/${generation.id}/u1/thumb.webp`, `img:${FULL}:t`);

    const result = await env.run();

    expect(result.complete).toBe(false);
    expect(result.items[0]).toMatchObject({ role: 'output', action: 'failed', purgeStatus: 'none' });
    expect(env.storage.has(`public:${outputKey(generation.id)}`)).toBe(true);
    expect(env.report).toMatchObject({ status: 'IN_REVIEW', takedownDoneAt: null });
    expect(result.report.takedown).toMatchObject({ state: 'pending' });
  });

  it('evidência guardada, mas o storage recusa apagar do público: falha visível, com a chave da evidência, e sem purga', async () => {
    const generation = generationWith(22);
    generation.outputs[0].thumbnailUrl = null;
    const env = setup({
      report: { target: generation.id },
      generations: [generation],
      retained: new Set([generation.id]),
      undeletable: new Set([outputKey(generation.id)]),
    });
    env.put('public', outputKey(generation.id), `img:${FULL}:x`);

    const result = await env.run();

    expect(result.complete).toBe(false);
    expect(result.items[0]).toMatchObject({ action: 'failed', evidence: true, purgeStatus: 'none' });
    expect(env.items[0].detail).toContain('evidência guardada, mas o storage recusou apagar a origem');
    expect(env.items[0].evidenceKey).toMatch(/^evidence\//);
    // o arquivo ainda está no público: nada de lista de bloqueio "como se tivesse saído", nem prazo fechado
    expect(env.blocks).toHaveLength(0);
    expect(env.cdn.purgeUrls).not.toHaveBeenCalled();
    expect(env.report).toMatchObject({ status: 'IN_REVIEW', takedownDoneAt: null });
  });

  it('arquivo que já não existe: not_found, mas o CDN é purgado (a cópia em cache ainda serve)', async () => {
    const generation = generationWith(6);
    const env = setup({ report: { target: generation.id }, generations: [generation] });
    const result = await env.run();
    expect(result.items.map((item) => [item.action, item.purgeStatus])).toEqual([
      ['not_found', 'done'],
      ['not_found', 'done'],
    ]);
    expect(env.purged[0]).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  describe('purga do CDN', () => {
    it('sem token: o arquivo sai do bucket e a purga fica pendente com o motivo; a varredura com token purga depois', async () => {
      const generation = generationWith(7);
      generation.outputs[0].thumbnailUrl = null;
      const env = setup({
        report: { category: 'COPYRIGHT', isDepictedPerson: false, target: generation.id },
        generations: [generation],
        cdnConfigured: false,
      });
      env.put('public', outputKey(generation.id), `img:${FULL}:x`);

      const result = await env.run();

      expect(result.complete).toBe(true);
      expect(env.deleted).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ action: 'deleted', purgeStatus: 'pending', purgeError: expect.stringContaining('CLOUDFLARE_PURGE_TOKEN') });
      expect(env.items[0].purgeAttempts).toBe(0); // falta de configuração não gasta tentativa
      expect(result.purge).toMatchObject({ pending: 1, done: 0 });
      // o arquivo saiu do bucket (removida), mas o CDN ainda serve a cópia: o prazo NÃO fecha
      expect(env.report).toMatchObject({ status: 'ACTIONED', takedownDoneAt: null });
      expect(result.report.takedown).toMatchObject({ state: 'pending', doneAt: null });

      // sem token a varredura não tenta nada
      await expect(env.service.retryPendingPurges(new Date(Date.now() + PURGE_RETRY_MIN_AGE_MS + 1))).resolves.toMatchObject({
        attempted: 0,
        notConfigured: true,
      });
      expect(env.cdn.purgeUrls).toHaveBeenCalledTimes(1);
      expect(env.report.takedownDoneAt).toBeNull();

      // o token chega: a próxima varredura purga e fecha o prazo
      env.cdn.configured = true;
      env.cdn.unavailableReason = null;
      const sweepAt = new Date(Date.now() + PURGE_RETRY_MIN_AGE_MS + 1);
      const sweep = await env.service.retryPendingPurges(sweepAt);
      expect(sweep).toEqual({ attempted: 1, done: 1, failed: 0, exhausted: 0, reportsClosed: 1, notConfigured: false });
      expect(env.items[0]).toMatchObject({ purgeStatus: 'done', purgeError: null, purgeAttempts: 1, purgedAt: expect.any(Date) });
      expect(env.report.takedownDoneAt).toEqual(sweepAt);
    });

    it('a Cloudflare falha: removida, mas o prazo segue correndo; na última tentativa vira erro uma vez e o prazo continua aberto', async () => {
      const generation = generationWith(9);
      generation.outputs[0].thumbnailUrl = null;
      const env = setup({ report: { target: generation.id }, generations: [generation] });
      env.put('public', outputKey(generation.id), `img:${FULL}:x`);
      env.cdn.purgeUrls.mockImplementation(
        async (urls: string[]) =>
          new Map<string, PurgeOutcome>(urls.map((url): [string, PurgeOutcome] => [url, { status: 'failed', reason: 'HTTP 502' }])),
      );

      const result = await env.run();

      expect(result.complete).toBe(true);
      expect(env.report).toMatchObject({ status: 'ACTIONED', takedownDoneAt: null });
      expect(result.report.takedown).toMatchObject({ state: 'pending' });

      // 7 tentativas já feitas: a 8ª falha, o item sai da varredura com um erro só
      env.items[0].purgeAttempts = PURGE_MAX_ATTEMPTS - 1;
      const error = jest.spyOn(Logger.prototype, 'error');
      const sweep = await env.service.retryPendingPurges(new Date(Date.now() + PURGE_RETRY_MIN_AGE_MS + 1));
      expect(sweep).toMatchObject({ attempted: 1, failed: 1, exhausted: 1, reportsClosed: 0 });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('esgotou'));
      expect(env.report.takedownDoneAt).toBeNull();
      await expect(
        env.service.retryPendingPurges(new Date(Date.now() + 2 * PURGE_RETRY_MIN_AGE_MS + 1)),
      ).resolves.toMatchObject({ attempted: 0, exhausted: 0 });
      // o relógio vence normalmente: a fila mostra a denúncia vencida
      const late = await env.service.listItems('rep-1');
      expect(late.takedown?.doneAt).toBeNull();
    });

    it('uma rodada nova purga o mesmo endereço: a purga velha com falha não segura mais o prazo', async () => {
      const generation = generationWith(10);
      generation.outputs[0].thumbnailUrl = null;
      const env = setup({ report: { target: generation.id }, generations: [generation] });
      env.put('public', outputKey(generation.id), `img:${FULL}:x`);
      env.cdn.purgeUrls.mockImplementationOnce(
        async (urls: string[]) =>
          new Map<string, PurgeOutcome>(urls.map((url): [string, PurgeOutcome] => [url, { status: 'failed', reason: 'HTTP 502' }])),
      );
      await env.run();
      expect(env.report.takedownDoneAt).toBeNull();

      // o revisor repete: o arquivo já não existe (not_found) e o endereço é purgado de novo, agora com sucesso
      const again = await env.run();
      expect(again.items).toEqual([expect.objectContaining({ action: 'not_found', purgeStatus: 'done' })]);
      expect(env.report.takedownDoneAt).toEqual(expect.any(Date));
    });

    it('arquivo fora do nosso storage (link do provedor): external, sem apagar nem purgar', async () => {
      const generation: GenerationFixture = {
        id: gid(8),
        userId: 'dona-1',
        outputs: [{ id: 'out-8', url: 'https://provedor.example/tmp/abc.png', thumbnailUrl: null }],
        inputImages: [],
      };
      const env = setup({ report: { target: generation.id }, generations: [generation] });
      const result = await env.run();
      expect(result.items).toEqual([expect.objectContaining({ action: 'external', purgeStatus: 'none' })]);
      expect(env.cdn.purgeUrls).not.toHaveBeenCalled();
    });
  });

  describe('cópias (hash próximo)', () => {
    it('mesmo sha256 em outra geração sai junto; pHash perto só é listado; longe é ignorado', async () => {
      const denounced = generationWith(10);
      const identical = generationWith(11, { userId: 'outra-conta' });
      const near = generationWith(12, { userId: 'outra-conta' });
      const far = generationWith(13, { userId: 'outra-conta' });
      const body = `img:${FULL}:original`;
      const env = setup({
        report: { category: 'COPYRIGHT', isDepictedPerson: false, target: denounced.id },
        generations: [denounced, identical, near, far],
        scans: [
          { generationId: identical.id, stage: 'OUTPUT', sha256: sha(Buffer.from(body)), phash: FULL },
          { generationId: near.id, stage: 'OUTPUT', sha256: 'outro', phash: NEAR },
          { generationId: far.id, stage: 'OUTPUT', sha256: 'outro2', phash: FAR },
        ],
      });
      env.put('public', outputKey(denounced.id), body);
      env.put('public', outputKey(identical.id), body);
      env.put('public', outputKey(near.id), `img:${NEAR}:recorte`);
      env.put('public', outputKey(far.id), `img:${FAR}:outra-foto`);

      const result = await env.run();

      expect(result.complete).toBe(true);
      expect(result.generationIds).toEqual([denounced.id, identical.id]);
      expect(env.storage.has(`public:${outputKey(identical.id)}`)).toBe(false);
      expect(result.items).toContainEqual(expect.objectContaining({ generationId: identical.id, source: 'identical_copy', action: 'deleted' }));
      // parecida: listada para o revisor, arquivo intacto
      expect(result.nearCopies).toEqual([{ generationId: near.id, outputId: 'out-12', distance: 4 }]);
      expect(env.storage.has(`public:${outputKey(near.id)}`)).toBe(true);
      expect(env.storage.has(`public:${outputKey(far.id)}`)).toBe(true);
      expect(env.generations.find((g) => g.id === near.id)?.isDeleted).toBe(false);
      expect(env.generations.find((g) => g.id === identical.id)?.isDeleted).toBe(true);
      // a cópia idêntica de outra conta passa pela guarda dela
      expect(env.retention.reasonsFor).toHaveBeenLastCalledWith([expect.objectContaining({ id: identical.id })], expect.anything());
    });

    it('a parecida indicada pelo revisor numa nova remoção sai inteira', async () => {
      const near = generationWith(14);
      const env = setup({ generations: [near] });
      env.put('public', outputKey(near.id), `img:${NEAR}:recorte`);
      const result = await env.run({ generationIds: [near.id] });
      expect(result.complete).toBe(true);
      expect(env.storage.has(`public:${outputKey(near.id)}`)).toBe(false);
    });

    it('vídeo: cada quadro entra na lista de bloqueio; o sha256 do arquivo só na 1ª linha', async () => {
      const generation = generationWith(15, { file: 'out.mp4' });
      generation.outputs[0].thumbnailUrl = null;
      const env = setup({ report: { target: generation.id }, generations: [generation] });
      const body = `vid:${FULL},${NEAR}`;
      env.put('public', outputKey(generation.id, 'out.mp4'), body, 'video/mp4');
      await env.run();
      expect(env.blocks).toEqual([
        expect.objectContaining({ phash: FULL, sha256: sha(Buffer.from(body)) }),
        expect.objectContaining({ phash: NEAR, sha256: null }),
      ]);
      expect(env.items[0].phashes).toEqual([FULL, NEAR]);
    });

    it('denúncia de menor: geração indicada de conta que a denúncia não cita e cópia idêntica de outra conta vão para a evidência, nunca apagadas', async () => {
      const indicated = generationWith(30, { userId: 'conta-nao-citada' });
      indicated.outputs[0].thumbnailUrl = null;
      const copy = generationWith(31, { userId: 'outra-conta' });
      copy.outputs[0].thumbnailUrl = null;
      const body = `img:${FULL}:original`;
      const env = setup({
        // link sem id nenhum: a guarda da conta não pega (retained vazio no leitor simulado)
        report: { category: 'MINOR', isDepictedPerson: false, target: 'https://outro-site.example/post/abc', description: 'conteúdo com criança' },
        generations: [indicated, copy],
        scans: [{ generationId: copy.id, stage: 'OUTPUT', sha256: sha(Buffer.from(body)), phash: FULL }],
      });
      env.put('public', outputKey(indicated.id), body);
      env.put('public', outputKey(copy.id), body);

      const result = await env.run({ generationIds: [indicated.id] });

      // os dois arquivos foram para a evidência (o delete depois da mudança só confere que a origem saiu)
      expect(env.uploads.moveToEvidence).toHaveBeenCalledTimes(2);
      expect([...env.storage.keys()].every((key) => key.startsWith('evidence:'))).toBe(true);
      expect(result.items.map((item) => [item.generationId, item.source, item.action])).toEqual([
        [indicated.id, 'report', 'moved_to_evidence'],
        [copy.id, 'identical_copy', 'moved_to_evidence'],
      ]);
      expect(env.items.every((item) => String(item.detail).includes('denúncia que segura evidência (MINOR)'))).toBe(true);
    });

    it('denúncia de menor sem bucket de evidência: 409 e nada é apagado', async () => {
      const generation = generationWith(32, { userId: 'conta-nao-citada' });
      const env = setup({
        report: { category: 'MINOR', isDepictedPerson: false, target: 'link sem id' },
        generations: [generation],
        evidenceStorage: false,
      });
      env.put('public', outputKey(generation.id), `img:${FULL}:x`);
      await expect(env.run({ generationIds: [generation.id] })).rejects.toMatchObject({
        response: { code: 'TAKEDOWN_EVIDENCE_STORAGE_MISSING' },
      });
      expect(env.uploads.deleteStoredObject).not.toHaveBeenCalled();
    });

    it('denúncia de menor: o hash entra como sinal forte', async () => {
      const generation = generationWith(16);
      generation.outputs[0].thumbnailUrl = null;
      const env = setup({ report: { category: 'MINOR', target: generation.id }, generations: [generation], retained: new Set([generation.id]) });
      env.put('public', outputKey(generation.id), `img:${FULL}:x`);
      await env.run();
      expect(env.blocks[0].strength).toBe('STRONG');
    });
  });

  describe('o que a remoção recusa', () => {
    it('motivo curto: 400 antes de ler qualquer coisa', async () => {
      const env = setup();
      await expect(env.run({ reason: 'curto' })).rejects.toBeInstanceOf(BadRequestException);
      expect(env.prisma.contentReport.findUnique).not.toHaveBeenCalled();
    });

    it('denúncia inexistente: 404; descartada: 409', async () => {
      const env = setup({ report: { status: 'DISMISSED' } });
      await expect(env.run({ reportId: 'nao-existe' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(env.run()).rejects.toBeInstanceOf(ConflictException);
    });

    it('denúncia sem geração citada: 400 pedindo generationIds; geração indicada que não existe: 400', async () => {
      const env = setup({ generations: [generationWith(17)] });
      await expect(env.run()).rejects.toMatchObject({ response: { code: 'TAKEDOWN_NO_GENERATION' } });
      await expect(env.run({ generationIds: [gid(17), gid(99)] })).rejects.toMatchObject({ response: { code: 'TAKEDOWN_GENERATION_NOT_FOUND' } });
    });

    it('geração achada pelo id do post citado na denúncia', async () => {
      const generation = generationWith(18);
      generation.outputs[0].thumbnailUrl = null;
      const postId = `cpost${String(1).padStart(20, '0')}`;
      const env = setup({
        report: { target: `https://www.theaimodelab.com/community/p/${postId}` },
        generations: [generation],
        posts: [{ id: postId, generationId: generation.id, mediaUrl: generation.outputs[0].url, thumbnailUrl: null, status: 'APPROVED' }],
      });
      env.put('public', outputKey(generation.id), `img:${FULL}:x`);
      const result = await env.run();
      expect(result.generationIds).toEqual([generation.id]);
      expect(env.posts[0].status).toBe('REJECTED');
    });

    it('sem o registro de acesso, nada acontece (fecha)', async () => {
      const generation = generationWith(19);
      const env = setup({ report: { target: generation.id }, generations: [generation], accessLogFails: true });
      env.put('public', outputKey(generation.id), `img:${FULL}:x`);
      await expect(env.run()).rejects.toThrow('banco fora do ar');
      expect(env.uploads.deleteStoredObject).not.toHaveBeenCalled();
      expect(env.storage.size).toBe(1);
    });

    it('a mesma denúncia duas vezes ao mesmo tempo: a 2ª é 409', async () => {
      const generation = generationWith(20);
      const env = setup({ report: { target: generation.id }, generations: [generation] });
      let release: () => void = () => undefined;
      env.retention.reasonsFor.mockImplementationOnce(
        (subjects: Array<{ id: string }>) =>
          new Promise<Map<string, string | null>>((resolve) => {
            release = () => resolve(new Map(subjects.map((subject): [string, string | null] => [subject.id, null])));
          }),
      );
      const first = env.run();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(env.run()).rejects.toMatchObject({ response: { code: 'TAKEDOWN_IN_PROGRESS' } });
      release();
      await expect(first).resolves.toMatchObject({ complete: true });
    });
  });

  describe('caso confirmado na checagem (recordReviewRemoval)', () => {
    it('grava os itens com o scanId, purga o que era público e marca o de fora como external', async () => {
      const env = setup({});
      const purge = await env.service.recordReviewRemoval({
        scanId: 'scan-1',
        actorId: 'revisor-1',
        files: [
          {
            generationId: gid(40),
            role: 'output',
            url: `${publicUrl(outputKey(gid(40)))}?v=1`,
            location: { area: 'public', key: outputKey(gid(40)) },
            evidenceKey: 'evidence/x/out.png',
          },
          { generationId: gid(40), role: 'output', url: 'https://provedor.example/x.png', location: null, evidenceKey: null },
        ],
      });
      expect(purge).toEqual({ none: 1, pending: 0, done: 1, failed: 0 });
      expect(env.purged).toEqual([[publicUrl(outputKey(gid(40)))]]);
      expect(env.items).toEqual([
        expect.objectContaining({ reportId: null, scanId: 'scan-1', source: 'review', action: 'moved_to_evidence', purgeStatus: 'done' }),
        expect.objectContaining({ scanId: 'scan-1', source: 'review', action: 'external', purgeStatus: 'none' }),
      ]);
    });

    it('sem token: a purga fica pendente e a varredura repete', async () => {
      const env = setup({ cdnConfigured: false });
      const purge = await env.service.recordReviewRemoval({
        scanId: 'scan-2',
        actorId: 'revisor-1',
        files: [
          {
            generationId: gid(41),
            role: 'thumbnail',
            url: publicUrl(`thumbnails/${gid(41)}/t.webp`),
            location: { area: 'public', key: `thumbnails/${gid(41)}/t.webp` },
            evidenceKey: 'evidence/y/t.webp',
          },
        ],
      });
      expect(purge).toMatchObject({ pending: 1 });
      env.cdn.configured = true;
      env.cdn.unavailableReason = null;
      await expect(env.service.retryPendingPurges(new Date(Date.now() + PURGE_RETRY_MIN_AGE_MS + 1))).resolves.toMatchObject({
        attempted: 1,
        done: 1,
      });
    });
  });

  it('listItems: itens gravados e o relógio do prazo', async () => {
    const generation = generationWith(21);
    generation.outputs[0].thumbnailUrl = null;
    const env = setup({ report: { target: generation.id }, generations: [generation] });
    env.put('public', outputKey(generation.id), `img:${FULL}:x`);
    await env.run();
    const listed = await env.service.listItems('rep-1');
    // "sou a pessoa da imagem" segura evidência: o arquivo sai do público para a evidência
    expect(listed.items).toEqual([expect.objectContaining({ role: 'output', action: 'moved_to_evidence', blocked: 1 })]);
    expect(listed.takedown).toMatchObject({ state: 'done' });
    await expect(env.service.listItems('outra')).rejects.toBeInstanceOf(NotFoundException);
  });
});
