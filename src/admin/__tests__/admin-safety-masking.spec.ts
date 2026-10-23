import { Logger } from '@nestjs/common';
import { AdminService } from '../admin.service';
import { ListGenerationsQueryDto } from '../dto/list-generations-query.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  SAFETY_REVIEW_MARKER,
  safetyMaskedGenerationIds,
} from '../../content-safety/reviewer/media-masking';
import {
  createTable,
  type Row,
} from '../../content-safety/reviewer/__tests__/fake-prisma';

/**
 * Admin sem mídia sensível (camada 7, passo 23): GET /admin/generations, GET /admin/users/:id/generations e a galeria
 * do admin (GET /admin/users/:id) devolvem o marcador no lugar das URLs de geração em revisão, com evidência ou em
 * retenção legal. Prisma simulado; as URLs são de mentira.
 */

const cid = (tag: string): string => `c${tag}${'0'.repeat(24 - tag.length)}`;
const U = cid('user');
const G = {
  review: cid('review'),
  evidence: cid('evid'),
  minor: cid('minor'),
  image: cid('image'),
  reported: cid('reported'),
  released: cid('released'),
  dismissed: cid('dismissed'),
  copyright: cid('copyright'),
  clean: cid('clean'),
};
const CREATED = new Date('2026-10-22T09:00:00.000Z');
const USER = { id: U, email: 'maria@exemplo.com', name: 'Maria' };

const outputUrl = (id: string) => `https://cdn.test/public/generations/${id}/u/out.png`;

function generationRow(id: string, status = 'COMPLETED'): Row {
  return {
    id,
    userId: U,
    status,
    type: 'TEXT_TO_IMAGE',
    prompt: 'p',
    negativePrompt: null,
    resolution: 'RES_2K',
    durationSeconds: null,
    hasAudio: false,
    modelUsed: 'sem-censura',
    creditsConsumed: 200,
    errorMessage: null,
    processingTimeMs: 1000,
    isFavorited: false,
    isDeleted: false,
    userAvatarId: null,
    voiceProfileId: null,
    createdAt: CREATED,
    completedAt: CREATED,
    user: USER,
    outputs: [
      {
        id: `out-${id}`,
        url: outputUrl(id),
        thumbnailUrl: `https://cdn.test/public/thumbnails/${id}/t.webp`,
        mimeType: 'image/png',
      },
    ],
  };
}

function createDb() {
  return {
    contentSafetyEvent: createTable('evt', [
      { id: 'e1', kind: 'MINOR_BLOCKED', generationId: G.minor, releasedAt: null, route: 'provider:x' },
      { id: 'e2', kind: 'IMAGE_MINOR_BLOCKED', generationId: G.image, releasedAt: null, route: 'input:generate' },
      { id: 'e3', kind: 'OUTPUT_HELD', generationId: G.released, releasedAt: CREATED, route: 'output:x' },
    ]),
    contentSafetyScan: createTable('scan', [
      { id: 's1', generationId: G.evidence, evidenceKey: `evidence/${'a'.repeat(64)}/k/out.png` },
      { id: 's2', generationId: G.clean, evidenceKey: null },
    ]),
    contentReport: createTable('rep', [
      {
        id: 'r1',
        category: 'MINOR',
        status: 'OPEN',
        target: `https://www.theaimodelab.com/galeria/${G.reported}`,
        description: 'conteúdo denunciado',
        evidenceReleasedAt: null,
      },
      {
        id: 'r2',
        category: 'MINOR',
        status: 'DISMISSED',
        target: G.dismissed,
        description: 'descartada',
        evidenceReleasedAt: null,
      },
      {
        id: 'r3',
        category: 'COPYRIGHT',
        status: 'OPEN',
        target: G.copyright,
        description: 'uso de marca',
        evidenceReleasedAt: null,
      },
    ]),
    communityPost: createTable('post'),
  };
}

type SafetyModes = { imageMode: 'off' | 'shadow' | 'enforce'; textMode: 'off' | 'shadow' | 'enforce' };
const SHADOW: SafetyModes = { imageMode: 'shadow', textMode: 'off' };

function createService(rows: Row[], modes: SafetyModes | null = SHADOW) {
  const db = createDb();
  const prisma = {
    ...db,
    generation: {
      findMany: jest.fn(async () => rows),
      count: jest.fn(async () => rows.length),
    },
    user: {
      findUnique: jest.fn(async (args: Row) =>
        args.include
          ? {
              ...USER,
              avatarUrl: null,
              role: 'USER',
              isActive: true,
              emailVerified: true,
              oauthProvider: null,
              createdAt: CREATED,
              updatedAt: CREATED,
              subscriptions: [],
              creditBalance: null,
              freeGenerations: [],
              generations: rows,
            }
          : USER,
      ),
    },
  };
  const service = new AdminService(prisma as never, {} as never, {} as never, modes);
  return { service, prisma, db };
}

const allRows = () => [
  generationRow(G.review, 'IN_REVIEW'),
  generationRow(G.evidence),
  generationRow(G.minor, 'FAILED'),
  generationRow(G.image, 'FAILED'),
  generationRow(G.reported),
  generationRow(G.released),
  generationRow(G.dismissed),
  generationRow(G.copyright),
  generationRow(G.clean),
];
const MASKED = [G.review, G.evidence, G.minor, G.image, G.reported];
const VISIBLE = [G.released, G.dismissed, G.copyright, G.clean];

beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('safetyMaskedGenerationIds', () => {
  it('em revisão, com evidência, com bloqueio por menor não liberado ou citada por denúncia que segura evidência', async () => {
    const masked = await safetyMaskedGenerationIds(createDb() as never, allRows() as never);
    expect([...masked].sort()).toEqual([...MASKED].sort());
  });

  it('página vazia não lê nada; erro de leitura mascara a página inteira', async () => {
    const db = createDb();
    await expect(safetyMaskedGenerationIds(db as never, [])).resolves.toEqual(new Set());
    expect(db.contentSafetyEvent.findMany).not.toHaveBeenCalled();
    db.contentSafetyEvent.findMany.mockRejectedValueOnce(new Error('db fora'));
    const onError = jest.fn();
    const masked = await safetyMaskedGenerationIds(db as never, allRows() as never, onError);
    expect(masked.size).toBe(9);
    expect(onError).toHaveBeenCalled();
  });
});

describe('AdminService: mídia sensível nunca sai para o admin comum', () => {
  it('GET /admin/generations: marcador no lugar das URLs; o resto como antes', async () => {
    const { service } = createService(allRows());
    const query = Object.assign(new ListGenerationsQueryDto(), { page: 1, limit: 20 });
    const result = await service.getGenerations(query);
    for (const item of result.data) {
      if (MASKED.includes(item.id)) {
        expect(item.outputUrls).toEqual([]);
        expect(item.safetyReview).toBe(SAFETY_REVIEW_MARKER);
      } else {
        expect(item.outputUrls).toEqual([outputUrl(item.id)]);
        expect(item.safetyReview).toBeNull();
      }
    }
    const body = JSON.stringify(result);
    for (const id of MASKED) expect(body).not.toContain(outputUrl(id));
    for (const id of VISIBLE) expect(body).toContain(outputUrl(id));
  });

  it('GET /admin/users/:id/generations: saídas e miniaturas mascaradas', async () => {
    const { service } = createService(allRows());
    const pagination = Object.assign(new PaginationDto(), { page: 1, limit: 20 });
    const result = await service.getUserGenerations(U, pagination);
    const review = result.data.find((item) => item.id === G.review)!;
    expect(review).toMatchObject({ outputs: [], safetyReview: SAFETY_REVIEW_MARKER });
    const clean = result.data.find((item) => item.id === G.clean)!;
    expect(clean.outputs).toHaveLength(1);
    expect(clean.safetyReview).toBeNull();
    expect(JSON.stringify(result)).not.toContain(`thumbnails/${G.evidence}`);
  });

  it('galeria do admin (GET /admin/users/:id): gerações recentes mascaradas', async () => {
    const { service } = createService(allRows());
    const user = await service.getUserById(U);
    const minor = user.recentGenerations.find((item) => item.id === G.minor)!;
    expect(minor).toMatchObject({ outputs: [], safetyReview: SAFETY_REVIEW_MARKER });
    const copyright = user.recentGenerations.find((item) => item.id === G.copyright)!;
    expect(copyright.outputs).toHaveLength(1);
  });

  it('checagens desligadas (padrão): a retenção legal da PR #4 continua mascarando; só as checagens novas não são lidas', async () => {
    // com off: em revisão, bloqueio por menor não liberado e denúncia que segura evidência saem mascarados;
    // a checagem com evidência guardada (camada nova) não é lida
    const legalMasked = [G.review, G.minor, G.image, G.reported];
    for (const modes of [null, { imageMode: 'off', textMode: 'off' } as SafetyModes]) {
      const { service, db } = createService(allRows(), modes);
      const query = Object.assign(new ListGenerationsQueryDto(), { page: 1, limit: 20 });
      const result = await service.getGenerations(query);
      for (const item of result.data) {
        if (legalMasked.includes(item.id)) {
          expect(item.outputUrls).toEqual([]);
          expect(item.safetyReview).toBe(SAFETY_REVIEW_MARKER);
        } else {
          expect(item.outputUrls).toEqual([outputUrl(item.id)]);
          expect(item.safetyReview).toBeNull();
        }
      }
      expect(db.contentSafetyScan.findMany).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(outputUrl(G.reported));
    }
  });

  it('as denúncias que seguram evidência são lidas no máximo uma vez a cada 60 s entre páginas', async () => {
    const { service, db } = createService(allRows(), { imageMode: 'off', textMode: 'off' });
    const query = Object.assign(new ListGenerationsQueryDto(), { page: 1, limit: 20 });
    await service.getGenerations(query);
    const reads = db.contentReport.findMany.mock.calls.length;
    await service.getGenerations(query);
    expect(db.contentReport.findMany).toHaveBeenCalledTimes(reads);
  });

  it('só o leitor de texto ligado também mascara', async () => {
    const { service } = createService(allRows(), { imageMode: 'off', textMode: 'shadow' });
    const user = await service.getUserById(U);
    const reported = user.recentGenerations.find((item) => item.id === G.reported)!;
    expect(reported).toMatchObject({ outputs: [], safetyReview: SAFETY_REVIEW_MARKER });
  });

  it('erro ao ler a máscara: a página inteira sai mascarada e o erro vai para o log', async () => {
    const { service, db } = createService(allRows());
    db.contentSafetyScan.findMany.mockRejectedValueOnce(new Error('db fora'));
    const query = Object.assign(new ListGenerationsQueryDto(), { page: 1, limit: 20 });
    const result = await service.getGenerations(query);
    expect(result.data.every((item) => item.outputUrls.length === 0)).toBe(true);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining('página inteira mascarada'),
    );
  });
});
