import {
  DetectFacesCommand,
  DetectFacesCommandOutput,
  DetectLabelsCommand,
  DetectModerationLabelsCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as sharp from 'sharp';
import {
  ImageSafetyConfig,
  loadImageSafetyConfig,
} from '../image-safety.config';
import { toRekognitionJpeg } from '../normalize';
import {
  classifyRekognitionError,
  cropBlocks,
  dedupeFaces,
  needsCropPass,
  RekognitionClientFactory,
  RekognitionScanner,
  RekognitionSender,
  toFaceSignals,
  toLabelSignals,
  toModerationSignals,
} from '../rekognition.scanner';
import {
  FaceSignal,
  LabelSignal,
  NormalizedImage,
  SafetyProviderUnavailableError,
} from '../types';

/**
 * Respostas da AWS simuladas (fixtures JSON, idades e rótulos inventados) e imagem sintética de 4 quadrantes
 * coloridos. Nenhuma chamada de rede: o cliente é sempre o falso, menos no teste que só monta o cliente real.
 */

function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', name), 'utf8'),
  ) as T;
}

const FACES = fixture<DetectFacesCommandOutput>(
  'rekognition-detect-faces.json',
);
const LABELS = fixture<object>('rekognition-detect-labels.json');
const MODERATION = fixture<object>('rekognition-detect-moderation.json');
const PEOPLE_NO_FACE = fixture<object>(
  'rekognition-labels-people-no-face.json',
);
const NO_FACES = { FaceDetails: [] };
const NO_MODERATION = { ModerationLabels: [], ContentTypes: [] };

function config(env: Record<string, string> = {}): ImageSafetyConfig {
  return loadImageSafetyConfig((key) => env[key]).config;
}

type Command =
  | DetectFacesCommand
  | DetectLabelsCommand
  | DetectModerationLabelsCommand;
type Handler = (
  region: string,
  command: Command,
  abortSignal: AbortSignal | undefined,
) => Promise<unknown>;

interface FakeAws {
  factory: RekognitionClientFactory;
  calls: Array<{ region: string; command: Command }>;
  regions: string[];
}

function fakeAws(handler: Handler): FakeAws {
  const calls: FakeAws['calls'] = [];
  const regions: string[] = [];
  const factory: RekognitionClientFactory = (region) => {
    regions.push(region);
    const send = (
      command: Command,
      options?: { abortSignal?: AbortSignal },
    ) => {
      calls.push({ region, command });
      return handler(region, command, options?.abortSignal);
    };
    return { send } as unknown as RekognitionSender;
  };
  return { factory, calls, regions };
}

/** resposta das fixtures para a imagem inteira */
function fixtures(
  overrides: { faces?: unknown; labels?: unknown; moderation?: unknown } = {},
): Handler {
  return (_region, command) => {
    if (command instanceof DetectFacesCommand) {
      return Promise.resolve(overrides.faces ?? FACES);
    }
    if (command instanceof DetectLabelsCommand) {
      return Promise.resolve(overrides.labels ?? LABELS);
    }
    return Promise.resolve(overrides.moderation ?? MODERATION);
  };
}

function awsError(name: string, status?: number): Error {
  const error = new Error(`${name} simulado`) as Error & {
    $metadata?: { httpStatusCode: number };
  };
  error.name = name;
  if (status) error.$metadata = { httpStatusCode: status };
  return error;
}

/** espera até o cancelamento, como o SDK faz com o abortSignal */
function hangUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () => reject(awsError('AbortError'));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

type Quadrant = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** qual bloco da passada recortada chegou (pela cor média do recorte) */
async function quadrantOf(jpeg: Uint8Array): Promise<Quadrant> {
  const stats = await sharp(Buffer.from(jpeg)).stats();
  const [red, green, blue] = stats.channels.map((channel) => channel.mean);
  if (blue > 150) return 'bottom-left';
  if (green > 150 && red > 150) return 'bottom-right';
  if (green > 150) return 'top-right';
  return 'top-left';
}

function face(
  low: number,
  high: number,
  box: { Left: number; Top: number; Width: number; Height: number },
) {
  return {
    AgeRange: { Low: low, High: high },
    BoundingBox: box,
    Confidence: 99,
  };
}

describe('RekognitionScanner', () => {
  let image: NormalizedImage;

  beforeAll(async () => {
    // 1000×800: vermelho, verde / azul, amarelo
    const quadrants = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: '#ff0000' },
    })
      .composite([
        {
          input: {
            create: {
              width: 500,
              height: 400,
              channels: 3,
              background: '#00ff00',
            },
          },
          left: 500,
          top: 0,
        },
        {
          input: {
            create: {
              width: 500,
              height: 400,
              channels: 3,
              background: '#0000ff',
            },
          },
          left: 0,
          top: 400,
        },
        {
          input: {
            create: {
              width: 500,
              height: 400,
              channels: 3,
              background: '#ffff00',
            },
          },
          left: 500,
          top: 400,
        },
      ])
      .png()
      .toBuffer();
    [image] = await toRekognitionJpeg(quadrants, 'image/png');
  });

  const spyOnWarn = () =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  let warnSpy: ReturnType<typeof spyOnWarn>;

  beforeEach(() => {
    warnSpy = spyOnWarn();
  });

  afterEach(() => jest.restoreAllMocks());

  it('roda as 3 chamadas em paralelo com os bytes do JPEG e devolve os sinais', async () => {
    const aws = fakeAws(fixtures());
    const scanner = new RekognitionScanner(config(), aws.factory);
    const result = await scanner.detect(image);

    expect(scanner.name).toBe('rekognition');
    expect(aws.regions).toEqual(['sa-east-1']);
    expect(aws.calls).toHaveLength(3);
    const faces = aws.calls.find(
      (call) => call.command instanceof DetectFacesCommand,
    )!.command as DetectFacesCommand;
    const labels = aws.calls.find(
      (call) => call.command instanceof DetectLabelsCommand,
    )!.command as DetectLabelsCommand;
    const moderation = aws.calls.find(
      (call) => call.command instanceof DetectModerationLabelsCommand,
    )!.command as DetectModerationLabelsCommand;
    // só a idade é pedida do rosto
    expect(faces.input.Attributes).toEqual(['AGE_RANGE']);
    expect(faces.input.Image?.Bytes).toBe(image.jpeg);
    expect(labels.input.MinConfidence).toBe(50);
    expect(labels.input.Image?.Bytes).toBe(image.jpeg);
    expect(moderation.input.MinConfidence).toBe(50);
    expect(moderation.input.Image?.Bytes).toBe(image.jpeg);

    expect(result).toMatchObject({
      scanner: 'rekognition',
      region: 'sa-east-1',
      cropPassRan: false,
      illustrated: true,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.faces).toEqual([
      {
        ageLow: 29,
        ageHigh: 37,
        ageMid: 33,
        box: { left: 0.1, top: 0.15, width: 0.2, height: 0.25 },
        confidence: 99.8,
        fromCrop: false,
      },
      {
        ageLow: 24,
        ageHigh: 32,
        ageMid: 28,
        box: { left: 0.6, top: 0.2, width: 0.18, height: 0.22 },
        confidence: 98.1,
        fromCrop: false,
      },
    ]);
    expect(result.labels).toEqual([
      { name: 'Person', confidence: 99.2, instanceCount: 2 },
      { name: 'Chair', confidence: 88.3, instanceCount: 0 },
      { name: 'Furniture', confidence: 88.3, instanceCount: 0 },
    ]);
    expect(result.moderation).toEqual([
      { name: 'Alcohol', parent: null, confidence: 81.5, taxonomyLevel: 1 },
      {
        name: 'Alcoholic Beverages',
        parent: 'Alcohol',
        confidence: 81.5,
        taxonomyLevel: 2,
      },
    ]);
  });

  it('pessoa sem rosto: passada recortada nos 4 blocos ampliados, caixas remapeadas', async () => {
    const seen: Quadrant[] = [];
    const cropSizes: Array<[number, number]> = [];
    const aws = fakeAws(async (_region, command) => {
      if (!(command instanceof DetectFacesCommand)) {
        return command instanceof DetectLabelsCommand
          ? PEOPLE_NO_FACE
          : NO_MODERATION;
      }
      const bytes = command.input.Image!.Bytes!;
      if (bytes === image.jpeg) return NO_FACES;
      const metadata = await sharp(Buffer.from(bytes)).metadata();
      cropSizes.push([metadata.width, metadata.height]);
      const quadrant = await quadrantOf(bytes);
      seen.push(quadrant);
      if (quadrant === 'top-left') {
        return {
          FaceDetails: [
            face(27, 35, { Left: 0.5, Top: 0.5, Width: 0.1, Height: 0.1 }),
          ],
        };
      }
      if (quadrant === 'bottom-right') {
        return {
          FaceDetails: [
            face(30, 40, { Left: 0.5, Top: 0.5, Width: 0.1, Height: 0.1 }),
          ],
        };
      }
      return NO_FACES;
    });
    const result = await new RekognitionScanner(config(), aws.factory).detect(
      image,
    );

    expect(result.cropPassRan).toBe(true);
    expect(aws.calls).toHaveLength(3 + 4);
    expect(seen.sort()).toEqual([
      'bottom-left',
      'bottom-right',
      'top-left',
      'top-right',
    ]);
    // cada bloco (575×460) ampliado até 1920 no lado maior
    for (const [width, height] of cropSizes) {
      expect(Math.max(width, height)).toBe(1920);
    }
    for (const call of aws.calls) {
      if (call.command instanceof DetectFacesCommand) {
        expect(call.command.input.Attributes).toEqual(['AGE_RANGE']);
      }
    }
    const byLeft = [...result.faces].sort(
      (a, b) => (a.box?.left ?? 0) - (b.box?.left ?? 0),
    );
    expect(byLeft).toHaveLength(2);
    expect(byLeft.every((signal) => signal.fromCrop)).toBe(true);
    expect(byLeft[0].ageMid).toBe(31);
    expect(byLeft[0].box!.left).toBeCloseTo(0.2875, 6);
    expect(byLeft[0].box!.top).toBeCloseTo(0.2875, 6);
    expect(byLeft[0].box!.width).toBeCloseTo(0.0575, 6);
    expect(byLeft[1].ageMid).toBe(35);
    expect(byLeft[1].box!.left).toBeCloseTo(0.7125, 6);
    expect(byLeft[1].box!.top).toBeCloseTo(0.7125, 6);
  });

  it('rosto na sobreposição de dois blocos conta uma vez, com a estimativa mais jovem', async () => {
    // o mesmo rosto em (0,45; 0,10) da imagem inteira, visto pelo bloco de cima à esquerda e pelo de cima à direita
    const fullBox = { left: 0.45, top: 0.1, width: 0.1, height: 0.1 };
    const topRightBlock = cropBlocks(1000, 800)[1];
    const aws = fakeAws(async (_region, command) => {
      if (!(command instanceof DetectFacesCommand)) {
        return command instanceof DetectLabelsCommand
          ? PEOPLE_NO_FACE
          : NO_MODERATION;
      }
      const bytes = command.input.Image!.Bytes!;
      if (bytes === image.jpeg) return NO_FACES;
      const quadrant = await quadrantOf(bytes);
      if (quadrant === 'top-left') {
        return {
          FaceDetails: [
            face(30, 38, {
              Left: fullBox.left / 0.575,
              Top: fullBox.top / 0.575,
              Width: fullBox.width / 0.575,
              Height: fullBox.height / 0.575,
            }),
          ],
        };
      }
      if (quadrant === 'top-right') {
        return {
          FaceDetails: [
            face(25, 33, {
              Left: (fullBox.left - topRightBlock.left) / topRightBlock.width,
              Top: fullBox.top / topRightBlock.height,
              Width: fullBox.width / topRightBlock.width,
              Height: fullBox.height / topRightBlock.height,
            }),
          ],
        };
      }
      return NO_FACES;
    });
    const result = await new RekognitionScanner(config(), aws.factory).detect(
      image,
    );
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].ageMid).toBe(29);
    expect(result.faces[0].box!.left).toBeCloseTo(0.45, 6);
  });

  it('erro 5xx na região principal: refaz a rodada inteira na reserva', async () => {
    const aws = fakeAws(async (region, command) => {
      if (region === 'sa-east-1' && command instanceof DetectLabelsCommand) {
        throw awsError('InternalServerError', 500);
      }
      return fixtures()(region, command, undefined);
    });
    const result = await new RekognitionScanner(config(), aws.factory).detect(
      image,
    );
    expect(result.region).toBe('us-east-1');
    expect(aws.regions).toEqual(['sa-east-1', 'us-east-1']);
    expect(
      aws.calls.filter((call) => call.region === 'us-east-1'),
    ).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalledWith(
      'Rekognition em sa-east-1 falhou (server_error); tentando a região reserva',
    );
  });

  it('limite na principal e na reserva: indisponível (throttled) com a região da última tentativa', async () => {
    const aws = fakeAws(async (_region, command) => {
      if (command instanceof DetectFacesCommand) {
        throw awsError('ThrottlingException', 400);
      }
      return fixtures()(_region, command, undefined);
    });
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect(image),
    );
    expect(error).toBeInstanceOf(SafetyProviderUnavailableError);
    expect(error).toMatchObject({
      provider: 'rekognition',
      failure: 'throttled',
      region: 'us-east-1',
    });
  });

  it('timeout de uma chamada na principal: reserva; nas duas: indisponível (timeout)', async () => {
    const tuning = { callTimeoutMs: 40 };
    const firstHangs = fakeAws(async (region, command, signal) => {
      if (region === 'sa-east-1' && command instanceof DetectFacesCommand) {
        return hangUntilAborted(signal);
      }
      return fixtures()(region, command, signal);
    });
    const result = await new RekognitionScanner(
      config(),
      firstHangs.factory,
      tuning,
    ).detect(image);
    expect(result.region).toBe('us-east-1');

    const bothHang = fakeAws(async (_region, command, signal) =>
      command instanceof DetectModerationLabelsCommand
        ? hangUntilAborted(signal)
        : fixtures()(_region, command, signal),
    );
    const error = await caught(
      new RekognitionScanner(config(), bothHang.factory, tuning).detect(image),
    );
    expect(error).toMatchObject({
      provider: 'rekognition',
      failure: 'timeout',
      region: 'us-east-1',
    });
  });

  it('chamada que nunca responde nem ao cancelamento também vence pelo prazo', async () => {
    const aws = fakeAws(async (_region, command) =>
      command instanceof DetectLabelsCommand
        ? new Promise<never>(() => undefined)
        : fixtures()(_region, command, undefined),
    );
    const error = await caught(
      new RekognitionScanner(config(), aws.factory, {
        callTimeoutMs: 30,
      }).detect(image),
    );
    expect(error).toMatchObject({ failure: 'timeout' });
  });

  it('nunca devolve resultado parcial: 2 de 3 chamadas certas ainda é indisponível', async () => {
    const aws = fakeAws(async (_region, command) => {
      if (command instanceof DetectModerationLabelsCommand) {
        throw awsError('ServiceUnavailableException', 503);
      }
      return fixtures()(_region, command, undefined);
    });
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect(image),
    );
    expect(error).toMatchObject({ failure: 'server_error' });
  });

  it('a 1ª chamada que falha cancela as outras da mesma rodada', async () => {
    const aborted: string[] = [];
    const aws = fakeAws(async (region, command, signal) => {
      if (region !== 'sa-east-1') return fixtures()(region, command, signal);
      if (command instanceof DetectFacesCommand) {
        throw awsError('InternalServerError', 500);
      }
      return hangUntilAborted(signal).catch((error: unknown) => {
        aborted.push(command.constructor.name);
        throw error;
      });
    });
    const result = await new RekognitionScanner(config(), aws.factory).detect(
      image,
    );
    expect(result.region).toBe('us-east-1');
    expect(aborted.sort()).toEqual([
      'DetectLabelsCommand',
      'DetectModerationLabelsCommand',
    ]);
  });

  it('sem região reserva: falha direto com a região principal', async () => {
    const aws = fakeAws(() =>
      Promise.reject(awsError('InternalServerError', 500)),
    );
    const error = await caught(
      new RekognitionScanner(
        config({ AWS_REGION_SAFETY_FALLBACK: 'none' }),
        aws.factory,
      ).detect(image),
    );
    expect(error).toMatchObject({
      failure: 'server_error',
      region: 'sa-east-1',
    });
    expect(aws.regions).toEqual(['sa-east-1']);
  });

  it('imagem recusada pela AWS não tenta a reserva (mídia inválida)', async () => {
    const aws = fakeAws(() =>
      Promise.reject(awsError('InvalidImageFormatException', 400)),
    );
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect(image),
    );
    expect(error).toMatchObject({
      failure: 'invalid_media',
      region: 'sa-east-1',
    });
    expect(aws.regions).toEqual(['sa-east-1']);
  });

  it('credencial recusada nas duas regiões: indisponível (auth)', async () => {
    const aws = fakeAws(() =>
      Promise.reject(awsError('AccessDeniedException', 403)),
    );
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect(image),
    );
    expect(error).toMatchObject({ failure: 'auth', region: 'us-east-1' });
  });

  it('cancelamento de quem chamou encerra sem tentar a reserva', async () => {
    const controller = new AbortController();
    const aws = fakeAws(async (_region, _command, signal) => {
      setTimeout(() => controller.abort(), 5);
      return hangUntilAborted(signal);
    });
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect(image, {
        signal: controller.signal,
      }),
    );
    expect(error).toMatchObject({ failure: 'timeout', region: 'sa-east-1' });
    expect(aws.regions).toEqual(['sa-east-1']);
  });

  it('prazo total vence na principal: não sobra tempo para a reserva', async () => {
    const aws = fakeAws(async (_region, _command, signal) =>
      hangUntilAborted(signal),
    );
    const startedAt = Date.now();
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect(image, {
        timeoutMs: 60,
      }),
    );
    expect(error).toMatchObject({ failure: 'timeout' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(aws.regions).toEqual(['sa-east-1']);
  });

  it('resposta sem idade num rosto é inválida (o rosto não pode ser ignorado)', async () => {
    const aws = fakeAws(
      fixtures({
        faces: {
          FaceDetails: [
            {
              BoundingBox: { Left: 0, Top: 0, Width: 0.1, Height: 0.1 },
              Confidence: 99,
            },
          ],
        },
      }),
    );
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect(image),
    );
    expect(error).toMatchObject({ failure: 'invalid_response' });
  });

  it('imagem vazia não chama a AWS', async () => {
    const aws = fakeAws(fixtures());
    const error = await caught(
      new RekognitionScanner(config(), aws.factory).detect({
        ...image,
        jpeg: Buffer.alloc(0),
      }),
    );
    expect(error).toMatchObject({ failure: 'invalid_media' });
    expect(aws.calls).toHaveLength(0);
  });

  it('o cliente real é montado com a região, 2 tentativas e a credencial própria (sem rede)', async () => {
    const scanner = new RekognitionScanner(
      config({
        AWS_SAFETY_ACCESS_KEY_ID: 'AKIATESTEFALSO000000',
        AWS_SAFETY_SECRET_ACCESS_KEY: 'segredo-falso-de-teste',
      }),
    );
    const client = (
      scanner as unknown as { client(region: string): RekognitionClient }
    ).client('sa-east-1');
    expect(client).toBeInstanceOf(RekognitionClient);
    expect(await client.config.region()).toBe('sa-east-1');
    expect(await client.config.maxAttempts()).toBe(2);
    const credentials = await client.config.credentials();
    expect(credentials.accessKeyId).toBe('AKIATESTEFALSO000000');
    // o mesmo cliente é reaproveitado por região
    expect(
      (
        scanner as unknown as { client(region: string): RekognitionClient }
      ).client('sa-east-1'),
    ).toBe(client);
  });
});

describe('rekognition.scanner · funções puras', () => {
  const person = (confidence: number, instanceCount: number): LabelSignal => ({
    name: 'Person',
    confidence,
    instanceCount,
  });
  const someFace = (overrides: Partial<FaceSignal> = {}): FaceSignal => ({
    ageLow: 28,
    ageHigh: 36,
    ageMid: 32,
    box: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
    confidence: 99,
    fromCrop: false,
    ...overrides,
  });

  it('needsCropPass: pessoa ≥ 70 sem rosto ou com menos rostos que pessoas', () => {
    expect(needsCropPass([], [])).toBe(false);
    expect(needsCropPass([], [person(69.9, 1)])).toBe(false);
    expect(needsCropPass([], [person(70, 1)])).toBe(true);
    expect(needsCropPass([], [person(70, 0)])).toBe(true);
    expect(needsCropPass([someFace(), someFace()], [person(95, 3)])).toBe(true);
    expect(needsCropPass([someFace(), someFace()], [person(95, 2)])).toBe(
      false,
    );
    expect(
      needsCropPass(
        [someFace()],
        [person(95, 1), { name: 'Child', confidence: 88, instanceCount: 2 }],
      ),
    ).toBe(true);
    // rótulo que não indica pessoa (nem Girl/Boy) não dispara
    expect(
      needsCropPass([], [{ name: 'Girl', confidence: 99, instanceCount: 1 }]),
    ).toBe(false);
    expect(
      needsCropPass(
        [],
        [{ name: 'Toddler', confidence: 80, instanceCount: 0 }],
      ),
    ).toBe(true);
  });

  it('cropBlocks: 4 quadrantes com 15% de sobreposição cobrindo a imagem toda', () => {
    const blocks = cropBlocks(1000, 800);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ left: 0, top: 0, width: 0.575, height: 0.575 });
    expect(blocks[1]).toEqual({
      left: 0.425,
      top: 0,
      width: 0.575,
      height: 0.575,
    });
    expect(blocks[2]).toEqual({
      left: 0,
      top: 0.425,
      width: 0.575,
      height: 0.575,
    });
    expect(blocks[3]).toEqual({
      left: 0.425,
      top: 0.425,
      width: 0.575,
      height: 0.575,
    });
    for (const block of cropBlocks(1921, 1081, 0.15)) {
      expect(block.left + block.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(block.top + block.height).toBeLessThanOrEqual(1 + 1e-9);
    }
    // sobreposição entre vizinhos = 15% do lado (com arredondamento para pixel inteiro)
    const [left, right] = cropBlocks(1000, 800);
    expect(left.left + left.width - right.left).toBeCloseTo(0.15, 6);
  });

  it('dedupeFaces: IoU acima de 0,5 é o mesmo rosto (vale o mais jovem); abaixo, rosto novo', () => {
    const base = [someFace({ ageLow: 30, ageHigh: 38, ageMid: 34 })];
    const sameButYounger = someFace({
      ageLow: 22,
      ageHigh: 30,
      ageMid: 26,
      box: { left: 0.11, top: 0.11, width: 0.2, height: 0.2 },
      fromCrop: true,
    });
    const merged = dedupeFaces(base, [sameButYounger]);
    expect(merged).toHaveLength(1);
    expect(merged[0].ageMid).toBe(26);
    expect(merged[0].fromCrop).toBe(true);

    const sameButOlder = someFace({
      ageLow: 40,
      ageHigh: 50,
      ageMid: 45,
      box: { left: 0.11, top: 0.11, width: 0.2, height: 0.2 },
      fromCrop: true,
    });
    expect(dedupeFaces(base, [sameButOlder])[0].ageMid).toBe(34);

    // sobreposição de meia caixa (IoU 1/3): rostos diferentes
    const halfOverlap = someFace({
      box: { left: 0.2, top: 0.1, width: 0.2, height: 0.2 },
    });
    expect(dedupeFaces(base, [halfOverlap])).toHaveLength(2);
    // o corte é configurável
    expect(dedupeFaces(base, [halfOverlap], 0.3)).toHaveLength(1);
    const far = someFace({
      box: { left: 0.7, top: 0.7, width: 0.2, height: 0.2 },
    });
    expect(dedupeFaces(base, [far])).toHaveLength(2);
    // rosto sem caixa nunca é descartado
    expect(dedupeFaces(base, [someFace({ box: null })])).toHaveLength(2);
    // empate no ponto médio: vale o Low menor
    const tie = someFace({
      ageLow: 26,
      ageHigh: 42,
      ageMid: 34,
      box: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
    });
    expect(dedupeFaces(base, [tie])[0].ageLow).toBe(26);
  });

  it('toFaceSignals: ponto médio, caixa remapeada do recorte e resposta inválida', () => {
    const [signal] = toFaceSignals(
      {
        FaceDetails: [
          face(20, 27, { Left: 0.2, Top: 0.4, Width: 0.5, Height: 0.25 }),
        ],
      },
      { left: 0.425, top: 0.425, width: 0.575, height: 0.575 },
    );
    expect(signal.ageMid).toBe(23.5);
    expect(signal.fromCrop).toBe(true);
    expect(signal.box!.left).toBeCloseTo(0.425 + 0.2 * 0.575, 9);
    expect(signal.box!.top).toBeCloseTo(0.425 + 0.4 * 0.575, 9);
    expect(signal.box!.width).toBeCloseTo(0.5 * 0.575, 9);
    expect(signal.box!.height).toBeCloseTo(0.25 * 0.575, 9);

    expect(toFaceSignals({})).toEqual([]);
    expect(
      toFaceSignals({ FaceDetails: [{ AgeRange: { Low: 30, High: 34 } }] })[0]
        .box,
    ).toBeNull();
    expect(() =>
      toFaceSignals({ FaceDetails: [{ AgeRange: { Low: 40, High: 30 } }] }),
    ).toThrow(SafetyProviderUnavailableError);
  });

  it('toLabelSignals e toModerationSignals: nome obrigatório, nível 1 sem pai, desenhado a partir de 50', () => {
    expect(
      toLabelSignals({
        Labels: [{ Confidence: 99 }, { Name: 'Person', Confidence: 90 }],
      }),
    ).toEqual([{ name: 'Person', confidence: 90, instanceCount: 0 }]);

    const below = toModerationSignals({
      ModerationLabels: [{ Name: 'Alcohol', ParentName: '', Confidence: 70 }],
      ContentTypes: [{ Name: 'Illustrated', Confidence: 49.9 }],
    });
    expect(below.illustrated).toBe(false);
    expect(below.moderation).toEqual([
      { name: 'Alcohol', parent: null, confidence: 70, taxonomyLevel: 1 },
    ]);
    expect(
      toModerationSignals({
        ContentTypes: [{ Name: 'Illustrated', Confidence: 50 }],
      }).illustrated,
    ).toBe(true);
    expect(
      toModerationSignals({
        ContentTypes: [{ Name: 'Unknown', Confidence: 99 }],
      }).illustrated,
    ).toBe(false);
    expect(
      toModerationSignals({
        ModerationLabels: [
          {
            Name: 'Alcoholic Beverages',
            ParentName: 'Alcohol',
            Confidence: 70,
          },
        ],
      }).moderation[0].taxonomyLevel,
    ).toBe(2);
  });

  it('classifyRekognitionError: limite, credencial, mídia, prazo e o resto como erro do servidor', () => {
    expect(classifyRekognitionError(awsError('ThrottlingException'))).toBe(
      'throttled',
    );
    expect(
      classifyRekognitionError(
        awsError('ProvisionedThroughputExceededException'),
      ),
    ).toBe('throttled');
    expect(classifyRekognitionError(awsError('Qualquer', 429))).toBe(
      'throttled',
    );
    expect(classifyRekognitionError(awsError('AccessDeniedException'))).toBe(
      'auth',
    );
    expect(classifyRekognitionError(awsError('Qualquer', 403))).toBe('auth');
    expect(classifyRekognitionError(awsError('ImageTooLargeException'))).toBe(
      'invalid_media',
    );
    expect(classifyRekognitionError(awsError('AbortError'))).toBe('timeout');
    expect(classifyRekognitionError(awsError('TimeoutError'))).toBe('timeout');
    expect(
      classifyRekognitionError(
        Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
      ),
    ).toBe('timeout');
    expect(classifyRekognitionError(awsError('InternalServerError', 500))).toBe(
      'server_error',
    );
    expect(classifyRekognitionError(null)).toBe('server_error');
    expect(
      classifyRekognitionError(
        new SafetyProviderUnavailableError('rekognition', 'invalid_response'),
      ),
    ).toBe('invalid_response');
  });
});
