import { ContentSafetyEventKind, GenerationStatus } from '@prisma/client';
import {
  findOwnPromotedOutput,
  generationIdOfOutputKey,
  heldGenerationIdsWithApprovedPosts,
  hiddenGenerationIds,
  publicLocationOf,
} from '../promoted-output';
import {
  CDN,
  OTHER,
  OWNER,
  QUARANTINE_BUCKET,
  fakeDb,
  generation,
  heldEvent,
  makeUploads,
} from './promoted-output.fixtures';

/**
 * Saída promovida (passo 22): só resultado concluído da própria conta, no bucket público e fora de revisão ou
 * evidência. URL externa, interna e de metadados de nuvem param antes de qualquer consulta; nada é baixado.
 */
describe('saída promovida', () => {
  const uploads = makeUploads();
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('fetch não pode ser chamado');
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  describe('publicLocationOf', () => {
    it('aceita só o bucket público', () => {
      expect(
        publicLocationOf(uploads, `${CDN}/generations/g1/u/a.mp4`),
      ).toEqual({
        area: 'public',
        key: 'generations/g1/u/a.mp4',
      });
      expect(
        publicLocationOf(
          uploads,
          `https://s3.exemplo.com/${QUARANTINE_BUCKET}/generations/g1/u/a.mp4?X-Amz-Signature=x`,
        ),
      ).toBeNull();
      expect(
        publicLocationOf(uploads, 'https://outro-site.com/video.mp4'),
      ).toBeNull();
      expect(publicLocationOf(uploads, 'nao é url')).toBeNull();
      expect(publicLocationOf(uploads, null)).toBeNull();
      expect(publicLocationOf(uploads, '')).toBeNull();
    });
  });

  describe('generationIdOfOutputKey', () => {
    it('lê o id da pasta do resultado', () => {
      expect(generationIdOfOutputKey('generations/cabc123/u/o.mp4')).toBe(
        'cabc123',
      );
      expect(generationIdOfOutputKey('outputs/cabc123/u/o.mp4')).toBe(
        'cabc123',
      );
      expect(generationIdOfOutputKey('inputs/cabc123/u/o.mp4')).toBeNull();
      expect(generationIdOfOutputKey('video-editor/u/render-x.mp4')).toBeNull();
      expect(generationIdOfOutputKey('generations/../x/o.mp4')).toBeNull();
    });
  });

  describe('hiddenGenerationIds', () => {
    it('esconde IN_REVIEW, FAILED e evento sem liberação; liberado e concluído aparecem', async () => {
      const { prisma } = fakeDb({
        generations: [
          generation('g-ok'),
          generation('g-review', { status: GenerationStatus.IN_REVIEW }),
          generation('g-failed', { status: GenerationStatus.FAILED }),
          generation('g-evidence'),
          generation('g-released'),
          generation('g-minor'),
        ],
        events: [
          heldEvent('g-evidence'),
          {
            generationId: 'g-released',
            kind: ContentSafetyEventKind.OUTPUT_HELD,
            releasedAt: new Date(),
          },
          {
            generationId: 'g-minor',
            kind: ContentSafetyEventKind.MINOR_BLOCKED,
            releasedAt: null,
          },
          // texto do refinador não segura a geração
          {
            generationId: 'g-ok',
            kind: ContentSafetyEventKind.REFINER_BLOCKED,
            releasedAt: null,
          },
        ],
      });
      const hidden = await hiddenGenerationIds(prisma as never, [
        'g-ok',
        'g-review',
        'g-failed',
        'g-evidence',
        'g-released',
        'g-minor',
        null,
        undefined,
        'g-ok',
      ]);
      expect([...hidden].sort()).toEqual([
        'g-evidence',
        'g-failed',
        'g-minor',
        'g-review',
      ]);
    });

    it('lista vazia não consulta o banco', async () => {
      const { prisma } = fakeDb();
      expect((await hiddenGenerationIds(prisma as never, [null])).size).toBe(0);
      expect(prisma.generation.findMany).not.toHaveBeenCalled();
    });
  });

  describe('heldGenerationIdsWithApprovedPosts', () => {
    it('lê pelo lado pequeno (casos em aberto) e só devolve as que têm post aprovado no escopo', async () => {
      const db = {
        contentSafetyEvent: {
          findMany: jest.fn(async () => [
            { generationId: 'g-evid' },
            { generationId: 'g-sem-post' },
          ]),
        },
        generation: {
          findMany: jest.fn(async () => [{ id: 'g-review' }]),
        },
        communityPost: {
          findMany: jest.fn(async (args: { where: { generationId: { in: string[] } } }) =>
            ['g-evid', 'g-review']
              .filter((id) => args.where.generationId.in.includes(id))
              .map((generationId) => ({ generationId })),
          ),
        },
      };
      const held = await heldGenerationIdsWithApprovedPosts(db as never, {
        status: 'APPROVED',
      });
      expect([...held].sort()).toEqual(['g-evid', 'g-review']);
      // nunca lê todos os posts aprovados: a consulta dos posts leva só os candidatos
      expect(db.communityPost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'APPROVED',
            generationId: { in: ['g-evid', 'g-sem-post', 'g-review'] },
          },
        }),
      );
      expect(db.generation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: GenerationStatus.IN_REVIEW } }),
      );
    });

    it('sem caso em aberto, não consulta os posts', async () => {
      const db = {
        contentSafetyEvent: { findMany: jest.fn(async () => []) },
        generation: { findMany: jest.fn(async () => []) },
        communityPost: { findMany: jest.fn() },
      };
      const held = await heldGenerationIdsWithApprovedPosts(db as never, {});
      expect(held.size).toBe(0);
      expect(db.communityPost.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOwnPromotedOutput', () => {
    const own = generation('cgen0000000000000000000001');
    const other = generation('cgen0000000000000000000002', { userId: OTHER });
    const ownUrl = own.outputs[0].url;

    const setup = () =>
      fakeDb({
        generations: [
          own,
          other,
          generation('cgen0000000000000000000003', {
            status: GenerationStatus.IN_REVIEW,
          }),
        ],
      });

    it('acha o resultado concluído da própria conta (sem baixar nada)', async () => {
      const { prisma } = setup();
      const found = await findOwnPromotedOutput(
        prisma as never,
        uploads,
        OWNER,
        ownUrl,
      );
      expect(found).toMatchObject({
        url: ownUrl,
        generationId: own.id,
        mimeType: 'video/mp4',
        location: { area: 'public', key: ownUrl.slice(CDN.length + 1) },
        generation: { type: own.type, modelUsed: own.modelUsed },
      });
      expect(found?.thumbnailUrl).toBe(own.outputs[0].thumbnailUrl);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['URL externa', 'https://outro-site.com/generations/x/u/o.mp4'],
      ['URL interna (localhost)', 'http://127.0.0.1:3000/api/v1/admin/users'],
      ['rede interna', 'http://10.0.0.5/generations/x/u/o.mp4'],
      [
        'metadados de nuvem',
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      ],
      [
        'metadados do Google',
        'http://metadata.google.internal/computeMetadata/v1/',
      ],
      ['arquivo local', 'file:///etc/passwd'],
      [
        'quarentena (privada)',
        `https://s3.exemplo.com/${QUARANTINE_BUCKET}/generations/cgen0000000000000000000001/u/o.mp4`,
      ],
    ])('recusa %s sem consultar o banco', async (_label, url) => {
      const { prisma } = setup();
      expect(
        await findOwnPromotedOutput(prisma as never, uploads, OWNER, url),
      ).toBeNull();
      expect(prisma.generationOutput.findFirst).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('recusa host de fora com o nome do bucket no caminho (o banco não tem essa URL)', async () => {
      const { prisma } = setup();
      const forged = `http://169.254.169.254/ai-generations/generations/${own.id}/u/output_0.mp4`;
      expect(
        await findOwnPromotedOutput(prisma as never, uploads, OWNER, forged),
      ).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('recusa o resultado de outra conta', async () => {
      const { prisma } = setup();
      expect(
        await findOwnPromotedOutput(
          prisma as never,
          uploads,
          OWNER,
          other.outputs[0].url,
        ),
      ).toBeNull();
    });

    it('recusa geração em revisão, apagada ou com evidência', async () => {
      const review = generation('cgen0000000000000000000003', {
        status: GenerationStatus.IN_REVIEW,
      });
      const deleted = generation('cgen0000000000000000000004', {
        isDeleted: true,
      });
      const evidence = generation('cgen0000000000000000000005');
      const { prisma } = fakeDb({
        generations: [review, deleted, evidence],
        events: [heldEvent(evidence.id)],
      });
      for (const gen of [review, deleted, evidence]) {
        expect(
          await findOwnPromotedOutput(
            prisma as never,
            uploads,
            OWNER,
            gen.outputs[0].url,
          ),
        ).toBeNull();
      }
    });

    it('descarta miniatura que não está no bucket público', async () => {
      const gen = generation('cgen0000000000000000000006');
      gen.outputs[0].thumbnailUrl = 'https://outro-site.com/thumb.jpg';
      const { prisma } = fakeDb({ generations: [gen] });
      const found = await findOwnPromotedOutput(
        prisma as never,
        uploads,
        OWNER,
        gen.outputs[0].url,
      );
      expect(found?.thumbnailUrl).toBeNull();
    });
  });
});
