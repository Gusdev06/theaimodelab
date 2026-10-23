import { CommunityPostStatus } from '@prisma/client';
import {
  loadImageSafetyConfig,
  type ImageSafetyConfig,
} from '../../image-safety/image-safety.config';
import type {
  GenerationQueueRef,
  JobLike,
  QueueLike,
  SuspensionEffects,
} from '../strikes.types';

/**
 * Banco em memória e fila de mentira para os testes da camada 6. O filtro entende só o que o StrikesService usa
 * (igualdade, in, not, gte, endsWith, startsWith, null). Nenhuma imagem, nenhum Redis.
 */

type Row = Record<string, unknown>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    if (condition && typeof condition === 'object') {
      const cond = condition as Record<string, unknown>;
      if ('in' in cond && !(cond.in as unknown[]).includes(value)) return false;
      if ('not' in cond) {
        if (cond.not === null) {
          if (value === null || value === undefined) return false;
        } else if (
          value === cond.not ||
          value === null ||
          value === undefined
        ) {
          return false;
        }
      }
      if ('gte' in cond && !((value as Date) >= (cond.gte as Date)))
        return false;
      if (
        'endsWith' in cond &&
        !(typeof value === 'string' && value.endsWith(cond.endsWith as string))
      ) {
        return false;
      }
      if (
        'startsWith' in cond &&
        !(
          typeof value === 'string' &&
          value.startsWith(cond.startsWith as string)
        )
      ) {
        return false;
      }
      return true;
    }
    return value === condition;
  });
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select).map((key) => [key, row[key] ?? null]),
  );
}

export interface MemoryDb {
  users: Row[];
  refreshTokens: Row[];
  posts: Row[];
  generations: Row[];
  accessLog: Row[];
  events: Row[];
  blocks: Row[];
  scans: Row[];
}

export function memoryDb(seed: Partial<MemoryDb> = {}): MemoryDb {
  return {
    users: [],
    refreshTokens: [],
    posts: [],
    generations: [],
    accessLog: [],
    events: [],
    blocks: [],
    scans: [],
    ...seed,
  };
}

function table(rows: Row[]) {
  return {
    findMany: jest.fn(
      async (args: {
        where?: Row;
        select?: Record<string, boolean>;
        take?: number;
      }) =>
        rows
          .filter((row) => matches(row, args?.where))
          .slice(0, args?.take ?? Infinity)
          .map((row) => pick(row, args?.select)),
    ),
    findUnique: jest.fn(
      async (args: { where: Row; select?: Record<string, boolean> }) => {
        const found = rows.find((row) => matches(row, args.where));
        return found ? pick(found, args.select) : null;
      },
    ),
    count: jest.fn(
      async (args: { where?: Row }) =>
        rows.filter((row) => matches(row, args?.where)).length,
    ),
    updateMany: jest.fn(async (args: { where?: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, args.where));
      for (const row of hit) Object.assign(row, args.data);
      return { count: hit.length };
    }),
    update: jest.fn(async (args: { where: Row; data: Row }) => {
      const found = rows.find((row) => matches(row, args.where));
      if (!found) throw new Error('registro não encontrado');
      Object.assign(found, args.data);
      return { ...found };
    }),
    create: jest.fn(async (args: { data: Row }) => {
      const created = {
        id: `row-${rows.length + 1}`,
        createdAt: new Date(),
        ...args.data,
      };
      rows.push(created);
      return created;
    }),
    createMany: jest.fn(async (args: { data: Row[] }) => {
      rows.push(...args.data.map((data) => ({ ...data })));
      return { count: args.data.length };
    }),
  };
}

/** PrismaService de mentira sobre o banco em memória (com $transaction interativa). */
export function memoryPrisma(db: MemoryDb) {
  const prisma = {
    user: table(db.users),
    refreshToken: table(db.refreshTokens),
    communityPost: table(db.posts),
    generation: table(db.generations),
    contentSafetyAccessLog: table(db.accessLog),
    contentSafetyEvent: table(db.events),
    contentHashBlock: table(db.blocks),
    contentSafetyScan: table(db.scans),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  return prisma;
}

export interface FakeJob extends JobLike {
  state: 'waiting' | 'delayed' | 'prioritized' | 'paused' | 'active';
}

/** Fila de mentira: getJobs por estado e página; job ativo recusa remove (travado pelo worker). */
export class FakeQueue implements QueueLike {
  constructor(public jobs: FakeJob[] = []) {}

  add(id: string, data: Row, state: FakeJob['state'] = 'waiting'): FakeJob {
    const job: FakeJob = {
      id,
      name: 'image',
      data,
      state,
      remove: jest.fn(async () => {
        if (job.state === 'active') {
          throw new Error(
            `Job ${id} could not be removed because it is locked by another worker`,
          );
        }
        this.jobs = this.jobs.filter((other) => other !== job);
      }),
    };
    this.jobs.push(job);
    return job;
  }

  getJobs = jest.fn(
    async (types: string[], start: number, end: number): Promise<FakeJob[]> =>
      this.jobs
        .filter((job) => types.includes(job.state))
        .slice(start, end + 1),
  );
}

export function fakeEffects(
  queues: GenerationQueueRef[] = [],
): SuspensionEffects & {
  failGeneration: jest.Mock;
  releaseUnlimitedLock: jest.Mock;
  holdUncheckedOutputs: jest.Mock;
  sendNotice: jest.Mock;
} {
  return {
    queues: () => queues,
    failGeneration: jest.fn(async () => undefined),
    releaseUnlimitedLock: jest.fn(async () => undefined),
    holdUncheckedOutputs: jest.fn(async () => 0),
    sendNotice: jest.fn(async () => true),
  };
}

export function strikesConfig(
  mode: 'off' | 'shadow' | 'enforce',
): ImageSafetyConfig {
  const env: Record<string, string> = { S3_EVIDENCE_BUCKET: 'taml-evidencia' };
  if (mode !== 'off') env.IMAGE_SAFETY_MODE = mode;
  return loadImageSafetyConfig((key) => env[key]).config;
}

export const APPROVED = CommunityPostStatus.APPROVED;
export const PENDING = CommunityPostStatus.PENDING;
