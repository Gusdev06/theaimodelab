import { Injectable, Logger } from '@nestjs/common';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

export interface ClipInput {
  filePath: string;
  startMs: number;
  endMs?: number;
}

@Injectable()
export class FfmpegService {
  private readonly logger = new Logger(FfmpegService.name);

  async trimAndConcat(clips: ClipInput[], outputPath: string): Promise<void> {
    const tempDir = path.join('/tmp', `ffmpeg-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const trimmedFiles: string[] = [];

    try {
      // Step 1: Trim each clip if needed
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const needsTrim = clip.startMs > 0 || clip.endMs != null;

        if (!needsTrim) {
          trimmedFiles.push(clip.filePath);
          continue;
        }

        const trimmedPath = path.join(tempDir, `trimmed-${i}.mp4`);
        await this.trimClip(clip, trimmedPath);
        trimmedFiles.push(trimmedPath);
      }

      // Step 2: If single clip, just copy
      if (trimmedFiles.length === 1) {
        fs.copyFileSync(trimmedFiles[0], outputPath);
        return;
      }

      // Step 3: Concatenate all clips
      await this.concatClips(trimmedFiles, outputPath, tempDir);
    } finally {
      // Clean up temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        this.logger.warn(`Failed to clean up temp dir ${tempDir}: ${(e as Error).message}`);
      }
    }
  }

  async getVideoDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);
        const durationSec = metadata.format.duration ?? 0;
        resolve(Math.round(durationSec * 1000));
      });
    });
  }

  private trimClip(clip: ClipInput, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const startSec = clip.startMs / 1000;
      let cmd = ffmpeg(clip.filePath).setStartTime(startSec);

      if (clip.endMs != null) {
        const durationSec = (clip.endMs - clip.startMs) / 1000;
        cmd = cmd.setDuration(durationSec);
      }

      cmd
        .outputOptions(['-c', 'copy', '-avoid_negative_ts', 'make_zero'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => {
          this.logger.warn(`Trim with -c copy failed, re-encoding: ${err.message}`);
          // Fallback: re-encode
          this.trimClipReencode(clip, outputPath).then(resolve).catch(reject);
        })
        .run();
    });
  }

  private trimClipReencode(clip: ClipInput, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const startSec = clip.startMs / 1000;
      let cmd = ffmpeg(clip.filePath).setStartTime(startSec);

      if (clip.endMs != null) {
        const durationSec = (clip.endMs - clip.startMs) / 1000;
        cmd = cmd.setDuration(durationSec);
      }

      cmd
        .outputOptions(['-avoid_negative_ts', 'make_zero'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  }

  private concatClips(
    filePaths: string[],
    outputPath: string,
    tempDir: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Create concat file list
      const concatFilePath = path.join(tempDir, 'concat.txt');
      const concatContent = filePaths
        .map((fp) => `file '${fp}'`)
        .join('\n');
      fs.writeFileSync(concatFilePath, concatContent);

      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => {
          this.logger.warn(`Concat with -c copy failed, re-encoding: ${err.message}`);
          // Fallback: re-encode
          this.concatClipsReencode(filePaths, outputPath, tempDir)
            .then(resolve)
            .catch(reject);
        })
        .run();
    });
  }

  private concatClipsReencode(
    filePaths: string[],
    outputPath: string,
    tempDir: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const concatFilePath = path.join(tempDir, 'concat-reencode.txt');
      const concatContent = filePaths
        .map((fp) => `file '${fp}'`)
        .join('\n');
      fs.writeFileSync(concatFilePath, concatContent);

      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });
  }
}
