import * as sharp from 'sharp';
import {
  hammingDistance,
  isValidPhash,
  perceptualHash,
  PHASH_ALGORITHM,
  phashFromGreyscale32,
} from '../phash';

/**
 * Só imagens sintéticas (formas e cores) geradas aqui pelo sharp. O corte da lista de bloqueio é a distância 8
 * (SAFETY_PHASH_MAX_DISTANCE): a mesma imagem retocada fica abaixo, imagens diferentes ficam acima.
 */

const SAME_IMAGE_MAX_DISTANCE = 8;

/** composição A: círculo à esquerda, retângulo embaixo à direita, faixa diagonal */
function compositionA(width: number, height: number, opaque = true) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 400 300">` +
      (opaque ? '<rect width="400" height="300" fill="#1a365d"/>' : '') +
      '<circle cx="110" cy="120" r="70" fill="#f6e05e"/>' +
      '<rect x="230" y="160" width="130" height="110" fill="#e53e3e"/>' +
      '<polygon points="0,300 120,300 400,40 400,0 330,0" fill="#68d391" opacity="0.8"/>' +
      '</svg>',
  );
}

/** composição B: listras verticais e um quadrado no alto à direita */
function compositionB() {
  const stripes = Array.from(
    { length: 8 },
    (_, index) =>
      `<rect x="${index * 50}" y="0" width="25" height="300" fill="${index % 2 ? '#2f855a' : '#9f7aea'}"/>`,
  ).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">` +
      '<rect width="400" height="300" fill="#f7fafc"/>' +
      stripes +
      '<rect x="270" y="20" width="110" height="110" fill="#1a202c"/>' +
      '</svg>',
  );
}

/** composição C: gradiente de cima para baixo com um anel no centro */
function compositionC() {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">` +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
      '<rect width="400" height="300" fill="url(#g)"/>' +
      '<circle cx="200" cy="150" r="90" fill="none" stroke="#ed8936" stroke-width="40"/>' +
      '</svg>',
  );
}

describe('phash · hash perceptual da lista de bloqueio', () => {
  let original: Buffer;
  let originalHash: string;

  beforeAll(async () => {
    original = await sharp(compositionA(800, 600)).png().toBuffer();
    originalHash = await perceptualHash(original);
  });

  it('o nome do algoritmo é fixo (mudar invalida a lista de bloqueio)', () => {
    expect(PHASH_ALGORITHM).toBe('dct32-8x8-median-v1');
  });

  it('algoritmo congelado: vetores fixos dão sempre o mesmo hash', () => {
    const diagonal = Array.from(
      { length: 1024 },
      (_, index) => ((index % 32) * 7 + Math.floor(index / 32) * 13) % 256,
    );
    let seed = 12345;
    const pseudoRandom = Array.from({ length: 1024 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 256;
    });
    expect(phashFromGreyscale32(diagonal)).toBe('8d3585376ae22d5a');
    expect(phashFromGreyscale32(pseudoRandom)).toBe('db79766a1dc90b10');
    expect(phashFromGreyscale32(Uint8Array.from(diagonal))).toBe(
      '8d3585376ae22d5a',
    );
  });

  it('recusa vetor com tamanho errado', () => {
    expect(() => phashFromGreyscale32(new Uint8Array(1023))).toThrow();
  });

  it('devolve 16 caracteres hexadecimais minúsculos', () => {
    expect(originalHash).toMatch(/^[0-9a-f]{16}$/);
    expect(isValidPhash(originalHash)).toBe(true);
  });

  it('é estável: a mesma imagem dá o mesmo hash', async () => {
    expect(await perceptualHash(original)).toBe(originalHash);
    expect(hammingDistance(originalHash, originalHash)).toBe(0);
  });

  it('a mesma imagem recomprimida, redimensionada ou com brilho levemente diferente fica no corte', async () => {
    const variants = await Promise.all([
      sharp(original).jpeg({ quality: 35 }).toBuffer(),
      sharp(original).webp({ quality: 40 }).toBuffer(),
      sharp(original).resize(320, 240).png().toBuffer(),
      sharp(original).resize(1600, 1200).jpeg({ quality: 80 }).toBuffer(),
      sharp(original).modulate({ brightness: 1.1 }).png().toBuffer(),
      sharp(original).modulate({ brightness: 0.92 }).jpeg().toBuffer(),
      sharp(compositionA(800, 600)).flatten().greyscale().png().toBuffer(),
    ]);
    for (const variant of variants) {
      const distance = hammingDistance(
        originalHash,
        await perceptualHash(variant),
      );
      expect(distance).toBeLessThanOrEqual(SAME_IMAGE_MAX_DISTANCE);
    }
  });

  it('foto girada com orientação EXIF dá o hash da foto em pé', async () => {
    // pixels deitados + EXIF 6 ("girar 90° no sentido horário para exibir") = a mesma imagem em pé
    const sideways = await sharp(original)
      .rotate(-90)
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect(
      hammingDistance(originalHash, await perceptualHash(sideways)),
    ).toBeLessThanOrEqual(SAME_IMAGE_MAX_DISTANCE);
  });

  it('transparência é lida sobre fundo branco (PNG transparente ≈ JPEG achatado)', async () => {
    const transparent = await sharp(compositionA(800, 600, false))
      .png()
      .toBuffer();
    const flattened = await sharp(transparent)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer();
    expect((await sharp(transparent).metadata()).hasAlpha).toBe(true);
    expect(
      hammingDistance(
        await perceptualHash(transparent),
        await perceptualHash(flattened),
      ),
    ).toBeLessThanOrEqual(2);
  });

  it('imagens diferentes ficam longe do corte', async () => {
    const hashes = await Promise.all(
      [
        original,
        await sharp(compositionB()).png().toBuffer(),
        await sharp(compositionC()).png().toBuffer(),
        await sharp(original).flop().png().toBuffer(),
      ].map((image) => perceptualHash(image)),
    );
    for (let a = 0; a < hashes.length; a++) {
      for (let b = a + 1; b < hashes.length; b++) {
        expect(hammingDistance(hashes[a], hashes[b])).toBeGreaterThan(
          SAME_IMAGE_MAX_DISTANCE,
        );
      }
    }
  });

  it('distância de Hamming: simétrica, 0 consigo e contagem exata de bits', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1);
    expect(hammingDistance('f0f0f0f0f0f0f0f0', '0f0f0f0f0f0f0f0f')).toBe(64);
    expect(hammingDistance('8d3585376ae22d5a', 'db79766a1dc90b10')).toBe(
      hammingDistance('db79766a1dc90b10', '8d3585376ae22d5a'),
    );
  });

  it('hash fora do formato lança', () => {
    expect(() => hammingDistance('abc', '0000000000000000')).toThrow();
    expect(() =>
      hammingDistance('ABCDEF0123456789', '0000000000000000'),
    ).toThrow();
    expect(() =>
      hammingDistance('000000000000000g', '0000000000000000'),
    ).toThrow();
    expect(isValidPhash(null)).toBe(false);
    expect(isValidPhash(123)).toBe(false);
    expect(isValidPhash('0123456789abcdef0')).toBe(false);
  });

  it('arquivo que não é imagem lança', async () => {
    await expect(perceptualHash(Buffer.from('não é imagem'))).rejects.toThrow();
  });
});
