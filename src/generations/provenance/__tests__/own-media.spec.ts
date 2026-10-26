import { GenerationStatus, GenerationType } from '@prisma/client';
import * as sharp from 'sharp';
import {
  bestMatch,
  compare,
  DETOUR_MATCH,
  fingerprintImage,
  hammingDistance,
  inputImageUrlsOfJob,
  LINEAGE_MATCH,
  lineageByOrigin,
  OwnMediaProvenance,
  substituteImageUrls,
  thumbDifference,
} from '../own-media';

/** Imagem de teste determinística: blocos de cor "aleatórios" por semente, ampliados (estrutura de foto real). */
async function syntheticImage(seed: number, width = 600, height = 800): Promise<Buffer> {
  const cells = 12;
  const raw = Buffer.alloc(cells * cells * 3);
  let state = seed * 9973 + 17;
  for (let i = 0; i < cells * cells; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const level = state % 256;
    raw[i * 3] = level;
    raw[i * 3 + 1] = (level * 7) % 256;
    raw[i * 3 + 2] = 255 - level;
  }
  return sharp(raw, { raw: { width: cells, height: cells, channels: 3 } })
    .resize(width, height, { kernel: 'cubic' })
    .png()
    .toBuffer();
}

/** O que o site faz antes de mandar a foto: reduz e recomprime em JPEG. */
async function asTheSiteSends(buffer: Buffer, maxSide = 1024, quality = 80): Promise<Buffer> {
  return sharp(buffer).resize(maxSide, maxSide, { fit: 'inside' }).jpeg({ quality }).toBuffer();
}

describe('own-media · impressão visual', () => {
  it('a mesma imagem reduzida e recomprimida bate nos dois critérios; outra imagem não', async () => {
    const original = await fingerprintImage(await syntheticImage(1, 1536, 2048));
    const sent = await fingerprintImage(await asTheSiteSends(await syntheticImage(1, 1536, 2048)));
    const other = await fingerprintImage(await syntheticImage(2, 1536, 2048));

    expect(compare(sent, original, LINEAGE_MATCH)).not.toBeNull();
    expect(compare(sent, original, DETOUR_MATCH)).not.toBeNull();
    expect(compare(other, original, DETOUR_MATCH)).toBeNull();
    expect(hammingDistance(original.dhash, other.dhash)).toBeGreaterThan(12);
  });

  it('proporção diferente não bate, mesmo com a imagem parecida', async () => {
    const tall = await fingerprintImage(await syntheticImage(3, 600, 800));
    expect(compare({ ...tall, aspect: 1 }, tall, DETOUR_MATCH)).toBeNull();
  });

  it('dHash igual mas miniatura diferente não bate (o dHash sozinho é fácil de forjar)', async () => {
    const real = await fingerprintImage(await syntheticImage(4));
    const forged = { ...(await fingerprintImage(await syntheticImage(5))), dhash: real.dhash, aspect: real.aspect };
    expect(thumbDifference(forged.thumb, real.thumb)).toBeGreaterThan(DETOUR_MATCH.maxThumbDiff);
    expect(compare(forged, real, DETOUR_MATCH)).toBeNull();
  });

  it('a melhor entre várias impressões e hashes inválidos', async () => {
    const target = await fingerprintImage(await syntheticImage(6));
    const known = [
      { ...(await fingerprintImage(await syntheticImage(7))), id: 'outra' },
      { ...target, id: 'certa' },
    ];
    expect(bestMatch(target, known, DETOUR_MATCH)?.item.id).toBe('certa');
    expect(hammingDistance('zz', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('00000000000000ff', '0000000000000000')).toBe(8);
    expect(thumbDifference('ab', target.thumb)).toBe(255);
  });

  it('transparência, várias páginas e imagem gigante não são conferidas', async () => {
    const transparent = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 0 } },
    })
      .png()
      .toBuffer();
    await expect(fingerprintImage(transparent)).rejects.toThrow(/transparência/);

    const opaqueWithAlpha = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await expect(fingerprintImage(opaqueWithAlpha)).resolves.toMatchObject({ aspect: 1 });

    const frame = (r: number) =>
      sharp({ create: { width: 16, height: 16, channels: 3, background: { r, g: 0, b: 0 } } }).raw().toBuffer();
    const animated = await sharp(Buffer.concat([await frame(10), await frame(200)]), {
      raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } as never,
    })
      .gif()
      .toBuffer();
    await expect(fingerprintImage(animated)).rejects.toThrow();

    // 9000 x 9000 = 81 MP, acima do teto de 40 MP (comprimido, o arquivo é pequeno)
    const huge = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#808080' } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(fingerprintImage(huge)).rejects.toThrow();
  });
});

describe('own-media · regras', () => {
  it('linhagem: só texto limpa; com foto depende; prompt clonado, busca do Google e outros tipos nunca', () => {
    expect(lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 0, prompt: 'mulher adulta' })).toBe('clean');
    expect(lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 2, prompt: 'x' })).toBe('check_inputs');
    expect(lineageByOrigin({ type: GenerationType.IMAGE_TO_IMAGE, inputImageCount: 1, prompt: 'x' })).toBe('check_inputs');
    expect(lineageByOrigin({ type: GenerationType.IMAGE_TO_IMAGE, inputImageCount: 0, prompt: 'x' })).toBe('not_clean');
    expect(
      lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 0, prompt: '[reference_override]: ruiva' }),
    ).toBe('not_clean');
    expect(
      lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 0, prompt: 'x', parameters: { google_search: true } }),
    ).toBe('not_clean');
    expect(
      lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 0, prompt: 'x', parameters: { googleSearch: true } }),
    ).toBe('not_clean');
    expect(lineageByOrigin({ type: GenerationType.FACE_SWAP, inputImageCount: 0, prompt: null })).toBe('not_clean');
    expect(lineageByOrigin({ type: GenerationType.VIRTUAL_TRY_ON, inputImageCount: 2, prompt: null })).toBe('not_clean');
  });

  it('fotos do job: junta os campos de imagem; vídeo, áudio ou formato estranho = não confere', () => {
    expect(inputImageUrlsOfJob({ imageUrl: 'https://a/1.jpg', imageUrls: ['https://a/2.jpg', 'https://a/1.jpg'] })).toEqual([
      'https://a/1.jpg',
      'https://a/2.jpg',
    ]);
    expect(inputImageUrlsOfJob({ hasInputImages: true }, ['https://a/guardada.jpg'])).toEqual(['https://a/guardada.jpg']);
    expect(inputImageUrlsOfJob({ imageUrl: 'https://a/1.jpg', referenceVideoUrls: ['https://a/v.mp4'] })).toBeNull();
    expect(inputImageUrlsOfJob({ imageUrl: 'https://a/1.jpg', audioUrl: 'https://a/a.mp3' })).toBeNull();
    expect(inputImageUrlsOfJob({ imageUrl: 'https://a/1.jpg', hasVideoInput: true })).toBeNull();
    expect(inputImageUrlsOfJob({ referenceImageUrls: [{ url: 'https://a/1.jpg' }] })).toBeNull();
    expect(inputImageUrlsOfJob({ prompt: 'só texto' })).toEqual([]);
  });

  it('troca as fotos do job pelas cópias; sobrou foto sem troca ou vídeo = null', () => {
    const map = new Map([
      ['https://in/1.jpg', 'https://s3/saida-1.png'],
      ['https://in/2.jpg', 'https://s3/saida-2.png'],
    ]);
    expect(
      substituteImageUrls({ prompt: 'p', imageUrl: 'https://in/1.jpg', referenceImageUrls: ['https://in/2.jpg'] }, map),
    ).toEqual({ prompt: 'p', imageUrl: 'https://s3/saida-1.png', referenceImageUrls: ['https://s3/saida-2.png'] });
    expect(substituteImageUrls({ imageUrls: ['https://in/1.jpg', 'https://in/de-fora.jpg'] }, map)).toBeNull();
    expect(substituteImageUrls({ imageUrl: 'https://in/1.jpg', videoUrl: 'https://in/v.mp4' }, map)).toBeNull();
    expect(substituteImageUrls({ imageUrl: { url: 'https://in/1.jpg' } }, map)).toBeNull();
  });
});

describe('OwnMediaProvenance', () => {
  let images: Record<string, Buffer>;
  let fetchSpy: jest.SpyInstance;

  beforeAll(async () => {
    const modelPhoto = await syntheticImage(10, 1024, 1536);
    images = {
      'https://cdn/saida-modelo.png': modelPhoto,
      'https://cdn/entrada-modelo.jpg': await asTheSiteSends(modelPhoto),
      'https://cdn/foto-de-fora.jpg': await asTheSiteSends(await syntheticImage(99, 1024, 1536)),
    };
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
      const body = images[String(input)];
      if (!body) return new Response(null, { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  function prismaWith(state: { fingerprints: any[]; generation?: any; backfill?: any[] }) {
    return {
      mediaFingerprint: {
        findMany: jest.fn(async ({ where }: any) =>
          state.fingerprints.filter((row) => row.userId === where.userId && row.cleanLineage === where.cleanLineage),
        ),
        upsert: jest.fn(async ({ create }: any) => {
          state.fingerprints.push(create);
          return create;
        }),
      },
      generationOutput: {
        findFirst: jest.fn(async ({ where }: any) => ({ url: `https://s3/${where.generationId}/${where.order}.png` })),
      },
      generation: {
        findUnique: jest.fn(async () => state.generation ?? null),
        findMany: jest.fn(async () => state.backfill ?? []),
      },
    };
  }

  const known = async (overrides: Record<string, unknown> = {}) => ({
    userId: 'u1',
    cleanLineage: true,
    generationId: 'g-modelo',
    outputOrder: 0,
    ...(await fingerprintImage(images['https://cdn/saida-modelo.png'])),
    ...overrides,
  });

  it('foto que é a geração limpa da própria conta: casa e devolve a NOSSA cópia', async () => {
    const prisma = prismaWith({ fingerprints: [await known()] });
    const matches = await new OwnMediaProvenance(prisma as any).matchOwnClean('u1', ['https://cdn/entrada-modelo.jpg']);

    expect(matches).toEqual([
      expect.objectContaining({
        inputUrl: 'https://cdn/entrada-modelo.jpg',
        generationId: 'g-modelo',
        outputOrder: 0,
        outputUrl: 'https://s3/g-modelo/0.png',
      }),
    ]);
    // a consulta só olha impressões limpas cuja saída ainda existe
    expect((prisma.mediaFingerprint.findMany.mock.calls[0] as any[])[0].where).toMatchObject({
      userId: 'u1',
      cleanLineage: true,
      generation: { OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] },
    });
  });

  it('foto de fora, foto de outra conta, linhagem suja, lista vazia ou mídia sem conferência: não casa', async () => {
    const own = new OwnMediaProvenance(
      prismaWith({ fingerprints: [await known(), await known({ userId: 'u2' })] }) as any,
    );
    await expect(own.matchOwnClean('u1', ['https://cdn/foto-de-fora.jpg'])).resolves.toBeNull();
    await expect(own.matchOwnClean('u1', ['https://cdn/entrada-modelo.jpg', 'https://cdn/foto-de-fora.jpg'])).resolves.toBeNull();
    await expect(own.matchOwnClean('u3', ['https://cdn/entrada-modelo.jpg'])).resolves.toBeNull();
    await expect(own.matchOwnClean('u1', [])).resolves.toBeNull();
    await expect(own.matchOwnClean('u1', null)).resolves.toBeNull();

    const dirty = new OwnMediaProvenance(prismaWith({ fingerprints: [await known({ cleanLineage: false })] }) as any);
    await expect(dirty.matchOwnClean('u1', ['https://cdn/entrada-modelo.jpg'])).resolves.toBeNull();
  });

  it('geração antiga (sem impressão): ganha a impressão na hora se nasceu de texto; no máximo 1x a cada 30 min', async () => {
    const state: any = {
      fingerprints: [],
      backfill: [
        { id: 'g-antiga', prompt: 'mulher adulta ruiva', parameters: {}, outputs: [{ url: 'https://cdn/saida-modelo.png', order: 0 }] },
      ],
    };
    const prisma = prismaWith(state);
    const own = new OwnMediaProvenance(prisma as any);

    await expect(own.matchOwnClean('u1', ['https://cdn/entrada-modelo.jpg'])).resolves.toEqual([
      expect.objectContaining({ generationId: 'g-antiga' }),
    ]);
    expect(state.fingerprints[0]).toMatchObject({ userId: 'u1', generationId: 'g-antiga', cleanLineage: true });
    expect((prisma.generation.findMany.mock.calls[0] as any[])[0].where).toMatchObject({
      userId: 'u1',
      type: GenerationType.TEXT_TO_IMAGE,
    });

    await expect(own.matchOwnClean('u1', ['https://cdn/foto-de-fora.jpg'])).resolves.toBeNull();
    expect(prisma.generation.findMany).toHaveBeenCalledTimes(1);
  });

  it('geração antiga feita com busca do Google: ganha impressão, mas suja', async () => {
    const state: any = {
      fingerprints: [],
      backfill: [
        { id: 'g-google', prompt: 'x', parameters: { google_search: true }, outputs: [{ url: 'https://cdn/saida-modelo.png', order: 0 }] },
      ],
    };
    await expect(
      new OwnMediaProvenance(prismaWith(state) as any).matchOwnClean('u1', ['https://cdn/entrada-modelo.jpg']),
    ).resolves.toBeNull();
    expect(state.fingerprints[0]).toMatchObject({ generationId: 'g-google', cleanLineage: false });
  });

  it('download que falha, sem https ou saída sem link público: não casa, sem lançar', async () => {
    const own = new OwnMediaProvenance(prismaWith({ fingerprints: [await known()] }) as any);
    await expect(own.matchOwnClean('u1', ['https://cdn/nao-existe.jpg'])).resolves.toBeNull();
    await expect(own.matchOwnClean('u1', ['http://cdn/sem-https.jpg'])).resolves.toBeNull();

    const prisma = prismaWith({ fingerprints: [await known()] });
    prisma.generationOutput.findFirst.mockResolvedValue(null as never);
    await expect(
      new OwnMediaProvenance(prisma as any).matchOwnClean('u1', ['https://cdn/entrada-modelo.jpg']),
    ).resolves.toBeNull();
  });

  describe('recordGeneration (conclusão)', () => {
    const generation = (overrides: Record<string, unknown>) => ({
      userId: 'u1',
      type: GenerationType.TEXT_TO_IMAGE,
      prompt: 'mulher adulta',
      status: GenerationStatus.COMPLETED,
      parameters: {},
      inputImages: [],
      outputs: [{ url: 'https://cdn/saida-modelo.png', order: 0 }],
      ...overrides,
    });

    it('só texto: grava a impressão limpa (usa a impressão que a conclusão já calculou)', async () => {
      const state: any = { fingerprints: [], generation: generation({}) };
      const precomputed = await fingerprintImage(images['https://cdn/saida-modelo.png']);

      await new OwnMediaProvenance(prismaWith(state) as any).recordGeneration('g1', [precomputed]);

      expect(state.fingerprints).toEqual([
        expect.objectContaining({ generationId: 'g1', outputOrder: 0, cleanLineage: true, dhash: precomputed.dhash }),
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a partir de foto da própria modelo: limpa; a partir de foto de fora ou com busca do Google: suja', async () => {
      const clean: any = {
        fingerprints: [await known()],
        generation: generation({ type: GenerationType.IMAGE_TO_IMAGE, inputImages: [{ url: 'https://cdn/entrada-modelo.jpg' }] }),
      };
      await new OwnMediaProvenance(prismaWith(clean) as any).recordGeneration('g2');
      expect(clean.fingerprints.at(-1)).toMatchObject({ generationId: 'g2', cleanLineage: true });

      const dirty: any = {
        fingerprints: [await known()],
        generation: generation({ type: GenerationType.IMAGE_TO_IMAGE, inputImages: [{ url: 'https://cdn/foto-de-fora.jpg' }] }),
      };
      await new OwnMediaProvenance(prismaWith(dirty) as any).recordGeneration('g3');
      expect(dirty.fingerprints.at(-1)).toMatchObject({ generationId: 'g3', cleanLineage: false });

      const google: any = { fingerprints: [], generation: generation({ parameters: { google_search: true } }) };
      await new OwnMediaProvenance(prismaWith(google) as any).recordGeneration('g4');
      expect(google.fingerprints.at(-1)).toMatchObject({ generationId: 'g4', cleanLineage: false });
    });

    it('troca de rosto, vídeo ou geração que não concluiu: não grava nada', async () => {
      for (const overrides of [
        { type: GenerationType.FACE_SWAP },
        { type: GenerationType.IMAGE_TO_VIDEO },
        { status: GenerationStatus.FAILED },
      ]) {
        const state: any = { fingerprints: [], generation: generation(overrides) };
        await new OwnMediaProvenance(prismaWith(state) as any).recordGeneration('g5');
        expect(state.fingerprints).toEqual([]);
      }
    });

    it('banco fora do ar: não lança', async () => {
      const prisma = {
        generation: {
          findUnique: jest.fn(async () => {
            throw new Error('db down');
          }),
        },
      };
      await expect(new OwnMediaProvenance(prisma as any).recordGeneration('g6')).resolves.toBeUndefined();
    });
  });
});
