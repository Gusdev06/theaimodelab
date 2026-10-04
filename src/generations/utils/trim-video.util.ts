import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Corta o vídeo nos primeiros `seconds` segundos sem reencodar (stream copy),
 * mantendo o container de origem. Usado no Motion Control: o Kling recusa
 * vídeo acima de 30s com "Video duration must be between 3 and 30 seconds".
 */
export async function trimVideoBuffer(
  buffer: Buffer,
  ext: string,
  seconds: number,
): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trim-${randomUUID()}-`));
  const input = path.join(dir, `in.${ext}`);
  const output = path.join(dir, `out.${ext}`);
  try {
    fs.writeFileSync(input, buffer);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(input)
        .outputOptions(['-t', String(seconds), '-c', 'copy', '-movflags', '+faststart'])
        .output(output)
        .on('end', () => resolve())
        .on('error', reject)
        .run();
    });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
