import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import {
  AI_PROVENANCE_LABEL,
  IPTC_TRAINED_ALGORITHMIC_MEDIA,
  embedAiProvenance,
  isAiProvenanceEnabled,
  isGeneratedOutputFolder,
} from '../../common/utils/ai-provenance';
import { UploadsService } from '../uploads.service';

/**
 * Marca invisível de IA (AI Act art. 50; TKT-333): com AI_PROVENANCE_METADATA=on a saída de geração sobe com XMP
 * (imagem) ou metadado (MP4); desligada, sobe byte a byte igual; arquivo que não dá para marcar nunca quebra a subida.
 */
describe('marca de IA nas saídas (AI_PROVENANCE_METADATA)', () => {
  const env = (flag: string | undefined) => ({
    get: jest.fn((key: string, fallback?: string) => {
      const values: Record<string, string | undefined> = {
        S3_ENDPOINT: 'https://s3.exemplo.com',
        S3_BUCKET_NAME: 'ai-generations',
        S3_PUBLIC_URL: 'https://cdn.exemplo.com',
        AI_PROVENANCE_METADATA: flag,
      };
      return values[key] ?? fallback;
    }),
  });
  const service = (flag: string | undefined) =>
    new UploadsService(env(flag) as never);

  let send: jest.SpyInstance;
  let warn: jest.SpyInstance;
  const uploadedBody = (): Buffer => {
    const command = send.mock.calls.at(-1)?.[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    return command.input.Body as Buffer;
  };

  const base = () =>
    sharp({
      create: {
        width: 48,
        height: 32,
        channels: 3,
        background: { r: 200, g: 90, b: 140 },
      },
    });
  const pixels = (buffer: Buffer) => sharp(buffer).raw().toBuffer();
  const xmpOf = async (buffer: Buffer) =>
    (await sharp(buffer).metadata()).xmp?.toString('utf8') ?? '';

  let jpeg: Buffer;
  let png: Buffer;
  let webpLossy: Buffer;
  let webpLossless: Buffer;
  let webpAlpha: Buffer;

  beforeAll(async () => {
    jpeg = await base().jpeg({ quality: 90 }).toBuffer();
    png = await base().png().toBuffer();
    webpLossy = await base().webp({ quality: 80 }).toBuffer();
    webpLossless = await base().webp({ lossless: true }).toBuffer();
    webpAlpha = await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 4,
        background: { r: 10, g: 20, b: 30, alpha: 0.5 },
      },
    })
      .webp({ quality: 80 })
      .toBuffer();
  });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(() => Promise.resolve({}) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a flag só liga com "on"', () => {
    expect(isAiProvenanceEnabled('on')).toBe(true);
    expect(isAiProvenanceEnabled(' ON ')).toBe(true);
    for (const value of [undefined, null, '', 'off', 'true', '1', 'yes']) {
      expect(isAiProvenanceEnabled(value)).toBe(false);
    }
  });

  it('só a pasta de saída de geração é marcada (foto enviada pela cliente fica como veio)', () => {
    expect(isGeneratedOutputFolder('generations/abc')).toBe(true);
    expect(isGeneratedOutputFolder('video-editor')).toBe(true);
    expect(isGeneratedOutputFolder('inputs/abc')).toBe(false);
    expect(isGeneratedOutputFolder('samples/abc')).toBe(false);
  });

  describe.each([
    ['JPEG', () => jpeg, 'image/jpeg'],
    ['PNG', () => png, 'image/png'],
    ['WebP com perda (VP8)', () => webpLossy, 'image/webp'],
    ['WebP sem perda (VP8L)', () => webpLossless, 'image/webp'],
    ['WebP com transparência (VP8X)', () => webpAlpha, 'image/webp'],
  ])('%s', (_name, input, mime) => {
    it('flag on: sobe com o XMP de IA e os mesmos pixels', async () => {
      const original = input();
      await service('on').uploadBuffer(
        original,
        'generations/g1',
        'output_0.img',
        mime,
      );
      const body = uploadedBody();

      expect(body.equals(original)).toBe(false);
      const xmp = await xmpOf(body);
      expect(xmp).toContain(
        `Iptc4xmpExt:DigitalSourceType="${IPTC_TRAINED_ALGORITHMIC_MEDIA}"`,
      );
      expect(xmp).toContain(AI_PROVENANCE_LABEL);
      expect((await pixels(body)).equals(await pixels(original))).toBe(true);
      const [before, after] = await Promise.all([
        sharp(original).metadata(),
        sharp(body).metadata(),
      ]);
      expect([after.width, after.height, after.hasAlpha]).toEqual([
        before.width,
        before.height,
        before.hasAlpha,
      ]);
    });

    it('flag off: sobe byte a byte igual', async () => {
      const original = input();
      await service(undefined).uploadBuffer(
        original,
        'generations/g1',
        'output_0.img',
        mime,
      );
      expect(uploadedBody().equals(original)).toBe(true);

      await service('off').uploadBuffer(
        original,
        'generations/g1',
        'output_0.img',
        mime,
      );
      expect(uploadedBody().equals(original)).toBe(true);
    });

    it('marcar de novo não duplica', () => {
      const once = embedAiProvenance(input());
      expect(once.outcome).toBe('marked');
      const twice = embedAiProvenance(once.buffer);
      expect(twice.outcome).toBe('already-marked');
      expect(twice.buffer.equals(once.buffer)).toBe(true);
    });
  });

  it('flag on, mas foto enviada (inputs/): sobe igual', async () => {
    await service('on').uploadBuffer(
      jpeg,
      'inputs/g1',
      'input.jpg',
      'image/jpeg',
    );
    expect(uploadedBody().equals(jpeg)).toBe(true);
  });

  it('flag on, uploadBufferPublic de saída também marca', async () => {
    await service('on').uploadBufferPublic(
      png,
      'generations/g1',
      'output_0.png',
      'image/png',
    );
    expect(await xmpOf(uploadedBody())).toContain(
      IPTC_TRAINED_ALGORITHMIC_MEDIA,
    );
  });

  it('XMP antigo do provedor sem a marca de IA é trocado pelo nosso (um pacote só)', async () => {
    const withOldXmp = await base()
      .withXmp(
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>',
      )
      .jpeg()
      .toBuffer();
    const result = embedAiProvenance(withOldXmp);
    expect(result.outcome).toBe('marked');
    expect(await xmpOf(result.buffer)).toContain(
      IPTC_TRAINED_ALGORITHMIC_MEDIA,
    );
    const header = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
    let count = 0;
    for (
      let i = result.buffer.indexOf(header);
      i >= 0;
      i = result.buffer.indexOf(header, i + 1)
    )
      count++;
    expect(count).toBe(1);
  });

  it('arquivo com manifesto C2PA do provedor fica como veio (não quebra a assinatura dele)', () => {
    // APP11 com caixa JUMBF "c2pa" logo depois do SOI
    const payload = Buffer.concat([
      Buffer.from('JP\0\0\0\0\0\0jumbc2pa', 'latin1'),
    ]);
    const app11 = Buffer.concat([
      Buffer.from([0xff, 0xeb, 0, payload.length + 2]),
      payload,
    ]);
    const signed = Buffer.concat([
      jpeg.subarray(0, 2),
      app11,
      jpeg.subarray(2),
    ]);
    const result = embedAiProvenance(signed);
    expect(result.outcome).toBe('has-c2pa');
    expect(result.buffer.equals(signed)).toBe(true);
  });

  it('buffer inválido não lança: sobe igual, com a flag ligada', async () => {
    const garbage = [
      Buffer.from('isto não é imagem nenhuma, só texto qualquer'),
      Buffer.alloc(0),
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),
        Buffer.from('truncado'),
      ]),
      Buffer.concat([
        png.subarray(0, 20),
        Buffer.from([0xff, 0xff, 0xff, 0xff]),
      ]),
      Buffer.concat([
        Buffer.from('RIFF\xff\xff\xff\xffWEBPVP8 ', 'latin1'),
        Buffer.alloc(8),
      ]),
    ];
    for (const bad of garbage) {
      expect(() => embedAiProvenance(bad)).not.toThrow();
      expect(embedAiProvenance(bad).buffer.equals(bad)).toBe(true);
      await expect(
        service('on').uploadBuffer(
          bad,
          'generations/g1',
          'output_0.png',
          'image/png',
        ),
      ).resolves.toContain('https://cdn.exemplo.com/generations/g1/');
      expect(uploadedBody().equals(bad)).toBe(true);
    }
    expect(() =>
      embedAiProvenance(undefined as unknown as Buffer),
    ).not.toThrow();
  });

  const hasFfmpeg = fs.existsSync(ffmpegInstaller.path);
  (hasFfmpeg ? describe : describe.skip)(
    'MP4 (ffmpeg que a subida já usa, -c copy)',
    () => {
      let mp4: Buffer;

      beforeAll(async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-prov-'));
        const out = path.join(dir, 'clip.mp4');
        ffmpeg.setFfmpegPath(ffmpegInstaller.path);
        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input('testsrc=duration=1:size=64x64:rate=10')
            .inputFormat('lavfi')
            .outputOptions('-pix_fmt', 'yuv420p', '-c:v', 'mpeg4')
            .output(out)
            .on('end', () => resolve())
            .on('error', (err: Error) => reject(err))
            .run();
        });
        mp4 = fs.readFileSync(out);
        fs.rmSync(dir, { recursive: true, force: true });
      }, 60_000);

      it('flag on: o MP4 sai com o comentário de IA', async () => {
        await service('on').uploadBuffer(
          mp4,
          'generations/g1',
          'output_0.mp4',
          'video/mp4',
        );
        const body = uploadedBody();
        expect(body.includes(AI_PROVENANCE_LABEL, 0, 'utf8')).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      }, 60_000);

      it('flag off: o MP4 sai sem o comentário (só o faststart de sempre)', async () => {
        await service(undefined).uploadBuffer(
          mp4,
          'generations/g1',
          'output_0.mp4',
          'video/mp4',
        );
        expect(uploadedBody().includes(AI_PROVENANCE_LABEL, 0, 'utf8')).toBe(
          false,
        );
      }, 60_000);

      it('MP4 inválido com a flag on não lança: sobe o original', async () => {
        const bad = Buffer.from('não é vídeo');
        await expect(
          service('on').uploadBuffer(
            bad,
            'generations/g1',
            'output_0.mp4',
            'video/mp4',
          ),
        ).resolves.toContain('https://cdn.exemplo.com/');
        expect(uploadedBody().equals(bad)).toBe(true);
      }, 60_000);
    },
  );
});
