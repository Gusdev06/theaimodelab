import { GenerationStatus, GenerationType } from '@prisma/client';
import * as sharp from 'sharp';
import {
  fingerprintImage,
  hammingDistance,
  inputImageUrlsOfJob,
  lineageByOrigin,
  matchesAny,
  OwnMediaProvenance,
} from '../own-media';

/** Imagem de teste determinística: blocos de cinza "aleatórios" por semente, ampliados (estrutura de foto real). */
async function syntheticImage(seed: number, width = 600, height = 800, format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
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
  const image = sharp(raw, { raw: { width: cells, height: cells, channels: 3 } }).resize(width, height, {
    kernel: 'cubic',
  });
  return format === 'png' ? image.png().toBuffer() : image.jpeg({ quality: 92 }).toBuffer();
}

/** O que o site faz antes de mandar a foto: reduz e recomprime em JPEG. */
async function asTheSiteSends(buffer: Buffer, maxSide = 1024, quality = 0.8): Promise<Buffer> {
  return sharp(buffer)
    .resize(maxSide, maxSide, { fit: 'inside' })
    .jpeg({ quality: Math.round(quality * 100) })
    .toBuffer();
}

describe('own-media · impressão visual', () => {
  it('a mesma imagem reduzida e recomprimida continua batendo; outra imagem não', async () => {
    const original = await syntheticImage(1, 1536, 2048);
    const sent = await asTheSiteSends(original);
    const other = await syntheticImage(2, 1536, 2048);

    const a = await fingerprintImage(original);
    const b = await fingerprintImage(sent);
    const c = await fingerprintImage(other);

    expect(hammingDistance(a.dhash, b.dhash)).toBeLessThanOrEqual(4);
    expect(matchesAny(b, [a])).toBe(true);
    expect(hammingDistance(a.dhash, c.dhash)).toBeGreaterThan(12);
    expect(matchesAny(c, [a])).toBe(false);
  });

  it('proporção diferente não bate, mesmo com a imagem parecida', async () => {
    const tall = await fingerprintImage(await syntheticImage(3, 600, 800));
    const square = { ...tall, aspect: 1 };
    expect(matchesAny(square, [tall])).toBe(false);
  });

  it('hash inválido nunca bate', () => {
    expect(hammingDistance('zz', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('00000000000000ff', '0000000000000000')).toBe(8);
  });
});

describe('own-media · linhagem pela origem', () => {
  it('só texto é limpa; com foto depende das fotos; prompt clonado de foto e outros tipos nunca', () => {
    expect(lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 0, prompt: 'mulher adulta' })).toBe('clean');
    expect(lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 2, prompt: 'x' })).toBe('check_inputs');
    expect(lineageByOrigin({ type: GenerationType.IMAGE_TO_IMAGE, inputImageCount: 1, prompt: 'x' })).toBe('check_inputs');
    expect(lineageByOrigin({ type: GenerationType.IMAGE_TO_IMAGE, inputImageCount: 0, prompt: 'x' })).toBe('not_clean');
    expect(
      lineageByOrigin({ type: GenerationType.TEXT_TO_IMAGE, inputImageCount: 0, prompt: '[reference_override]: mulher ruiva' }),
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
      generation: {
        findUnique: jest.fn(async () => state.generation ?? null),
        findMany: jest.fn(async () => state.backfill ?? []),
      },
    };
  }

  it('foto que é a geração limpa da própria conta: reconhecida', async () => {
    const print = await fingerprintImage(images['https://cdn/saida-modelo.png']);
    const prisma = prismaWith({ fingerprints: [{ userId: 'u1', cleanLineage: true, ...print }] });
    const own = new OwnMediaProvenance(prisma as any);

    await expect(own.allOwnClean('u1', ['https://cdn/entrada-modelo.jpg'])).resolves.toBe(true);
  });

  it('foto de fora, foto de outra conta, linhagem suja ou lista vazia: não reconhecida', async () => {
    const print = await fingerprintImage(images['https://cdn/saida-modelo.png']);
    const prisma = prismaWith({
      fingerprints: [
        { userId: 'u1', cleanLineage: true, ...print },
        { userId: 'u2', cleanLineage: true, ...print },
      ],
    });
    const own = new OwnMediaProvenance(prisma as any);

    await expect(own.allOwnClean('u1', ['https://cdn/foto-de-fora.jpg'])).resolves.toBe(false);
    await expect(own.allOwnClean('u1', ['https://cdn/entrada-modelo.jpg', 'https://cdn/foto-de-fora.jpg'])).resolves.toBe(false);
    await expect(own.allOwnClean('u3', ['https://cdn/entrada-modelo.jpg'])).resolves.toBe(false);
    await expect(own.allOwnClean('u1', [])).resolves.toBe(false);
    await expect(own.allOwnClean('u1', null)).resolves.toBe(false);

    const dirty = new OwnMediaProvenance(
      prismaWith({ fingerprints: [{ userId: 'u1', cleanLineage: false, ...print }] }) as any,
    );
    await expect(dirty.allOwnClean('u1', ['https://cdn/entrada-modelo.jpg'])).resolves.toBe(false);
  });

  it('geração antiga (sem impressão): ganha a impressão na hora se nasceu de texto; no máximo 1x a cada 30 min', async () => {
    const state: any = {
      fingerprints: [],
      backfill: [{ id: 'g-antiga', prompt: 'mulher adulta ruiva', outputs: [{ url: 'https://cdn/saida-modelo.png', order: 0 }] }],
    };
    const prisma = prismaWith(state);
    const own = new OwnMediaProvenance(prisma as any);

    await expect(own.allOwnClean('u1', ['https://cdn/entrada-modelo.jpg'])).resolves.toBe(true);
    expect(prisma.mediaFingerprint.upsert).toHaveBeenCalledTimes(1);
    expect(state.fingerprints[0]).toMatchObject({ userId: 'u1', generationId: 'g-antiga', cleanLineage: true });
    expect((prisma.generation.findMany.mock.calls[0] as any[])[0].where).toMatchObject({
      userId: 'u1',
      type: GenerationType.TEXT_TO_IMAGE,
      inputImages: { none: {} },
    });

    // foto de fora logo depois: não baixa a galeria de novo
    await expect(own.allOwnClean('u1', ['https://cdn/foto-de-fora.jpg'])).resolves.toBe(false);
    expect(prisma.generation.findMany).toHaveBeenCalledTimes(1);
  });

  it('download que falha ou arquivo que não é imagem: não reconhecida, sem lançar', async () => {
    const own = new OwnMediaProvenance(prismaWith({ fingerprints: [] }) as any);
    await expect(own.allOwnClean('u1', ['https://cdn/nao-existe.jpg'])).resolves.toBe(false);
    await expect(own.allOwnClean('u1', ['http://cdn/sem-https.jpg'])).resolves.toBe(false);
  });

  describe('recordGeneration (conclusão)', () => {
    const generation = (overrides: Record<string, unknown>) => ({
      userId: 'u1',
      type: GenerationType.TEXT_TO_IMAGE,
      prompt: 'mulher adulta',
      status: GenerationStatus.COMPLETED,
      inputImages: [],
      outputs: [{ url: 'https://cdn/saida-modelo.png', order: 0 }],
      ...overrides,
    });

    it('só texto: grava a impressão limpa (usa a impressão que a conclusão já calculou)', async () => {
      const state: any = { fingerprints: [], generation: generation({}) };
      const prisma = prismaWith(state);
      const precomputed = await fingerprintImage(images['https://cdn/saida-modelo.png']);

      await new OwnMediaProvenance(prisma as any).recordGeneration('g1', [precomputed]);

      expect(state.fingerprints).toEqual([
        expect.objectContaining({ generationId: 'g1', outputOrder: 0, cleanLineage: true, dhash: precomputed.dhash }),
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a partir de foto da própria modelo: limpa; a partir de foto de fora: suja', async () => {
      const print = await fingerprintImage(images['https://cdn/saida-modelo.png']);
      const clean: any = {
        fingerprints: [{ userId: 'u1', cleanLineage: true, ...print }],
        generation: generation({
          type: GenerationType.IMAGE_TO_IMAGE,
          inputImages: [{ url: 'https://cdn/entrada-modelo.jpg' }],
        }),
      };
      await new OwnMediaProvenance(prismaWith(clean) as any).recordGeneration('g2');
      expect(clean.fingerprints.at(-1)).toMatchObject({ generationId: 'g2', cleanLineage: true });

      const dirty: any = {
        fingerprints: [{ userId: 'u1', cleanLineage: true, ...print }],
        generation: generation({
          type: GenerationType.IMAGE_TO_IMAGE,
          inputImages: [{ url: 'https://cdn/foto-de-fora.jpg' }],
        }),
      };
      await new OwnMediaProvenance(prismaWith(dirty) as any).recordGeneration('g3');
      expect(dirty.fingerprints.at(-1)).toMatchObject({ generationId: 'g3', cleanLineage: false });
    });

    it('troca de rosto, vídeo ou geração que não concluiu: não grava nada', async () => {
      for (const overrides of [
        { type: GenerationType.FACE_SWAP },
        { type: GenerationType.IMAGE_TO_VIDEO },
        { status: GenerationStatus.FAILED },
      ]) {
        const state: any = { fingerprints: [], generation: generation(overrides) };
        await new OwnMediaProvenance(prismaWith(state) as any).recordGeneration('g4');
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
      await expect(new OwnMediaProvenance(prisma as any).recordGeneration('g5')).resolves.toBeUndefined();
    });
  });
});
