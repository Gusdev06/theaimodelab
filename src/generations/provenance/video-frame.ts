import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/** Maior vídeo baixado para tirar os quadros. */
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const FFMPEG_TIMEOUT_MS = 60_000;

/**
 * Quantos quadros de cada ponta entram. O site tira "o 1º" e "o último" quadro a 0,06 s da borda
 * (lib/video-frame.ts, EDGE_OFFSET_S): conforme os quadros por segundo do vídeo, isso cai do 1º ao 4º quadro
 * (16 fps = o da borda; 24/30 fps = o segundo; 60 fps = o quarto).
 */
export const EDGE_FRAMES = 4;

/** Quadros das pontas de um vídeo, em JPEG. `index` 0, 1, 2… = desde o começo; −1, −2… = desde o fim. */
export interface EdgeFrame {
  index: number;
  jpeg: Buffer;
}

/** Lê o corpo aos pedaços e para no teto (resposta sem content-length não enche a memória). null = passou do teto. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function run(command: ffmpeg.FfmpegCommand): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      command.kill('SIGKILL');
      reject(new Error('ffmpeg: tempo esgotado'));
    }, FFMPEG_TIMEOUT_MS);
    timer.unref();
    command
      .on('end', () => {
        clearTimeout(timer);
        resolve();
      })
      .on('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      })
      .run();
  });
}

/**
 * Os primeiros e os últimos quadros do vídeo (até EDGE_FRAMES de cada ponta). Só https. Lista vazia = não deu
 * (download, formato, tempo). Nunca lança.
 */
export async function extractEdgeFrames(videoUrl: string): Promise<EdgeFrame[]> {
  if (!/^https:\/\//i.test(videoUrl)) return [];
  const dir = path.join(os.tmpdir(), `own-frame-${randomUUID()}`);
  try {
    const response = await fetch(videoUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) return [];
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_VIDEO_BYTES) return [];
    const video = await readCapped(response, MAX_VIDEO_BYTES);
    if (!video || video.length === 0) return [];

    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'input.mp4');
    fs.writeFileSync(input, video);

    // -vsync 0: um arquivo por quadro do vídeo, sem repetir nem descartar
    await run(
      ffmpeg(input)
        .outputOptions([`-frames:v ${EDGE_FRAMES}`, '-vsync 0', '-q:v 2'])
        .output(path.join(dir, 'first_%03d.jpg')),
    );
    // o último segundo inteiro; os últimos arquivos são os últimos quadros
    await run(
      ffmpeg(input)
        .inputOptions(['-sseof -1'])
        .outputOptions(['-vsync 0', '-q:v 2'])
        .output(path.join(dir, 'last_%04d.jpg')),
    );

    const files = fs.readdirSync(dir).sort();
    const first = files.filter((name) => name.startsWith('first_'));
    const last = files.filter((name) => name.startsWith('last_')).slice(-EDGE_FRAMES);
    const frames: EdgeFrame[] = first.map((name, position) => ({ index: position, jpeg: fs.readFileSync(path.join(dir, name)) }));
    last.forEach((name, position) => {
      frames.push({ index: position - last.length, jpeg: fs.readFileSync(path.join(dir, name)) });
    });
    return frames;
  } catch {
    return [];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Um quadro das pontas pelo índice (como em EdgeFrame.index). null = não deu. */
export async function extractVideoFrame(videoUrl: string, frameIndex: number): Promise<Buffer | null> {
  const frames = await extractEdgeFrames(videoUrl);
  return frames.find((frame) => frame.index === frameIndex)?.jpeg ?? null;
}
