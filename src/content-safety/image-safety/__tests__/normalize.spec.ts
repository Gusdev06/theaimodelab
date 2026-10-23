import { randomBytes } from 'crypto';
import * as sharp from 'sharp';
import {
  animationFrameIndexes,
  encodeRekognitionJpeg,
  REKOGNITION_MAX_BYTES,
  REKOGNITION_MAX_SIDE,
  REKOGNITION_MIN_SIDE,
  sha256Hex,
  toRekognitionJpeg,
} from '../normalize';
import { NormalizedImage, SafetyProviderUnavailableError } from '../types';

/**
 * Só imagens sintéticas (cores, formas, ruído), geradas aqui pelo sharp. Nenhuma foto de pessoa.
 */

function shapesSvg(width: number, height: number, background = '#2b6cb0') {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="${width}" height="${height}" fill="${background}"/>` +
      `<circle cx="${width * 0.3}" cy="${height * 0.4}" r="${Math.min(width, height) * 0.2}" fill="#f6e05e"/>` +
      `<rect x="${width * 0.55}" y="${height * 0.5}" width="${width * 0.3}" height="${height * 0.3}" fill="#e53e3e"/>` +
      `</svg>`,
  );
}

async function shapes(
  width: number,
  height: number,
  format: 'png' | 'jpeg' | 'webp' = 'png',
): Promise<Buffer> {
  const pipeline = sharp(shapesSvg(width, height));
  if (format === 'jpeg') return pipeline.jpeg({ quality: 90 }).toBuffer();
  if (format === 'webp') return pipeline.webp({ quality: 90 }).toBuffer();
  return pipeline.png().toBuffer();
}

async function solid(color: string, width = 120, height = 90) {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

async function expectRekognitionReady(image: NormalizedImage) {
  const metadata = await sharp(image.jpeg).metadata();
  expect(metadata.format).toBe('jpeg');
  expect(metadata.width).toBe(image.width);
  expect(metadata.height).toBe(image.height);
  expect(image.jpeg.length).toBeLessThan(REKOGNITION_MAX_BYTES);
  expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(
    REKOGNITION_MAX_SIDE,
  );
  expect(Math.min(image.width, image.height)).toBeGreaterThanOrEqual(
    REKOGNITION_MIN_SIDE,
  );
}

async function expectInvalidMedia(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SafetyProviderUnavailableError);
  expect(error).toMatchObject({
    provider: 'normalize',
    failure: 'invalid_media',
  });
}

/** média de cor de uma região (para conferir fundo branco e quadro certo) */
async function meanColour(jpeg: Buffer) {
  const stats = await sharp(jpeg).stats();
  return stats.channels.map((channel) => Math.round(channel.mean));
}

describe('normalize · preparo da imagem para o Rekognition', () => {
  it('PNG pequeno vira um JPEG do mesmo tamanho, sem ampliar', async () => {
    const input = await shapes(640, 480);
    const [image, ...rest] = await toRekognitionJpeg(input, 'image/png');
    expect(rest).toHaveLength(0);
    await expectRekognitionReady(image);
    expect([image.width, image.height]).toEqual([640, 480]);
    expect(image.sha256).toBe(sha256Hex(input));
    expect(image.sourceMimeType).toBe('image/png');
    expect(image.frame).toBeUndefined();
  });

  it('WebP vira JPEG e o tipo de origem sai do formato quando não vem', async () => {
    const input = await shapes(800, 600, 'webp');
    const [image] = await toRekognitionJpeg(input, null);
    await expectRekognitionReady(image);
    expect(image.sourceMimeType).toBe('image/webp');
  });

  it('4000×3000 reduz para 1920 no lado maior, mantendo a proporção', async () => {
    const input = await shapes(4000, 3000, 'jpeg');
    const [image] = await toRekognitionJpeg(input, 'image/jpeg');
    await expectRekognitionReady(image);
    expect([image.width, image.height]).toEqual([1920, 1440]);
  });

  it('50×50 amplia até 80 px', async () => {
    const input = await shapes(50, 50);
    const [image] = await toRekognitionJpeg(input, 'image/png');
    await expectRekognitionReady(image);
    expect([image.width, image.height]).toEqual([80, 80]);
  });

  it('faixa muito estreita ganha borda branca até 80 px sem passar de 1920', async () => {
    const input = await solid('#000000', 2400, 40);
    const [image] = await toRekognitionJpeg(input, 'image/png');
    await expectRekognitionReady(image);
    expect(image.width).toBe(1920);
    expect(image.height).toBe(80);
  });

  it('PNG de ruído acima de 5 MB vira JPEG abaixo de 5 MB', async () => {
    const width = 3000;
    const height = 2000;
    const input = await sharp(randomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();
    expect(input.length).toBeGreaterThan(REKOGNITION_MAX_BYTES);
    const [image] = await toRekognitionJpeg(input, 'image/png');
    await expectRekognitionReady(image);
  }, 60_000);

  it('a escada de qualidade entra quando o JPEG q85 não cabe no teto', async () => {
    const side = 640;
    const noise = randomBytes(side * side * 3);
    const raw = {
      data: noise,
      width: side,
      height: side,
      channels: 3 as const,
    };
    const first = await encodeRekognitionJpeg(raw);
    // o JPEG q85 de ruído não cabe num teto 1 byte menor: a escada desce até caber
    const smaller = await encodeRekognitionJpeg(raw, {
      maxBytes: first.jpeg.length,
    });
    expect(smaller.jpeg.length).toBeLessThan(first.jpeg.length);
    expect((await sharp(smaller.jpeg).metadata()).format).toBe('jpeg');
    // nenhum degrau cabe: mídia inválida (nunca manda arquivo acima do limite)
    await expectInvalidMedia(encodeRekognitionJpeg(raw, { maxBytes: 1_000 }));
    // teto acima do da AWS não sobe o limite
    const capped = await encodeRekognitionJpeg(raw, {
      maxBytes: REKOGNITION_MAX_BYTES * 10,
    });
    expect(capped.jpeg.length).toBe(first.jpeg.length);
  }, 60_000);

  it('transparência vira fundo branco', async () => {
    const input = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const [image] = await toRekognitionJpeg(input, 'image/png');
    const [red, green, blue] = await meanColour(image.jpeg);
    expect(Math.min(red, green, blue)).toBeGreaterThanOrEqual(250);
  });

  it('orienta pelo EXIF (foto de celular em pé)', async () => {
    const input = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#123456' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const [image] = await toRekognitionJpeg(input, 'image/jpeg');
    expect([image.width, image.height]).toEqual([100, 200]);
  });

  it('PNG de 16 bits e JPEG CMYK viram JPEG comum', async () => {
    const png16 = await sharp(shapesSvg(300, 200))
      .toColourspace('rgb16')
      .png()
      .toBuffer();
    expect((await sharp(png16).metadata()).depth).toBe('ushort');
    const cmyk = await sharp(shapesSvg(300, 200))
      .toColourspace('cmyk')
      .jpeg()
      .toBuffer();
    expect((await sharp(cmyk).metadata()).space).toBe('cmyk');

    for (const input of [png16, cmyk]) {
      const [image] = await toRekognitionJpeg(input, null);
      await expectRekognitionReady(image);
      const metadata = await sharp(image.jpeg).metadata();
      expect(metadata.space).toBe('srgb');
      expect(metadata.depth).toBe('uchar');
      expect([image.width, image.height]).toEqual([300, 200]);
    }
  });

  it('GIF animado de 5 quadros vira o 1º e 2 do meio, com a página de cada um', async () => {
    const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff'];
    const frames = await Promise.all(colours.map((colour) => solid(colour)));
    const gif = await sharp(frames, { join: { animated: true } })
      .gif({ delay: [100, 100, 100, 100, 100] })
      .toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(5);

    const images = await toRekognitionJpeg(gif, 'image/gif');
    expect(images.map((image) => image.frame?.index)).toEqual([0, 1, 3]);
    expect(images.map((image) => image.frame?.timeMs)).toEqual([0, 100, 300]);
    for (const image of images) {
      await expectRekognitionReady(image);
      expect(image.sha256).toBe(sha256Hex(gif));
    }
    // cada imagem é o quadro certo: vermelho, verde, amarelo
    const [first, second, third] = await Promise.all(
      images.map((image) => meanColour(image.jpeg)),
    );
    expect(first[0]).toBeGreaterThan(200);
    expect(first[1]).toBeLessThan(60);
    expect(second[1]).toBeGreaterThan(200);
    expect(second[0]).toBeLessThan(60);
    expect(third[0]).toBeGreaterThan(200);
    expect(third[1]).toBeGreaterThan(200);
    expect(third[2]).toBeLessThan(60);
  });

  it('WebP animado segue a mesma regra do GIF', async () => {
    const colours = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff'];
    const frames = await Promise.all(colours.map((colour) => solid(colour)));
    const webp = await sharp(frames, { join: { animated: true } })
      .webp({ delay: [80, 80, 80, 80, 80], lossless: true })
      .toBuffer();
    const images = await toRekognitionJpeg(webp, 'image/webp');
    expect(images.map((image) => image.frame?.index)).toEqual([0, 1, 3]);
    expect(images.map((image) => image.frame?.timeMs)).toEqual([0, 80, 240]);
    for (const image of images) await expectRekognitionReady(image);
    const [, second] = await Promise.all(
      images.map((image) => meanColour(image.jpeg)),
    );
    expect(second[1]).toBeGreaterThan(200);
  });

  it('escolhe os quadros da animação sem repetir', () => {
    expect(animationFrameIndexes(1)).toEqual([0]);
    expect(animationFrameIndexes(2)).toEqual([0, 1]);
    expect(animationFrameIndexes(3)).toEqual([0, 1, 2]);
    expect(animationFrameIndexes(5)).toEqual([0, 1, 3]);
    expect(animationFrameIndexes(30)).toEqual([0, 10, 20]);
    expect(animationFrameIndexes(0)).toEqual([0]);
    expect(animationFrameIndexes(Number.NaN)).toEqual([0]);
  });

  it('arquivo que não é imagem, vazio, SVG ou HEIC sem codec é recusado como mídia inválida', async () => {
    await expectInvalidMedia(
      toRekognitionJpeg(Buffer.from('isto não é uma imagem'), 'image/png'),
    );
    await expectInvalidMedia(toRekognitionJpeg(Buffer.alloc(0), 'image/png'));
    await expectInvalidMedia(
      toRekognitionJpeg(shapesSvg(100, 100), 'image/svg+xml'),
    );
    const fakeHeic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.alloc(64),
    ]);
    await expectInvalidMedia(toRekognitionJpeg(fakeHeic, 'image/heic'));
    // PNG truncado: o cabeçalho lê, a decodificação falha
    const truncated = (await shapes(400, 300)).subarray(0, 200);
    await expectInvalidMedia(toRekognitionJpeg(truncated, 'image/png'));
  });

  it('sha256Hex é o hash do arquivo original', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
