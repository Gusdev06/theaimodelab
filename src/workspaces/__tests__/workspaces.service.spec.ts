import * as sharp from 'sharp';
import { isRuleEnforced } from '../../content-safety/image-safety/image-safety.config';
import type { RuledInputVerdict } from '../../content-safety/image-safety/image-safety.rules';
import {
  CDN,
  OWNER,
  makeUploads,
} from '../../community/__tests__/promoted-output.fixtures';
import {
  THUMBNAIL_CHECK_INTERVAL_MS,
  THUMBNAIL_MAX_BYTES,
  WorkspacesService,
} from '../workspaces.service';

/**
 * Miniatura do quadro (passo 22): só JPEG/PNG/WebP pequeno, refeito no servidor como JPEG sem metadados; com a
 * checagem ligada, checado antes de ir ao público. URL que não é data URL nunca é gravada. As imagens do teste são
 * cor sólida geradas aqui (nenhuma pessoa).
 */
describe('WorkspacesService · miniatura', () => {
  const WORKSPACE = 'ws-1';

  async function solidImage(
    format: 'jpeg' | 'png' | 'webp' | 'gif',
    size = 64,
  ): Promise<Buffer> {
    const base = sharp({
      create: {
        width: size,
        height: size,
        channels: 3,
        background: { r: 200, g: 40, b: 60 },
      },
    });
    if (format === 'jpeg') return base.jpeg().toBuffer();
    if (format === 'png') return base.png().toBuffer();
    if (format === 'webp') return base.webp().toBuffer();
    return base.gif().toBuffer();
  }

  const dataUrl = (mime: string, body: Buffer) =>
    `data:${mime};base64,${body.toString('base64')}`;

  function setup(
    options: {
      safety?: 'off' | 'shadow' | 'enforce';
      verdict?: Partial<RuledInputVerdict> | Error;
    } = {},
  ) {
    const workspace = {
      id: WORKSPACE,
      userId: OWNER,
      name: 'Quadro',
      thumbnailUrl: `${CDN}/workspaces/${WORKSPACE}/thumb/old/thumbnail.jpg` as
        | string
        | null,
    };
    const prisma = {
      workspace: {
        findUnique: jest.fn(async () => ({ ...workspace })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(workspace, data);
          return { ...workspace };
        }),
      },
    };
    const uploads = makeUploads();
    const uploadBuffer = jest
      .spyOn(uploads, 'uploadBuffer')
      .mockImplementation(
        async (_buffer, folder, filename) =>
          `${CDN}/${folder}/novo/${filename}`,
      );
    const deleteByPrefix = jest
      .spyOn(uploads, 'deleteByPrefix')
      .mockResolvedValue(1);

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
    const service = new WorkspacesService(
      prisma as never,
      uploads,
      imageSafety as never,
    );
    return {
      service,
      prisma,
      workspace,
      uploadBuffer,
      deleteByPrefix,
      checkInput,
    };
  }

  const updateData = (prisma: { workspace: { update: jest.Mock } }) =>
    (
      prisma.workspace.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      }
    ).data;

  it('modo off: JPEG do canvas é refeito como JPEG sem metadados e publicado na pasta do quadro', async () => {
    const ctx = setup();
    const original = await sharp(await solidImage('png', 1200))
      .withMetadata({ exif: { IFD0: { Copyright: 'carga-escondida' } } })
      .jpeg()
      .toBuffer();
    await ctx.service.update(OWNER, WORKSPACE, {
      thumbnailUrl: dataUrl('image/jpeg', original),
    });

    expect(ctx.checkInput).not.toHaveBeenCalled();
    expect(ctx.uploadBuffer).toHaveBeenCalledTimes(1);
    const [stored, folder, filename, contentType] =
      ctx.uploadBuffer.mock.calls[0];
    expect(folder).toBe(`workspaces/${WORKSPACE}/thumb`);
    expect(filename).toBe('thumbnail.jpg');
    expect(contentType).toBe('image/jpeg');
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      960,
    );
    expect(meta.exif).toBeUndefined();
    expect(updateData(ctx.prisma).thumbnailUrl).toBe(
      `${CDN}/workspaces/${WORKSPACE}/thumb/novo/thumbnail.jpg`,
    );
  });

  it.each(['png', 'webp'] as const)('aceita %s (vira JPEG)', async (format) => {
    const ctx = setup();
    await ctx.service.update(OWNER, WORKSPACE, {
      thumbnailUrl: dataUrl(`image/${format}`, await solidImage(format)),
    });
    expect(ctx.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(ctx.uploadBuffer.mock.calls[0][3]).toBe('image/jpeg');
  });

  it.each([
    [
      'SVG (script na CDN)',
      'data:image/svg+xml;base64,' +
        Buffer.from('<svg onload="alert(1)"/>').toString('base64'),
    ],
    [
      'HTML disfarçado',
      'data:text/html;base64,' +
        Buffer.from('<script>x</script>').toString('base64'),
    ],
    [
      'bytes que não são imagem',
      'data:image/jpeg;base64,' +
        Buffer.from('não sou imagem').toString('base64'),
    ],
    [
      'acima do teto',
      'data:image/jpeg;base64,' +
        'A'.repeat(Math.ceil((THUMBNAIL_MAX_BYTES + 10) / 3) * 4),
    ],
  ])('recusa %s sem derrubar o autosave', async (_label, thumbnailUrl) => {
    const ctx = setup();
    await ctx.service.update(OWNER, WORKSPACE, {
      thumbnailUrl,
      name: 'novo nome',
    });
    expect(ctx.uploadBuffer).not.toHaveBeenCalled();
    expect(ctx.deleteByPrefix).not.toHaveBeenCalled();
    const data = updateData(ctx.prisma);
    expect(data).not.toHaveProperty('thumbnailUrl');
    expect(data.name).toBe('novo nome');
  });

  it('recusa GIF', async () => {
    const ctx = setup();
    await ctx.service.update(OWNER, WORKSPACE, {
      thumbnailUrl: dataUrl('image/gif', await solidImage('gif')),
    });
    expect(ctx.uploadBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ['URL externa', 'https://hospedagem-de-fora.com/foto.jpg'],
    ['URL interna', 'http://169.254.169.254/latest/meta-data/'],
    [
      'URL de outra conta no nosso bucket',
      `${CDN}/generations/cdeoutraconta000000000001/u/output.png`,
    ],
  ])('ignora %s (só data URL vira miniatura)', async (_label, thumbnailUrl) => {
    const ctx = setup();
    await ctx.service.update(OWNER, WORKSPACE, { thumbnailUrl });
    expect(ctx.uploadBuffer).not.toHaveBeenCalled();
    expect(updateData(ctx.prisma)).not.toHaveProperty('thumbnailUrl');
  });

  it('modo ligado: o JPEG refeito passa pelo checkInput antes de publicar', async () => {
    const ctx = setup({ safety: 'shadow' });
    await ctx.service.update(OWNER, WORKSPACE, {
      thumbnailUrl: dataUrl('image/jpeg', await solidImage('jpeg')),
    });
    expect(ctx.checkInput).toHaveBeenCalledTimes(1);
    const [media, context] = ctx.checkInput.mock.calls[0] as unknown as [
      Array<{ kind: string; mimeType: string; buffer: Buffer }>,
      Record<string, unknown>,
    ];
    expect(media[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' });
    expect(media[0].buffer.equals(ctx.uploadBuffer.mock.calls[0][0])).toBe(
      true,
    );
    expect(context).toMatchObject({ userId: OWNER, generationId: null });
    expect(ctx.checkInput.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.uploadBuffer.mock.invocationCallOrder[0],
    );
  });

  it('modo ligado, barrado: não publica e tira a miniatura anterior', async () => {
    const ctx = setup({
      safety: 'enforce',
      verdict: { verdict: 'BLOCK', ruleId: 'E2', strength: 'STRONG' },
    });
    await ctx.service.update(OWNER, WORKSPACE, {
      thumbnailUrl: dataUrl('image/jpeg', await solidImage('jpeg')),
    });
    expect(ctx.uploadBuffer).not.toHaveBeenCalled();
    expect(ctx.deleteByPrefix).toHaveBeenCalledWith(
      `workspaces/${WORKSPACE}/thumb/`,
    );
    expect(updateData(ctx.prisma).thumbnailUrl).toBeNull();
  });

  it.each([
    [
      'indisponível',
      {
        verdict: 'UNAVAILABLE',
        ruleId: 'UNAVAILABLE',
        strength: 'NONE',
      } as Partial<RuledInputVerdict>,
    ],
    ['erro na checagem', new Error('rekognition caiu')],
  ])(
    'modo ligado, %s: não publica e mantém a anterior',
    async (_label, verdict) => {
      const ctx = setup({ safety: 'shadow', verdict });
      await ctx.service.update(OWNER, WORKSPACE, {
        thumbnailUrl: dataUrl('image/jpeg', await solidImage('jpeg')),
      });
      expect(ctx.uploadBuffer).not.toHaveBeenCalled();
      expect(ctx.deleteByPrefix).not.toHaveBeenCalled();
      expect(updateData(ctx.prisma)).not.toHaveProperty('thumbnailUrl');
    },
  );

  it('modo ligado: no máximo uma checagem paga por quadro no intervalo (o autosave manda várias)', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const ctx = setup({ safety: 'shadow' });
      const thumb = dataUrl('image/jpeg', await solidImage('jpeg'));
      await ctx.service.update(OWNER, WORKSPACE, { thumbnailUrl: thumb });
      await ctx.service.update(OWNER, WORKSPACE, { thumbnailUrl: thumb });
      expect(ctx.checkInput).toHaveBeenCalledTimes(1);
      expect(ctx.uploadBuffer).toHaveBeenCalledTimes(1);
      expect(
        (ctx.prisma.workspace.update.mock.calls[1][0] as { data: object }).data,
      ).not.toHaveProperty('thumbnailUrl');

      now.mockReturnValue(1_000_000 + THUMBNAIL_CHECK_INTERVAL_MS);
      await ctx.service.update(OWNER, WORKSPACE, { thumbnailUrl: thumb });
      expect(ctx.checkInput).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('modo off: sem intervalo (comportamento de antes)', async () => {
    const ctx = setup();
    const thumb = dataUrl('image/jpeg', await solidImage('jpeg'));
    await ctx.service.update(OWNER, WORKSPACE, { thumbnailUrl: thumb });
    await ctx.service.update(OWNER, WORKSPACE, { thumbnailUrl: thumb });
    expect(ctx.uploadBuffer).toHaveBeenCalledTimes(2);
  });
});
