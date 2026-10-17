import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as childProcess from 'child_process';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import { join } from 'path';
import * as sharp from 'sharp';
import { promisify } from 'util';
import { SafetyProviderUnavailableError } from '../types';
import {
  chooseFrames,
  probeDurationMs,
  SampledFrame,
  sampleFrames,
} from '../video-frames';

/**
 * Vídeos sintéticos gerados aqui pelo próprio ffmpeg (cores sólidas), nunca pessoa. Vermelho por 3 s e azul por
 * 3 s: o corte de cena fica em 3 s e a cor de cada quadro diz de onde ele veio.
 */

const run = promisify(execFile);
const SAMPLING = { maxFrames: 12, everySeconds: 2, sceneThreshold: 0.3 };

async function makeVideo(path: string, segments: string[]): Promise<void> {
  const inputs = segments.flatMap((segment) => [
    '-f',
    'lavfi',
    '-i',
    `color=c=${segment}:s=320x240:d=3:r=25`,
  ]);
  const filter =
    segments.map((_, index) => `[${index}:v]`).join('') +
    `concat=n=${segments.length}:v=1:a=0`;
  await run(ffmpegInstaller.path, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-c:v',
    'mpeg4',
    '-q:v',
    '5',
    path,
  ]);
}

async function colourOf(
  frame: SampledFrame,
): Promise<'red' | 'blue' | 'other'> {
  const [red, green, blue] = (await sharp(frame.jpeg).stats()).channels.map(
    (channel) => channel.mean,
  );
  if (red > 180 && green < 70 && blue < 70) return 'red';
  if (blue > 180 && red < 70 && green < 70) return 'blue';
  return 'other';
}

/** Falha do fornecedor. Pelo nome: o módulo carregado isolado tem a própria cópia da classe. */
async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).toBe(SafetyProviderUnavailableError.name);
  expect(error).toMatchObject({ provider: 'ffmpeg' });
  return (error as SafetyProviderUnavailableError).failure;
}

async function leftoverDirs(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir())).filter((name) =>
    name.startsWith('safety-frames-'),
  );
}

describe('video-frames · quadros do vídeo para a checagem', () => {
  let workDir: string;
  let redBlue: string;
  let singleColour: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(join(os.tmpdir(), 'video-frames-spec-'));
    redBlue = join(workDir, 'vermelho-azul.mp4');
    singleColour = join(workDir, 'verde.mp4');
    await makeVideo(redBlue, ['red', 'blue']);
    await makeVideo(singleColour, ['green', 'green']);
  }, 60_000);

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('1º quadro, 1 a cada 2 s, o corte de cena e o último quadro, em ordem de tempo', async () => {
    const before = await leftoverDirs();
    const frames = await sampleFrames({ path: redBlue }, SAMPLING);

    const times = frames.map((frame) => frame.position.timeMs ?? -1);
    expect(frames.map((frame) => frame.position.index)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(2000);
    // corte de cena em 3 s (o 1º quadro azul)
    expect(times[2]).toBeGreaterThanOrEqual(2960);
    expect(times[2]).toBeLessThanOrEqual(3040);
    expect(times[3]).toBe(4000);
    // último quadro (25 qps: 5,96 s)
    expect(times[4]).toBeGreaterThanOrEqual(5900);
    expect(times[4]).toBeLessThanOrEqual(6000);

    const colours = await Promise.all(frames.map(colourOf));
    expect(colours).toEqual(['red', 'red', 'blue', 'blue', 'blue']);
    for (const frame of frames) {
      expect((await sharp(frame.jpeg).metadata()).format).toBe('jpeg');
    }
    // a pasta temporária é apagada no fim
    expect(await leftoverDirs()).toEqual(before);
  }, 60_000);

  it('aceita o vídeo em memória (buffer + extensão)', async () => {
    const frames = await sampleFrames(
      { buffer: await fs.readFile(redBlue), extension: 'mp4' },
      SAMPLING,
    );
    expect(frames).toHaveLength(5);
  }, 60_000);

  it('com teto pequeno, a prioridade é 1º, último e o corte de cena', async () => {
    const frames = await sampleFrames(
      { path: redBlue },
      { ...SAMPLING, maxFrames: 3 },
    );
    const times = frames.map((frame) => frame.position.timeMs ?? -1);
    expect(frames).toHaveLength(3);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeGreaterThanOrEqual(2960);
    expect(times[1]).toBeLessThanOrEqual(3040);
    expect(times[2]).toBeGreaterThanOrEqual(5900);
  }, 60_000);

  it('vídeo sem corte de cena: só os regulares e o último', async () => {
    const frames = await sampleFrames({ path: singleColour }, SAMPLING);
    const times = frames.map((frame) => frame.position.timeMs ?? -1);
    expect(times.slice(0, 3)).toEqual([0, 2000, 4000]);
    expect(times[3]).toBeGreaterThanOrEqual(5900);
    expect(frames).toHaveLength(4);
  }, 60_000);

  it('duração pelo ffprobe', async () => {
    const duration = await probeDurationMs(redBlue);
    expect(duration).toBeGreaterThanOrEqual(5900);
    expect(duration).toBeLessThanOrEqual(6100);
  }, 30_000);

  it('arquivo que não é vídeo ou vazio: mídia inválida, sem sobrar pasta temporária', async () => {
    const before = await leftoverDirs();
    expect(
      await failureOf(
        sampleFrames(
          { buffer: Buffer.from('isto não é um vídeo'), extension: 'mp4' },
          SAMPLING,
        ),
      ),
    ).toBe('invalid_media');
    expect(
      await failureOf(
        sampleFrames({ buffer: Buffer.alloc(0), extension: 'mp4' }, SAMPLING),
      ),
    ).toBe('invalid_media');
    expect(await leftoverDirs()).toEqual(before);
  }, 60_000);

  it('só lê arquivo local: URL e playlist que aponta para outro arquivo são recusadas', async () => {
    expect(
      await failureOf(
        sampleFrames({ path: 'http://exemplo.invalid/video.mp4' }, SAMPLING),
      ),
    ).toBe('invalid_media');
    const playlist = join(workDir, 'lista.m3u8');
    await fs.writeFile(
      playlist,
      `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n${redBlue}\n#EXT-X-ENDLIST\n`,
    );
    expect(await failureOf(sampleFrames({ path: playlist }, SAMPLING))).toBe(
      'invalid_media',
    );
    const concatList = join(workDir, 'lista.txt');
    await fs.writeFile(concatList, `file '${redBlue}'\n`);
    expect(await failureOf(sampleFrames({ path: concatList }, SAMPLING))).toBe(
      'invalid_media',
    );
  }, 60_000);

  it('prazo vencido vira indisponível (timeout)', async () => {
    expect(
      await failureOf(
        sampleFrames({ path: redBlue }, { ...SAMPLING, timeoutMs: 1 }),
      ),
    ).toBe('timeout');
  }, 30_000);

  it('extensão estranha no buffer não vira nome de arquivo', async () => {
    const frames = await sampleFrames(
      { buffer: await fs.readFile(redBlue), extension: '../../x.mp4' },
      SAMPLING,
    );
    expect(frames.length).toBeGreaterThan(0);
  }, 60_000);
});

describe('video-frames · sem ffprobe e sem ffmpeg', () => {
  type VideoFramesModule = typeof import('../video-frames');
  let workDir: string;
  let redBlue: string;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(join(os.tmpdir(), 'video-frames-spec-'));
    redBlue = join(workDir, 'vermelho-azul.mp4');
    await makeVideo(redBlue, ['red', 'blue']);
  }, 60_000);

  afterAll(async () => {
    jest.dontMock('@ffprobe-installer/ffprobe');
    jest.dontMock('@ffmpeg-installer/ffmpeg');
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function loadWithout(options: {
    ffprobe?: boolean;
    ffmpeg?: boolean;
  }): VideoFramesModule {
    let loaded: VideoFramesModule | undefined;
    jest.isolateModules(() => {
      if (options.ffprobe === false) {
        // o pacote lança já no require em plataforma sem binário
        jest.doMock('@ffprobe-installer/ffprobe', () => {
          throw new Error('plataforma sem binário');
        });
      } else {
        jest.dontMock('@ffprobe-installer/ffprobe');
      }
      if (options.ffmpeg === false) {
        jest.doMock('@ffmpeg-installer/ffmpeg', () => ({
          path: join(workDir, 'ffmpeg-que-nao-existe'),
        }));
      } else {
        jest.dontMock('@ffmpeg-installer/ffmpeg');
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      loaded = require('../video-frames') as VideoFramesModule;
    });
    return loaded!;
  }

  const spyOnSpawn = () => jest.spyOn(childProcess, 'spawn');
  const binariesSpawned = (spawnSpy: ReturnType<typeof spyOnSpawn>) =>
    spawnSpy.mock.calls.map(([binary]) => binary.toLowerCase());

  it('com ffprobe, a duração vem dele', async () => {
    const spawnSpy = spyOnSpawn();
    try {
      const withProbe = loadWithout({});
      expect(await withProbe.probeDurationMs(redBlue)).toBeGreaterThan(5900);
      expect(
        binariesSpawned(spawnSpy).some((binary) => binary.includes('ffprobe')),
      ).toBe(true);
    } finally {
      spawnSpy.mockRestore();
    }
  }, 30_000);

  it('sem ffprobe, a duração sai do stderr do ffmpeg e a amostragem é a mesma', async () => {
    const spawnSpy = spyOnSpawn();
    try {
      const withoutProbe = loadWithout({ ffprobe: false });
      const duration = await withoutProbe.probeDurationMs(redBlue);
      expect(duration).toBeGreaterThanOrEqual(5900);
      expect(duration).toBeLessThanOrEqual(6100);
      const frames = await withoutProbe.sampleFrames(
        { path: redBlue },
        SAMPLING,
      );
      expect(frames).toHaveLength(5);
      expect(frames[4].position.timeMs).toBeGreaterThanOrEqual(5900);
      const binaries = binariesSpawned(spawnSpy);
      expect(binaries.length).toBeGreaterThan(0);
      expect(binaries.some((binary) => binary.includes('ffprobe'))).toBe(false);
    } finally {
      spawnSpy.mockRestore();
    }
  }, 60_000);

  it('sem o binário do ffmpeg: indisponível (não configurado)', async () => {
    const withoutFfmpeg = loadWithout({ ffprobe: false, ffmpeg: false });
    expect(
      await failureOf(withoutFfmpeg.sampleFrames({ path: redBlue }, SAMPLING)),
    ).toBe('not_configured');
    expect(await withoutFfmpeg.probeDurationMs(redBlue)).toBeNull();
  }, 30_000);
});

describe('chooseFrames', () => {
  const at = (timeMs: number) => ({ file: `f-${timeMs}`, timeMs });

  it('prioridade 1º, último, cortes e regulares; sem repetir instante; em ordem de tempo', () => {
    const chosen = chooseFrames(
      {
        first: at(0),
        last: at(9_960),
        cuts: [at(3_000), at(3_050), at(7_000)],
        regular: [at(2_000), at(4_000), at(6_000), at(8_000)],
      },
      5,
    );
    // o corte a 50 ms do outro é o mesmo instante; a vaga que sobra vai para o regular do meio
    expect(chosen.map((frame) => frame.timeMs)).toEqual([
      0, 3_000, 4_000, 7_000, 9_960,
    ]);
  });

  it('teto 1 = só o 1º quadro; teto alto = todos, sem duplicar', () => {
    const candidates = {
      first: at(0),
      last: at(4_000),
      cuts: [at(40)],
      regular: [at(2_000), at(4_000)],
    };
    expect(chooseFrames(candidates, 1).map((frame) => frame.timeMs)).toEqual([
      0,
    ]);
    expect(chooseFrames(candidates, 12).map((frame) => frame.timeMs)).toEqual([
      0, 2_000, 4_000,
    ]);
  });

  it('regulares que não cabem são espalhados no tempo', () => {
    const regular = Array.from({ length: 20 }, (_, index) =>
      at((index + 1) * 1_000),
    );
    const chosen = chooseFrames(
      { first: at(0), last: at(30_000), cuts: [], regular },
      5,
    );
    expect(chosen.map((frame) => frame.timeMs)).toEqual([
      0, 1_000, 11_000, 20_000, 30_000,
    ]);
  });
});
