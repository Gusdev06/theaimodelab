import * as sharp from 'sharp';

/**
 * Hash perceptual de 64 bits da lista de bloqueio própria (regras E1 e S6). Pega a mesma foto recortada de leve,
 * recomprimida, redimensionada ou com filtro de brilho, pela distância de Hamming (corte em SAFETY_PHASH_MAX_DISTANCE).
 *
 * ALGORITMO CONGELADO: mudar qualquer passo invalida a lista de bloqueio inteira. Mudou = nome novo em
 * PHASH_ALGORITHM e recálculo da lista.
 *  1. sharp: orienta pelo EXIF, tira a transparência sobre fundo branco (o PNG transparente dá o mesmo hash do JPEG
 *     normalizado), tons de cinza, 32×32 sem manter proporção (lanczos3), 8 bits;
 *  2. DCT-II 2D ortonormal 32×32;
 *  3. bloco 8×8 de baixa frequência, linha a linha (linha = frequência vertical v, coluna = horizontal u);
 *  4. mediana dos 63 coeficientes sem o DC (o 32º em ordem crescente);
 *  5. bit = coeficiente > mediana, para os 64 (DC incluído), o 1º coeficiente no bit mais alto; 16 hex minúsculos.
 */
export const PHASH_ALGORITHM = 'dct32-8x8-median-v1';

const SIZE = 32;
const BLOCK = 8;
const PHASH_FORMAT = /^[0-9a-f]{16}$/;
const SHARP_TIMEOUT_SECONDS = 20;

/** cos((2x + 1) · k · π / 64), para k = 0..7 e x = 0..31 */
const COSINES: readonly Float64Array[] = Array.from(
  { length: BLOCK },
  (_, k) => {
    const row = new Float64Array(SIZE);
    for (let x = 0; x < SIZE; x++) {
      row[x] = Math.cos(((2 * x + 1) * k * Math.PI) / (2 * SIZE));
    }
    return row;
  },
);

/** fator da DCT ortonormal: √(1/N) para k = 0, √(2/N) no resto */
function alpha(k: number): number {
  return k === 0 ? Math.sqrt(1 / SIZE) : Math.sqrt(2 / SIZE);
}

const POPCOUNT_NIBBLE = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export function isValidPhash(value: unknown): value is string {
  return typeof value === 'string' && PHASH_FORMAT.test(value);
}

/**
 * Passos 2 a 5 sobre os 1024 tons de cinza (0 a 255, linha a linha) de uma imagem 32×32. Separado do sharp para o
 * algoritmo ser conferido com vetor fixo, sem depender da versão da biblioteca de imagem.
 */
export function phashFromGreyscale32(pixels: ArrayLike<number>): string {
  if (pixels.length !== SIZE * SIZE) {
    throw new Error(
      `pHash espera ${SIZE * SIZE} pixels, recebeu ${pixels.length}`,
    );
  }
  // DCT separável: primeiro nas colunas de cada linha (u), depois nas linhas (v)
  const rowsByU: Float64Array[] = Array.from(
    { length: BLOCK },
    () => new Float64Array(SIZE),
  );
  for (let y = 0; y < SIZE; y++) {
    for (let u = 0; u < BLOCK; u++) {
      const cos = COSINES[u];
      let sum = 0;
      for (let x = 0; x < SIZE; x++) sum += pixels[y * SIZE + x] * cos[x];
      rowsByU[u][y] = sum;
    }
  }
  const coefficients = new Float64Array(BLOCK * BLOCK);
  for (let v = 0; v < BLOCK; v++) {
    const cos = COSINES[v];
    for (let u = 0; u < BLOCK; u++) {
      const column = rowsByU[u];
      let sum = 0;
      for (let y = 0; y < SIZE; y++) sum += column[y] * cos[y];
      coefficients[v * BLOCK + u] = alpha(u) * alpha(v) * sum;
    }
  }

  const withoutDc = Array.from(coefficients.subarray(1)).sort((a, b) => a - b);
  const median = withoutDc[Math.floor(withoutDc.length / 2)];

  let hex = '';
  for (let nibbleStart = 0; nibbleStart < BLOCK * BLOCK; nibbleStart += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit++) {
      nibble =
        (nibble << 1) | (coefficients[nibbleStart + bit] > median ? 1 : 0);
    }
    hex += nibble.toString(16);
  }
  return hex;
}

/** pHash de uma imagem (qualquer formato que o sharp lê). Arquivo ilegível lança o erro do sharp. */
export async function perceptualHash(image: Buffer): Promise<string> {
  const pixels = await sharp(image)
    .timeout({ seconds: SHARP_TIMEOUT_SECONDS })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .greyscale()
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  if (pixels.length !== SIZE * SIZE) {
    throw new Error('pHash: saída inesperada do sharp');
  }
  return phashFromGreyscale32(pixels);
}

/** Distância de Hamming entre dois pHash (0 a 64). Hash fora do formato lança. */
export function hammingDistance(a: string, b: string): number {
  if (!isValidPhash(a) || !isValidPhash(b)) {
    throw new Error('pHash inválido (esperado 16 caracteres hexadecimais)');
  }
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    distance += POPCOUNT_NIBBLE[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return distance;
}
