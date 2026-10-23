import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { GenerationImageRole, Resolution } from '@prisma/client';
import { GenerationsService } from '../generations.service';
import { GenerationJobName } from '../queue/generation-queue.constants';
import {
  PRIVATE_INPUT_CACHE_CONTROL,
  UploadsService,
} from '../../uploads/uploads.service';

// o vídeo de movimento do teste não é um MP4 de verdade: a duração vem simulada
jest.mock('../utils/video-duration.util', () => ({
  getVideoDurationSeconds: jest.fn(() => 5),
}));

/**
 * Pontos de chamada das entradas em generations.service: com S3_INPUT_PRIVATE_BUCKET a foto/vídeo enviado vai para o
 * bucket privado, e a URL gravada em generation_input_images e mandada na fila (para o provedor) é a assinada, com a
 * validade de SAFETY_INPUT_URL_TTL. Sem a env, nada muda: bucket público e URL pública.
 */
describe('GenerationsService · entradas privadas', () => {
  const PUBLIC_BUCKET = 'ai-generations';
  const PRIVATE_BUCKET = 'taml-inputs-private';
  const CDN = 'https://cdn.exemplo.com/storage/v1/object/public/ai-generations';
  const GENERATION_ID = 'cgen0000000000000000000001';
  const USER_ID = 'cuser000000000000000000001';

  const uploadsFor = (privateBucket?: string, ttl?: string) =>
    new UploadsService({
      get: jest.fn((key: string, fallback?: string) => {
        const values: Record<string, string | undefined> = {
          S3_ENDPOINT: 'https://s3.exemplo.com',
          S3_REGION: 'us-east-1',
          S3_ACCESS_KEY: 'chave-de-teste',
          S3_SECRET_KEY: 'segredo-de-teste',
          S3_BUCKET_NAME: PUBLIC_BUCKET,
          S3_PUBLIC_URL: CDN,
          S3_INPUT_PRIVATE_BUCKET: privateBucket,
          SAFETY_INPUT_URL_TTL: ttl,
        };
        return values[key] ?? fallback;
      }),
    } as never);

  let send: jest.SpyInstance;
  let prisma: {
    generation: { create: jest.Mock };
    generationInputImage: { createMany: jest.Mock };
  };
  let generationQueue: { add: jest.Mock };

  function build(uploads: UploadsService): GenerationsService {
    prisma = {
      generation: {
        create: jest.fn().mockResolvedValue({ id: GENERATION_ID }),
      },
      generationInputImage: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    generationQueue = { add: jest.fn().mockResolvedValue(undefined) };
    const credits = {
      hasFreeGeneration: jest.fn().mockResolvedValue(false),
      getBalance: jest
        .fn()
        .mockResolvedValue({ totalCreditsAvailable: 1_000_000 }),
      debit: jest.fn().mockResolvedValue(undefined),
      consumeFreeGeneration: jest.fn(),
    };
    const plans = { calculateGenerationCost: jest.fn().mockResolvedValue(100) };
    const models = {
      assertActiveBySlug: jest.fn().mockResolvedValue(undefined),
    };
    return new GenerationsService(
      prisma as never,
      credits as never,
      plans as never,
      uploads,
      models as never,
      {} as never,
      generationQueue as never,
      { add: jest.fn() } as never,
      {} as never,
      {} as never,
    );
  }

  const putInputs = () =>
    send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof PutObjectCommand)
      .map((command: PutObjectCommand) => command.input);

  const savedInputUrls = (): string[] =>
    prisma.generationInputImage.createMany.mock.calls.flatMap(
      ([arg]: [{ data: Array<{ url: string }> }]) =>
        arg.data.map((row) => row.url),
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const referenceDto = {
    prompt: 'mulher adulta caminhando na praia',
    resolution: Resolution.RES_720P,
    reference_images: [
      Buffer.from('foto-1').toString('base64'),
      Buffer.from('foto-2').toString('base64'),
    ],
    reference_images_mime_types: ['image/jpeg', 'image/png'],
  };

  it('referência (Veo kie): bucket privado, private no-store, banco e fila com a mesma URL assinada', async () => {
    const service = build(uploadsFor(PRIVATE_BUCKET, '3600'));

    await service.generateReferenceToVideoKie(USER_ID, referenceDto as never);

    const puts = putInputs();
    expect(puts).toHaveLength(2);
    for (const put of puts) {
      expect(put.Bucket).toBe(PRIVATE_BUCKET);
      expect(put.CacheControl).toBe(PRIVATE_INPUT_CACHE_CONTROL);
      expect(put.Key).toMatch(new RegExp(`^inputs/${GENERATION_ID}/`));
    }

    const urls = savedInputUrls();
    expect(urls).toHaveLength(2);
    urls.forEach((url, index) => {
      const signed = new URL(url);
      expect(signed.pathname).toBe(`/${PRIVATE_BUCKET}/${puts[index].Key}`);
      expect(signed.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.startsWith(CDN)).toBe(false);
    });

    const [jobName, jobData] = generationQueue.add.mock.calls[0];
    expect(jobName).toBe(GenerationJobName.REFERENCE_TO_VIDEO_KIE);
    expect(jobData.imageUrls).toEqual(urls);
  });

  it('referência sem S3_INPUT_PRIVATE_BUCKET: bucket público com cache curto e URL pública (como antes)', async () => {
    const service = build(uploadsFor(undefined));

    await service.generateReferenceToVideoKie(USER_ID, referenceDto as never);

    const puts = putInputs();
    expect(puts.map((put) => put.Bucket)).toEqual([
      PUBLIC_BUCKET,
      PUBLIC_BUCKET,
    ]);
    expect(
      puts.every((put) => put.CacheControl === 'public, max-age=86400'),
    ).toBe(true);
    expect(savedInputUrls()).toEqual(puts.map((put) => `${CDN}/${put.Key}`));
    expect(generationQueue.add.mock.calls[0][1].imageUrls).toEqual(
      savedInputUrls(),
    );
  });

  it('motion control: vídeo e foto no privado; o job leva as URLs assinadas gravadas no banco', async () => {
    const service = build(uploadsFor(PRIVATE_BUCKET));

    await service.generateMotionControl(USER_ID, {
      video: Buffer.from('video').toString('base64'),
      video_mime_type: 'video/quicktime',
      image: Buffer.from('foto').toString('base64'),
      image_mime_type: 'image/png',
    } as never);

    const puts = putInputs();
    expect(puts.map((put) => put.Bucket)).toEqual([
      PRIVATE_BUCKET,
      PRIVATE_BUCKET,
    ]);
    expect(puts.map((put) => String(put.Key).split('/').pop())).toEqual([
      'input_video.mov',
      'input_image.png',
    ]);

    const rows = prisma.generationInputImage.createMany.mock.calls[0][0].data;
    expect(rows.map((row: { role: GenerationImageRole }) => row.role)).toEqual([
      GenerationImageRole.REFERENCE,
      GenerationImageRole.REFERENCE,
    ]);
    const [videoUrl, imageUrl] = savedInputUrls();
    for (const url of [videoUrl, imageUrl]) {
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('7200');
      expect(
        new URL(url).pathname.startsWith(
          `/${PRIVATE_BUCKET}/inputs/${GENERATION_ID}/`,
        ),
      ).toBe(true);
    }

    const [jobName, jobData] = generationQueue.add.mock.calls[0];
    expect(jobName).toBe(GenerationJobName.MOTION_CONTROL);
    expect(jobData).toMatchObject({ videoUrl, imageUrl });
  });

  it('o outro gravador de entradas (uploadBase64Image, das rotas de imagem) também vai para o privado', async () => {
    const service = build(uploadsFor(PRIVATE_BUCKET));
    const url: string = await (
      service as unknown as {
        uploadBase64Image(
          base64: string,
          mime: string,
          id: string,
        ): Promise<string>;
      }
    ).uploadBase64Image(
      Buffer.from('foto').toString('base64'),
      'image/webp',
      GENERATION_ID,
    );

    const [put] = putInputs();
    expect(put.Bucket).toBe(PRIVATE_BUCKET);
    expect(put.CacheControl).toBe(PRIVATE_INPUT_CACHE_CONTROL);
    expect(String(put.Key).endsWith('/input.webp')).toBe(true);
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('7200');
  });
});
