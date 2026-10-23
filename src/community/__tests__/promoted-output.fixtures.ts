import {
  ContentSafetyEventKind,
  GenerationStatus,
  GenerationType,
} from '@prisma/client';
import { UploadsService } from '../../uploads/uploads.service';

/**
 * Fixtures das portas da CDN (editor de vídeo, miniatura, comunidade): banco em memória com só o que esses serviços
 * consultam e um UploadsService de verdade (locateStoredMedia real; leitura e gravação no S3 sempre simuladas com spy).
 * Nenhuma imagem de pessoa: as mídias são bytes de mentira ou cor sólida gerada no teste.
 */

export const PUBLIC_BUCKET = 'ai-generations';
export const QUARANTINE_BUCKET = 'taml-quarantine';
export const CDN =
  'https://cdn.exemplo.com/storage/v1/object/public/ai-generations';

export const OWNER = 'user-dona';
export const OTHER = 'user-outra';

export function makeUploads(): UploadsService {
  const values: Record<string, string> = {
    S3_ENDPOINT: 'https://s3.exemplo.com',
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'chave-de-teste',
    S3_SECRET_KEY: 'segredo-de-teste',
    S3_BUCKET_NAME: PUBLIC_BUCKET,
    S3_PUBLIC_URL: CDN,
    S3_INPUT_PRIVATE_BUCKET: 'taml-inputs-private',
  };
  const config = {
    get: (key: string, fallback?: string) =>
      key in values ? values[key] : fallback,
  };
  // quarentena configurada só para a URL dela ser reconhecida como privada
  return new UploadsService(
    config as never,
    {
      imageMode: 'off',
      quarantineBucket: QUARANTINE_BUCKET,
      evidenceBucket: null,
    } as never,
  );
}

export function publicUrl(key: string): string {
  return `${CDN}/${key}`;
}

export interface FakeOutput {
  generationId: string;
  url: string;
  mimeType: string | null;
  thumbnailUrl: string | null;
  blurDataUrl: string | null;
}

export interface FakeGeneration {
  id: string;
  userId: string;
  status: GenerationStatus;
  isDeleted: boolean;
  type: GenerationType;
  modelUsed: string;
  prompt: string | null;
  aspectRatio: string | null;
  parameters: unknown;
  outputs: FakeOutput[];
}

export interface FakeEvent {
  generationId: string | null;
  kind: ContentSafetyEventKind;
  releasedAt: Date | null;
}

export interface FakePost {
  id: string;
  userId: string;
  generationId: string | null;
  kind: string;
  mediaUrl: string;
  thumbnailUrl: string | null;
  prompt: string;
  settings: unknown;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  likesCount: number;
  rejectionReason: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Geração concluída com um resultado no bucket público (`generations/<id>/<uuid>/<arquivo>`). */
export function generation(
  id: string,
  overrides: Partial<FakeGeneration> & {
    file?: string;
    mimeType?: string | null;
  } = {},
): FakeGeneration {
  const file = overrides.file ?? 'output_0.mp4';
  const url = publicUrl(
    `generations/${id}/0b8f3c3e-1111-4c4c-9a9a-000000000001/${file}`,
  );
  const { file: _file, mimeType, ...rest } = overrides;
  return {
    id,
    userId: OWNER,
    status: GenerationStatus.COMPLETED,
    isDeleted: false,
    type: GenerationType.TEXT_TO_VIDEO,
    modelUsed: 'veo-3-fast',
    prompt: 'praia ao pôr do sol',
    aspectRatio: '9:16',
    parameters: {},
    outputs: [
      {
        generationId: id,
        url,
        mimeType: mimeType === undefined ? 'video/mp4' : mimeType,
        thumbnailUrl: publicUrl(`generations/${id}/thumb/thumb.webp`),
        blurDataUrl: `data:image/webp;base64,BLUR${id}`,
      },
    ],
    ...rest,
  };
}

let postSeq = 0;
export function post(overrides: Partial<FakePost> = {}): FakePost {
  postSeq += 1;
  const now = new Date(Date.UTC(2026, 9, 1, 12, 0, postSeq));
  return {
    id: `post-${postSeq}`,
    userId: OWNER,
    generationId: null,
    kind: 'image',
    mediaUrl: publicUrl(`generations/x/${postSeq}/output.png`),
    thumbnailUrl: null,
    prompt: '',
    settings: null,
    status: 'APPROVED',
    likesCount: 0,
    rejectionReason: null,
    approvedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

type Where = Record<string, unknown> | undefined;

/** Filtro do Prisma no que estes serviços usam, com a semântica de NULL do SQL no notIn (NULL NOT IN … = falso). */
export function matches(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(cond as Where[]).some((inner) => matches(row, inner))) return false;
      continue;
    }
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof cond === 'object' && !(cond instanceof Date)) {
      const op = cond as Record<string, unknown>;
      if ('in' in op && !(op.in as unknown[]).includes(value)) return false;
      if (
        'notIn' in op &&
        (value === null ||
          value === undefined ||
          (op.notIn as unknown[]).includes(value))
      ) {
        return false;
      }
      if ('not' in op) {
        if (op.not === null ? value == null : value === op.not) return false;
      }
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

export interface FakeState {
  generations: FakeGeneration[];
  events: FakeEvent[];
  posts: FakePost[];
}

/** Banco em memória (só leitura do que cada serviço consulta; escrita onde a comunidade e o editor gravam). */
export function fakeDb(state: Partial<FakeState> = {}) {
  const db: FakeState = {
    generations: state.generations ?? [],
    events: state.events ?? [],
    posts: state.posts ?? [],
  };
  const outputs = () => db.generations.flatMap((gen) => gen.outputs);
  const pick = <T extends Record<string, unknown>>(
    row: T,
    select?: Record<string, unknown>,
  ) => {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
  };

  const prisma = {
    generation: {
      findMany: jest.fn(
        async ({
          where,
          select,
        }: {
          where: Where;
          select?: Record<string, unknown>;
        }) =>
          db.generations
            .filter((gen) => matches(gen as never, where))
            .map((gen) => pick(gen as never, select)),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const found = db.generations.find((gen) => gen.id === where.id);
        return found ? { ...found, outputs: [...found.outputs] } : null;
      }),
    },
    contentSafetyEvent: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        db.events
          .filter((event) => matches(event as never, where))
          .map((event) => ({ generationId: event.generationId })),
      ),
    },
    generationOutput: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: {
            generationId: string;
            url: string;
            generation: {
              userId: string;
              isDeleted: boolean;
              status: GenerationStatus;
            };
          };
        }) => {
          const gen = db.generations.find(
            (candidate) =>
              candidate.id === where.generationId &&
              candidate.userId === where.generation.userId &&
              candidate.isDeleted === where.generation.isDeleted &&
              candidate.status === where.generation.status,
          );
          const output = gen?.outputs.find((item) => item.url === where.url);
          if (!gen || !output) return null;
          return {
            url: output.url,
            mimeType: output.mimeType,
            thumbnailUrl: output.thumbnailUrl,
            generationId: output.generationId,
            generation: {
              type: gen.type,
              modelUsed: gen.modelUsed,
              prompt: gen.prompt,
            },
          };
        },
      ),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        outputs().filter((output) => matches(output as never, where)),
      ),
    },
    communityPost: {
      findMany: jest.fn(
        async (args: {
          where?: Where;
          select?: Record<string, unknown>;
          distinct?: string[];
          skip?: number;
          take?: number;
          include?: unknown;
        }) => {
          let rows = db.posts.filter((row) =>
            matches(row as never, args.where),
          );
          if (args.distinct?.length) {
            const seen = new Set<string>();
            rows = rows.filter((row) => {
              const key = args
                .distinct!.map((field) => String((row as never)[field]))
                .join('|');
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          }
          const start = args.skip ?? 0;
          rows = rows.slice(start, args.take ? start + args.take : undefined);
          return rows.map((row) => ({
            ...pick(row as never, args.select),
            ...(args.include
              ? {
                  user: {
                    id: row.userId,
                    name: `nome-${row.userId}`,
                    email: `${row.userId}@exemplo.com`,
                    avatarUrl: null,
                  },
                }
              : {}),
          }));
        },
      ),
      count: jest.fn(
        async ({ where }: { where?: Where }) =>
          db.posts.filter((row) => matches(row as never, where)).length,
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = db.posts.find((candidate) => candidate.id === where.id);
        return row
          ? {
              ...row,
              user: {
                id: row.userId,
                name: `nome-${row.userId}`,
                avatarUrl: null,
              },
            }
          : null;
      }),
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          db.posts.find((row) => matches(row as never, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Partial<FakePost> }) => {
        const created = post({
          ...data,
          status: (data.status as FakePost['status']) ?? 'PENDING',
        });
        db.posts.push(created);
        return created;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakePost>;
        }) => {
          const row = db.posts.find((candidate) => candidate.id === where.id)!;
          Object.assign(row, data);
          return { ...row };
        },
      ),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        db.posts = db.posts.filter((candidate) => candidate.id !== where.id);
      }),
    },
    communityPostLike: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    userFollow: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        name: `nome-${where.id}`,
        avatarUrl: null,
      })),
    },
    $transaction: jest.fn(async (ops: Array<Promise<unknown>>) =>
      Promise.all(ops),
    ),
  };
  return { prisma, db };
}

/** Evento que segura a geração (resultado segurado para revisão, sem liberação). */
export function heldEvent(generationId: string): FakeEvent {
  return {
    generationId,
    kind: ContentSafetyEventKind.OUTPUT_HELD,
    releasedAt: null,
  };
}
