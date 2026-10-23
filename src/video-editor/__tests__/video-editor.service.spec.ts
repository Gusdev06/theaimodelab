import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';
import { GenerationStatus, VideoProjectStatus } from '@prisma/client';
import { isRuleEnforced } from '../../content-safety/image-safety/image-safety.config';
import type { RuledInputVerdict } from '../../content-safety/image-safety/image-safety.rules';
import {
  IMAGE_SAFETY_BLOCKED_MESSAGE,
  SAFETY_CHECK_UNAVAILABLE_MESSAGE,
} from '../../generations/errors/failure-reason';
import {
  CDN,
  OTHER,
  OWNER,
  QUARANTINE_BUCKET,
  fakeDb,
  generation,
  heldEvent,
  makeUploads,
  type FakeGeneration,
} from '../../community/__tests__/promoted-output.fixtures';
import {
  RENDER_FAILED_MESSAGE,
  VIDEO_SOURCE_NOT_ALLOWED,
  VIDEO_SOURCE_NOT_ALLOWED_MESSAGE,
  VideoEditorService,
} from '../video-editor.service';

/**
 * Editor de vídeo (passo 22, TKT-050): o clipe só aceita saída promovida da própria conta e o render lê pela chave no
 * bucket (nunca por HTTP). Com a checagem ligada, os quadros do render passam pela régua antes de publicar. Scanner
 * simulado: nenhuma imagem real.
 */
describe('VideoEditorService · portas da CDN', () => {
  const PROJECT = 'proj-1';

  type Clip = {
    id: string;
    projectId: string;
    sourceUrl: string;
    thumbnailUrl: string | null;
    order: number;
    startMs: number;
    endMs: number | null;
    durationMs: number;
    createdAt: Date;
  };

  function setup(
    options: {
      generations?: FakeGeneration[];
      events?: ReturnType<typeof heldEvent>[];
      clips?: Array<Partial<Clip>>;
      projectOwner?: string;
      safety?: 'off' | 'shadow' | 'enforce';
      verdict?: Partial<RuledInputVerdict> | Error;
    } = {},
  ) {
    const { prisma: base, db } = fakeDb({
      generations: options.generations ?? [],
      events: options.events ?? [],
    });
    const clips: Clip[] = (options.clips ?? []).map((clip, index) => ({
      id: `clip-${index}`,
      projectId: PROJECT,
      sourceUrl: '',
      thumbnailUrl: null,
      order: index,
      startMs: 0,
      endMs: null,
      durationMs: 5000,
      createdAt: new Date(),
      ...clip,
    }));
    const project = {
      id: PROJECT,
      userId: options.projectOwner ?? OWNER,
      name: 'Projeto',
      status: VideoProjectStatus.DRAFT as VideoProjectStatus,
      outputUrl: null as string | null,
      errorMessage: null as string | null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      ...base,
      videoProject: {
        findUnique: jest.fn(async ({ include }: { include?: unknown }) => ({
          ...project,
          ...(include ? { clips: [...clips] } : {}),
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(project, data);
          return { ...project, clips: [...clips] };
        }),
      },
      videoProjectClip: {
        findFirst: jest.fn(async () =>
          clips.length ? { order: clips.length - 1 } : null,
        ),
        findMany: jest.fn(async () => clips.map((clip) => ({ id: clip.id }))),
        create: jest.fn(async ({ data }: { data: Partial<Clip> }) => {
          const created = {
            id: `clip-${clips.length}`,
            createdAt: new Date(),
            ...data,
          } as Clip;
          clips.push(created);
          return created;
        }),
        update: jest.fn(async () => ({})),
      },
    };

    const uploads = makeUploads();
    const readObject = jest
      .spyOn(uploads, 'readObject')
      .mockImplementation(async (_area, key) => Buffer.from(`bytes:${key}`));
    const uploadBuffer = jest
      .spyOn(uploads, 'uploadBuffer')
      .mockImplementation(
        async (_buffer, folder, filename) =>
          `${CDN}/${folder}/uuid/${filename}`,
      );

    const ffmpeg = {
      trimAndConcat: jest.fn(async (_clips: unknown, outputPath: string) => {
        fs.writeFileSync(outputPath, Buffer.from('render-montado'));
      }),
      getVideoDuration: jest.fn(async () => 9_500),
    };

    const mode = options.safety ?? 'off';
    const checkInput = jest.fn(async () => {
      if (options.verdict instanceof Error) throw options.verdict;
      return {
        verdict: 'CLEAN',
        ruleId: null,
        strength: 'NONE',
        ...options.verdict,
      } as RuledInputVerdict;
    });
    const imageSafety = {
      imageEnabled: mode !== 'off',
      checkInput,
      actsOn: (verdict: RuledInputVerdict) =>
        verdict.verdict !== 'CLEAN' &&
        isRuleEnforced(
          {
            layer: 'image',
            ruleId: verdict.ruleId,
            strength: verdict.strength,
            cause: verdict.cause,
          },
          { imageMode: mode, textMode: 'off', enforceStrong: true },
        ),
    };

    const service = new VideoEditorService(
      prisma as never,
      uploads,
      ffmpeg as never,
      imageSafety as never,
    );
    const render = (sources: unknown[]) =>
      (
        service as unknown as {
          processRender: (
            p: string,
            u: string,
            c: Clip[],
            s: unknown[],
          ) => Promise<void>;
        }
      ).processRender(PROJECT, OWNER, clips, sources);
    return {
      service,
      prisma,
      db,
      clips,
      project,
      readObject,
      uploadBuffer,
      ffmpeg,
      checkInput,
      render,
    };
  }

  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
      throw new Error('fetch não pode ser chamado');
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  const own = generation('cvid0000000000000000000001', {
    modelUsed: 'veo-3-fast',
  });
  const ownSpicy = generation('cvid0000000000000000000002', {
    modelUsed: 'seedance-2-fast-spicy',
  });
  const otherAccount = generation('cvid0000000000000000000003', {
    userId: OTHER,
  });
  const image = generation('cvid0000000000000000000004', {
    file: 'output_0.png',
    mimeType: 'image/png',
  });
  const inReview = generation('cvid0000000000000000000005', {
    status: GenerationStatus.IN_REVIEW,
  });
  const withEvidence = generation('cvid0000000000000000000006');

  const allGenerations = [
    own,
    ownSpicy,
    otherAccount,
    image,
    inReview,
    withEvidence,
  ];

  const expectNotAllowed = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      code: VIDEO_SOURCE_NOT_ALLOWED,
      message: VIDEO_SOURCE_NOT_ALLOWED_MESSAGE,
    });
  };

  describe('addClip', () => {
    it('aceita vídeo promovido da própria conta e grava a URL e a miniatura do próprio resultado', async () => {
      const { service, prisma } = setup({ generations: allGenerations });
      const clip = await service.addClip(OWNER, PROJECT, {
        sourceUrl: own.outputs[0].url,
        thumbnailUrl: 'https://rastreador.exemplo/pixel.gif',
        durationMs: 8000,
      });
      expect(clip.sourceUrl).toBe(own.outputs[0].url);
      expect(clip.thumbnailUrl).toBe(own.outputs[0].thumbnailUrl);
      expect(prisma.videoProjectClip.create).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['URL externa', 'https://hospedagem-de-fora.com/video.mp4'],
      ['URL interna', 'http://localhost:3000/api/v1/admin/users'],
      ['IP interno', 'http://192.168.0.10/generations/x/u/o.mp4'],
      ['metadados da AWS', 'http://169.254.169.254/latest/meta-data/'],
      [
        'metadados do Google',
        'http://metadata.google.internal/computeMetadata/v1/instance/',
      ],
      [
        'host de fora com o bucket no caminho',
        `http://169.254.169.254/ai-generations/generations/${own.id}/u/output_0.mp4`,
      ],
      [
        'quarentena',
        `https://s3.exemplo.com/${QUARANTINE_BUCKET}/generations/${own.id}/u/output_0.mp4`,
      ],
      ['vídeo de outra conta', otherAccount.outputs[0].url],
      ['imagem (não é vídeo)', image.outputs[0].url],
      ['geração em revisão', inReview.outputs[0].url],
      ['geração com evidência', withEvidence.outputs[0].url],
    ])(
      'recusa %s com 400 genérico e sem baixar nada',
      async (_label, sourceUrl) => {
        const { service, prisma } = setup({
          generations: allGenerations,
          events: [heldEvent(withEvidence.id)],
        });
        await expectNotAllowed(
          service.addClip(OWNER, PROJECT, { sourceUrl, durationMs: 8000 }),
        );
        expect(prisma.videoProjectClip.create).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe('render', () => {
    it('clipe antigo com URL livre: 400 antes de PROCESSING, nada baixado', async () => {
      const { service, prisma } = setup({
        generations: allGenerations,
        clips: [
          { sourceUrl: own.outputs[0].url },
          { sourceUrl: 'http://169.254.169.254/latest/meta-data/' },
        ],
      });
      await expectNotAllowed(service.render(OWNER, PROJECT));
      expect(prisma.videoProject.update).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('clipe cuja geração foi para revisão depois: 400', async () => {
      const gen = generation('cvid0000000000000000000007');
      const { service, db } = setup({
        generations: [gen],
        clips: [{ sourceUrl: gen.outputs[0].url }],
      });
      db.generations[0].status = GenerationStatus.IN_REVIEW;
      await expectNotAllowed(service.render(OWNER, PROJECT));
    });
  });

  describe('processRender', () => {
    const sourcesOf = async (service: VideoEditorService, urls: string[]) => {
      const resolve = (
        service as unknown as {
          resolveSource: (u: string, url: string) => Promise<unknown>;
        }
      ).resolveSource.bind(service);
      return Promise.all(urls.map((url) => resolve(OWNER, url)));
    };

    it('modo off: lê pela chave no bucket público, não checa e publica', async () => {
      const ctx = setup({
        generations: allGenerations,
        clips: [
          { sourceUrl: own.outputs[0].url },
          { sourceUrl: ownSpicy.outputs[0].url },
        ],
      });
      await ctx.render(
        await sourcesOf(ctx.service, [
          own.outputs[0].url,
          ownSpicy.outputs[0].url,
        ]),
      );
      expect(ctx.readObject).toHaveBeenCalledTimes(2);
      expect(ctx.readObject).toHaveBeenCalledWith(
        'public',
        own.outputs[0].url.slice(CDN.length + 1),
        expect.any(Number),
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ctx.checkInput).not.toHaveBeenCalled();
      expect(ctx.uploadBuffer).toHaveBeenCalledWith(
        expect.any(Buffer),
        'video-editor',
        `render-${PROJECT}.mp4`,
        'video/mp4',
      );
      expect(ctx.project.status).toBe(VideoProjectStatus.COMPLETED);
    });

    it('modo ligado: os quadros do render passam pela régua antes de publicar (contexto do servidor)', async () => {
      const ctx = setup({
        generations: allGenerations,
        clips: [
          { sourceUrl: own.outputs[0].url },
          { sourceUrl: ownSpicy.outputs[0].url },
        ],
        safety: 'shadow',
      });
      await ctx.render(
        await sourcesOf(ctx.service, [
          own.outputs[0].url,
          ownSpicy.outputs[0].url,
        ]),
      );
      expect(ctx.checkInput).toHaveBeenCalledTimes(1);
      const [media, context] = ctx.checkInput.mock.calls[0] as unknown as [
        Array<{ kind: string; mimeType: string; buffer: Buffer }>,
        Record<string, unknown>,
      ];
      expect(media).toHaveLength(1);
      expect(media[0]).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
      expect(media[0].buffer.toString()).toBe('render-montado');
      expect(context).toMatchObject({
        userId: OWNER,
        generationId: null,
        tool: 'video_editor',
        // modelo sem censura de qualquer clipe torna o pedido sexual
        model: 'seedance-2-fast-spicy',
        hasUserMedia: true,
      });
      expect(ctx.uploadBuffer).toHaveBeenCalledTimes(1);
      expect(ctx.project.status).toBe(VideoProjectStatus.COMPLETED);
      const checkOrder = ctx.checkInput.mock.invocationCallOrder[0];
      const uploadOrder = ctx.uploadBuffer.mock.invocationCallOrder[0];
      expect(checkOrder).toBeLessThan(uploadOrder);
    });

    it.each([
      [
        'enforce',
        { verdict: 'BLOCK', ruleId: 'E7', cause: 'E2', strength: 'STRONG' },
        IMAGE_SAFETY_BLOCKED_MESSAGE,
      ],
      [
        'shadow',
        { verdict: 'HOLD', ruleId: 'E7', cause: 'E3a', strength: 'MEDIUM' },
        IMAGE_SAFETY_BLOCKED_MESSAGE,
      ],
      [
        'shadow',
        { verdict: 'UNAVAILABLE', ruleId: 'UNAVAILABLE', strength: 'NONE' },
        SAFETY_CHECK_UNAVAILABLE_MESSAGE,
      ],
    ] as const)(
      'modo %s com veredito que age (%j): nada publicado, mensagem genérica',
      async (mode, verdict, message) => {
        const ctx = setup({
          generations: allGenerations,
          clips: [{ sourceUrl: own.outputs[0].url }],
          safety: mode,
          verdict: verdict as Partial<RuledInputVerdict>,
        });
        await ctx.render(await sourcesOf(ctx.service, [own.outputs[0].url]));
        expect(ctx.uploadBuffer).not.toHaveBeenCalled();
        expect(ctx.project.status).toBe(VideoProjectStatus.FAILED);
        expect(ctx.project.errorMessage).toBe(message);
        expect(ctx.project.outputUrl).toBeNull();
      },
    );

    it('sombra: regra de sombra (E4) só registra e o render sai', async () => {
      const ctx = setup({
        generations: allGenerations,
        clips: [{ sourceUrl: own.outputs[0].url }],
        safety: 'shadow',
        verdict: {
          verdict: 'GRAY',
          ruleId: 'E7',
          cause: 'E4',
          strength: 'NONE',
        },
      });
      await ctx.render(await sourcesOf(ctx.service, [own.outputs[0].url]));
      expect(ctx.uploadBuffer).toHaveBeenCalledTimes(1);
      expect(ctx.project.status).toBe(VideoProjectStatus.COMPLETED);
    });

    it('erro na checagem conta como indisponível: não publica', async () => {
      const ctx = setup({
        generations: allGenerations,
        clips: [{ sourceUrl: own.outputs[0].url }],
        safety: 'enforce',
        verdict: new Error('rekognition caiu'),
      });
      await ctx.render(await sourcesOf(ctx.service, [own.outputs[0].url]));
      expect(ctx.uploadBuffer).not.toHaveBeenCalled();
      expect(ctx.project.errorMessage).toBe(SAFETY_CHECK_UNAVAILABLE_MESSAGE);
    });

    it('geração de origem foi para revisão durante o render: não publica (em qualquer modo)', async () => {
      const ctx = setup({
        generations: allGenerations,
        clips: [{ sourceUrl: own.outputs[0].url }],
      });
      const sources = await sourcesOf(ctx.service, [own.outputs[0].url]);
      ctx.db.events.push(heldEvent(own.id));
      await ctx.render(sources);
      expect(ctx.uploadBuffer).not.toHaveBeenCalled();
      expect(ctx.project.status).toBe(VideoProjectStatus.FAILED);
      expect(ctx.project.errorMessage).toBe(VIDEO_SOURCE_NOT_ALLOWED_MESSAGE);
    });

    it('falha técnica: mensagem genérica (sem status, caminho ou chave)', async () => {
      const ctx = setup({
        generations: allGenerations,
        clips: [{ sourceUrl: own.outputs[0].url }],
      });
      ctx.readObject.mockRejectedValueOnce(
        new Error('NoSuchKey generations/x 404'),
      );
      await ctx.render(await sourcesOf(ctx.service, [own.outputs[0].url]));
      expect(ctx.project.status).toBe(VideoProjectStatus.FAILED);
      expect(ctx.project.errorMessage).toBe(RENDER_FAILED_MESSAGE);
      expect(ctx.uploadBuffer).not.toHaveBeenCalled();
    });
  });

  describe('reorderClips', () => {
    it('recusa id de clipe de outro projeto', async () => {
      const ctx = setup({
        generations: allGenerations,
        clips: [{ sourceUrl: own.outputs[0].url }],
      });
      await expect(
        ctx.service.reorderClips(OWNER, PROJECT, [
          'clip-0',
          'clip-de-outro-projeto',
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(ctx.prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
