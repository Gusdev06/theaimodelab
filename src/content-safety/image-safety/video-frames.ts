import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { VideoSamplingConfig } from './image-safety.config';
import {
  FramePosition,
  ProviderFailureKind,
  SafetyProviderUnavailableError,
} from './types';

/**
 * Quadros de um vídeo para a checagem (vídeo de entrada e resultado): sempre o 1º e o último quadro, um a cada
 * `everySeconds` e os cortes de cena (select='gt(scene,X)'), com teto de `maxFrames`. Quando não cabe tudo, a
 * prioridade é: 1º, último, cortes, regulares (espalhados no tempo); a lista sai em ordem de tempo.
 *
 * Segurança: só lê arquivo local (protocolo `file`) e só demuxers de vídeo comuns (playlist ou lista de concatenação
 * nunca abrem outro arquivo ou URL). Tudo numa pasta temporária própria, apagada no fim, com ou sem erro.
 *
 * Duração: ffprobe do @ffprobe-installer, carregado só quando preciso e dentro de try (o pacote lança já no require
 * em plataforma sem binário); sem ele, a duração sai do stderr do `ffmpeg -i`.
 */

export interface SampledFrame {
  jpeg: Buffer;
  /** index = ordem do quadro na amostra; timeMs = instante no vídeo original */
  position: FramePosition;
}

export type VideoSource =
  | { path: string }
  | { buffer: Buffer; extension: string };

/** Prazo padrão da amostragem inteira (todas as passadas do ffmpeg). */
export const VIDEO_SAMPLING_TIMEOUT_MS = 60_000;
/** Teto de quadros candidatos por passada (a escolha final respeita `maxFrames`). */
const MAX_CANDIDATES = 120;
/** Quadros a menos disto um do outro são o mesmo instante. */
const SAME_INSTANT_MS = 100;
/** Último quadro: a busca começa este tanto antes do fim (vídeo mais curto que isto é lido inteiro). */
const LAST_FRAME_WINDOW_SECONDS = 1.5;
const MAX_FRAME_SIDE = 1920;
const STDERR_TAIL_BYTES = 64 * 1024;
const PROTOCOL_WHITELIST = 'file';
const FORMAT_WHITELIST = 'mov,mp4,matroska,webm,avi,mpegts,flv,ogg,gif';
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/i;
const SHOWINFO_PTS = /pts_time:\s*(-?\d+(?:\.\d+)?)/;
const STDERR_DURATION = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

const INPUT_GUARD = [
  '-protocol_whitelist',
  PROTOCOL_WHITELIST,
  '-format_whitelist',
  FORMAT_WHITELIST,
];
const SCALE_FILTER = `scale='min(${MAX_FRAME_SIDE},iw)':'min(${MAX_FRAME_SIDE},ih)':force_original_aspect_ratio=decrease`;

function failure(kind: ProviderFailureKind): SafetyProviderUnavailableError {
  return new SafetyProviderUnavailableError('ffmpeg', kind);
}

/* ------------------------------------------------------------------ processos */

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderrTail: string;
}

class ProcessTimeoutError extends Error {
  constructor() {
    super('ffmpeg excedeu o prazo');
    this.name = 'ProcessTimeoutError';
  }
}

class ProcessSpawnError extends Error {
  constructor() {
    super('binário indisponível');
    this.name = 'ProcessSpawnError';
  }
}

/** Roda um binário sem shell, com prazo; `onStderrLine` lê o stderr linha a linha (só o fim fica guardado). */
function runProcess(
  binary: string,
  args: string[],
  timeoutMs: number,
  onStderrLine?: (line: string) => void,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) {
      reject(new ProcessTimeoutError());
      return;
    }
    let settled = false;
    let stdout = '';
    let stderrTail = '';
    let pending = '';
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new ProcessTimeoutError());
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < STDERR_TAIL_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
      if (!onStderrLine) return;
      pending += text;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? '';
      for (const line of lines) onStderrLine(line);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessSpawnError());
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onStderrLine && pending) onStderrLine(pending);
      resolve({ code, stdout, stderrTail });
    });
  });
}

/* ------------------------------------------------------------------ duração */

let ffprobePathCache: string | null | undefined;

/** Caminho do ffprobe do @ffprobe-installer; null quando o pacote não tem binário para esta plataforma. */
function resolveFfprobePath(): string | null {
  if (ffprobePathCache !== undefined) return ffprobePathCache;
  try {
    // carregado só aqui: o pacote lança já no require em plataforma sem binário
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const installer = require('@ffprobe-installer/ffprobe') as {
      path?: unknown;
    };
    ffprobePathCache =
      typeof installer.path === 'string' && installer.path
        ? installer.path
        : null;
  } catch {
    ffprobePathCache = null;
  }
  return ffprobePathCache;
}

function secondsToMs(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : null;
}

async function durationFromFfprobe(
  filePath: string,
  timeoutMs: number,
): Promise<number | null> {
  const ffprobe = resolveFfprobePath();
  if (!ffprobe) return null;
  try {
    const result = await runProcess(
      ffprobe,
      [
        '-v',
        'error',
        ...INPUT_GUARD,
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      timeoutMs,
    );
    if (result.code !== 0) return null;
    return secondsToMs(Number.parseFloat(result.stdout.trim()));
  } catch {
    return null;
  }
}

/** Reserva sem ffprobe: o `ffmpeg -i` sem saída termina com erro, mas o stderr traz "Duration: hh:mm:ss.cc". */
async function durationFromFfmpegStderr(
  filePath: string,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const result = await runProcess(
      ffmpegInstaller.path,
      ['-hide_banner', '-nostdin', ...INPUT_GUARD, '-i', filePath],
      timeoutMs,
    );
    const match = STDERR_DURATION.exec(result.stderrTail);
    if (!match) return null;
    const [, hours, minutes, seconds] = match;
    return secondsToMs(
      Number(hours) * 3600 + Number(minutes) * 60 + Number.parseFloat(seconds),
    );
  } catch {
    return null;
  }
}

/** Duração do vídeo em ms (ffprobe; sem ele, stderr do ffmpeg); null quando nenhum dos dois diz. */
export async function probeDurationMs(
  filePath: string,
  timeoutMs = 15_000,
): Promise<number | null> {
  const startedAt = Date.now();
  const fromProbe = await durationFromFfprobe(filePath, timeoutMs);
  if (fromProbe !== null) return fromProbe;
  return durationFromFfmpegStderr(
    filePath,
    timeoutMs - (Date.now() - startedAt),
  );
}

/* ------------------------------------------------------------------ passadas */

interface Candidate {
  file: string;
  timeMs: number;
}

/**
 * Roda uma passada que grava quadros `prefix-…jpg` e devolve cada arquivo com o instante lido do showinfo.
 * `singleFile` (passada do último quadro, `-update 1`): um arquivo só, com o instante do último quadro lido;
 * `offsetMs` soma a busca (`-ss`), porque o ffmpeg zera o relógio no ponto buscado.
 */
async function extractPass(
  dir: string,
  prefix: string,
  args: string[],
  timeoutMs: number,
  options: { singleFile?: boolean; offsetMs?: number } = {},
): Promise<Candidate[]> {
  const times: number[] = [];
  const result = await runProcess(
    ffmpegInstaller.path,
    args,
    timeoutMs,
    (line) => {
      if (!line.includes('showinfo')) return;
      const match = SHOWINFO_PTS.exec(line);
      if (match) times.push(Number.parseFloat(match[1]));
    },
  );
  if (result.code !== 0) throw failure('invalid_media');
  const files = (await fs.readdir(dir))
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.jpg'))
    .sort();
  const offsetMs = options.offsetMs ?? 0;
  const toMs = (seconds: number | undefined) =>
    Math.max(0, Math.round(offsetMs + (seconds ?? 0) * 1000));
  if (options.singleFile) {
    return files.length > 0
      ? [
          {
            file: path.join(dir, files[0]),
            timeMs: toMs(times[times.length - 1]),
          },
        ]
      : [];
  }
  return files.map((name, index) => ({
    file: path.join(dir, name),
    timeMs: toMs(times[index]),
  }));
}

function regularArgs(
  input: string,
  dir: string,
  everySeconds: number,
  frameCap: number,
): string[] {
  const select = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,${everySeconds})'`;
  return [
    '-hide_banner',
    '-nostdin',
    ...INPUT_GUARD,
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `${select},showinfo,${SCALE_FILTER}`,
    '-vsync',
    'vfr',
    '-frames:v',
    String(frameCap),
    '-q:v',
    '3',
    path.join(dir, 'regular-%04d.jpg'),
  ];
}

function sceneArgs(
  input: string,
  dir: string,
  threshold: number,
  frameCap: number,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    ...INPUT_GUARD,
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `select='gt(scene\\,${threshold})',showinfo,${SCALE_FILTER}`,
    '-vsync',
    'vfr',
    '-frames:v',
    String(frameCap),
    '-q:v',
    '3',
    path.join(dir, 'scene-%04d.jpg'),
  ];
}

/** Último quadro: `-update 1` regrava o mesmo arquivo a cada quadro; com a duração, só lê o fim. */
function lastFrameArgs(
  input: string,
  dir: string,
  seekSeconds: number,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    ...INPUT_GUARD,
    ...(seekSeconds > 0 ? ['-ss', seekSeconds.toFixed(3)] : []),
    '-i',
    input,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `showinfo,${SCALE_FILTER}`,
    '-vsync',
    'vfr',
    '-update',
    '1',
    '-q:v',
    '3',
    path.join(dir, 'last-0001.jpg'),
  ];
}

/** Escolhe `count` itens espalhados (inclui o 1º e o último da lista; com 1 vaga, o do meio). */
function spread<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return [...items];
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]];
  const picked: T[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(items[Math.round((i * (items.length - 1)) / (count - 1))]);
  }
  return picked;
}

/** Junta os candidatos pela prioridade (1º, último, cortes, regulares) até `maxFrames`, sem repetir instante. */
export function chooseFrames(
  candidates: {
    first: Candidate | null;
    last: Candidate | null;
    cuts: readonly Candidate[];
    regular: readonly Candidate[];
  },
  maxFrames: number,
): Candidate[] {
  const chosen: Candidate[] = [];
  const isNew = (candidate: Candidate) =>
    chosen.every(
      (other) => Math.abs(other.timeMs - candidate.timeMs) >= SAME_INSTANT_MS,
    );
  const take = (group: readonly Candidate[]) => {
    const fresh: Candidate[] = [];
    for (const candidate of group) {
      if (
        isNew(candidate) &&
        fresh.every(
          (f) => Math.abs(f.timeMs - candidate.timeMs) >= SAME_INSTANT_MS,
        )
      ) {
        fresh.push(candidate);
      }
    }
    chosen.push(...spread(fresh, maxFrames - chosen.length));
  };
  if (candidates.first) take([candidates.first]);
  if (candidates.last) take([candidates.last]);
  take(candidates.cuts);
  take(candidates.regular);
  return chosen.sort((a, b) => a.timeMs - b.timeMs);
}

/* ------------------------------------------------------------------ amostragem */

/**
 * Extrai os quadros do vídeo. Vídeo ilegível ou sem quadro = SafetyProviderUnavailableError('ffmpeg',
 * 'invalid_media'); prazo vencido = 'timeout'; binário ausente = 'not_configured'.
 */
export async function sampleFrames(
  source: VideoSource,
  options: VideoSamplingConfig & { timeoutMs?: number },
): Promise<SampledFrame[]> {
  const maxFrames = Math.max(1, Math.floor(options.maxFrames));
  const everySeconds = options.everySeconds > 0 ? options.everySeconds : 2;
  const sceneThreshold =
    options.sceneThreshold > 0 && options.sceneThreshold < 1
      ? options.sceneThreshold
      : 0.3;
  const timeoutMs =
    options.timeoutMs && options.timeoutMs > 0
      ? options.timeoutMs
      : VIDEO_SAMPLING_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => deadline - Date.now();

  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), `safety-frames-${randomUUID().slice(0, 8)}-`),
  );
  try {
    let input: string;
    if ('buffer' in source) {
      if (!Buffer.isBuffer(source.buffer) || source.buffer.length === 0) {
        throw failure('invalid_media');
      }
      const extension = SAFE_EXTENSION.test(source.extension)
        ? source.extension.toLowerCase()
        : 'bin';
      input = path.join(dir, `input.${extension}`);
      await fs.writeFile(input, source.buffer, { mode: 0o600 });
    } else {
      input = source.path;
    }

    const durationMs = await probeDurationMs(
      input,
      Math.min(15_000, remaining()),
    );
    if (remaining() <= 0) throw failure('timeout');

    // vídeo longo: o intervalo cresce para os candidatos regulares cobrirem o vídeo inteiro
    const every =
      durationMs !== null
        ? Math.max(everySeconds, durationMs / 1000 / MAX_CANDIDATES)
        : everySeconds;
    const sceneCap = Math.min(MAX_CANDIDATES, maxFrames * 4);
    const lastSeek =
      durationMs !== null
        ? Math.max(0, durationMs / 1000 - LAST_FRAME_WINDOW_SECONDS)
        : 0;

    const passes = await Promise.allSettled([
      extractPass(
        dir,
        'regular',
        regularArgs(input, dir, Number(every.toFixed(3)), MAX_CANDIDATES + 1),
        remaining(),
      ),
      extractPass(
        dir,
        'scene',
        sceneArgs(input, dir, sceneThreshold, sceneCap),
        remaining(),
      ),
      extractPass(
        dir,
        'last',
        lastFrameArgs(input, dir, lastSeek),
        remaining(),
        {
          singleFile: true,
          offsetMs: lastSeek * 1000,
        },
      ),
    ]);
    const rejected = passes.find(
      (pass): pass is PromiseRejectedResult => pass.status === 'rejected',
    );
    if (rejected) throw toSamplingFailure(rejected.reason);
    const [regular, cuts, lastPass] = passes.map((pass) =>
      pass.status === 'fulfilled' ? pass.value : [],
    );
    if (regular.length === 0) throw failure('invalid_media');

    const last = lastPass.length > 0 ? lastPass[lastPass.length - 1] : null;
    const chosen = chooseFrames(
      { first: regular[0], last, cuts, regular: regular.slice(1) },
      maxFrames,
    );
    const frames: SampledFrame[] = [];
    for (const [index, candidate] of chosen.entries()) {
      const jpeg = await fs.readFile(candidate.file);
      if (jpeg.length === 0) throw failure('invalid_media');
      frames.push({ jpeg, position: { index, timeMs: candidate.timeMs } });
    }
    if (frames.length === 0) throw failure('invalid_media');
    return frames;
  } catch (error) {
    throw toSamplingFailure(error);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function toSamplingFailure(error: unknown): SafetyProviderUnavailableError {
  if (error instanceof SafetyProviderUnavailableError) return error;
  if (error instanceof ProcessTimeoutError) return failure('timeout');
  if (error instanceof ProcessSpawnError) return failure('not_configured');
  return failure('invalid_media');
}
