import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import * as sharp from 'sharp';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as fs from 'fs';
import * as path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
import { PresignedUrlDto } from './dto/presigned-url.dto';
import { PresignedUrlResponseDto } from './dto/presigned-url-response.dto';

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);
  private readonly s3Client: S3Client | null;
  private readonly bucketName: string;
  private readonly publicUrlBase: string;

  constructor(private readonly configService: ConfigService) {
    const endpoint = this.configService.get<string>('S3_ENDPOINT');
    this.bucketName = this.configService.get<string>(
      'S3_BUCKET_NAME',
      'ai-generations',
    );
    this.publicUrlBase = (
      this.configService.get<string>('S3_PUBLIC_URL', '') || ''
    ).replace(/\/$/, '');

    if (endpoint) {
      this.s3Client = new S3Client({
        endpoint,
        region: this.configService.get<string>('S3_REGION', 'us-east-1'),
        credentials: {
          accessKeyId: this.configService.get<string>('S3_ACCESS_KEY', ''),
          secretAccessKey: this.configService.get<string>(
            'S3_SECRET_KEY',
            '',
          ),
        },
        forcePathStyle: true,
      });
      this.logger.log('S3 client configured');
    } else {
      this.s3Client = null;
      this.logger.warn('S3_ENDPOINT not configured — using mock URLs');
    }
  }

  /**
   * Returns a permanent public URL for an S3 object.
   * Requires S3_PUBLIC_URL to be configured.
   */
  getPublicUrl(fileKey: string): string {
    if (!this.publicUrlBase) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }
    return `${this.publicUrlBase}/${fileKey}`;
  }

  async generatePresignedUrl(
    dto: PresignedUrlDto,
  ): Promise<PresignedUrlResponseDto> {
    const sanitizedFilename = dto.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileKey = `${dto.purpose}/${randomUUID()}/${sanitizedFilename}`;

    if (!this.s3Client) {
      return {
        uploadUrl: `https://mock-s3.local/${this.bucketName}/${fileKey}?X-Amz-Expires=900`,
        fileKey,
      };
    }

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: fileKey,
      ContentType: dto.contentType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 900, // 15 minutes
    });

    return { uploadUrl, fileKey };
  }

  /**
   * Downloads a file from a URL and uploads it to S3.
   * Returns a public URL to access the file.
   */
  async uploadFromUrl(
    sourceUrl: string,
    folder: string,
    filename: string,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      this.logger.warn('S3 not configured — returning source URL as-is');
      return sourceUrl;
    }

    // Download
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download file from ${sourceUrl}: ${response.status}`,
      );
    }

    let buffer: Buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'image/png';

    // For MP4 videos, move moov atom to the beginning for streaming playback
    if (contentType === 'video/mp4') {
      buffer = await this.applyFaststart(buffer);
    }

    // Upload to S3
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: buffer,
        ContentType: contentType,
        ContentLength: buffer.length,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    this.logger.log(`Uploaded ${fileKey} (${buffer.length} bytes)`);

    // Return signed URL for reading
    return this.getPublicUrl(fileKey);
  }

  /**
   * Uploads raw buffer to S3 and returns a public URL.
   */
  async uploadBuffer(
    buffer: Buffer,
    folder: string,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    // For MP4 videos, move moov atom to the beginning for streaming playback
    let finalBuffer = buffer;
    if (contentType === 'video/mp4') {
      finalBuffer = await this.applyFaststart(buffer);
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: finalBuffer,
        ContentType: contentType,
        ContentLength: finalBuffer.length,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    this.logger.log(`Uploaded ${fileKey} (${finalBuffer.length} bytes)`);
    return this.getPublicUrl(fileKey);
  }

  /**
   * Re-muxes an MP4 buffer with -movflags +faststart so the moov atom
   * is at the beginning of the file, enabling streaming playback.
   */
  /**
   * Transcodes any input audio buffer to MP3 (mono, 96kbps, 24kHz).
   * Used to normalize browser-recorded webm/ogg/m4a samples before sending
   * to providers that only accept mp3/wav (e.g. WaveSpeed OmniVoice).
   */
  async transcodeAudioToMp3(buffer: Buffer): Promise<Buffer> {
    const tempDir = path.join('/tmp', `audio-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const inputPath = path.join(tempDir, 'input');
    const outputPath = path.join(tempDir, 'output.mp3');

    try {
      fs.writeFileSync(inputPath, buffer);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .audioCodec('libmp3lame')
          .audioChannels(1)
          .audioBitrate('96k')
          .audioFrequency(24000)
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      const result = fs.readFileSync(outputPath);
      this.logger.log(
        `Audio transcoded to mp3: ${buffer.length} → ${result.length} bytes`,
      );
      return result;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private async applyFaststart(buffer: Buffer): Promise<Buffer> {
    const tempDir = path.join('/tmp', `faststart-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const inputPath = path.join(tempDir, 'input.mp4');
    const outputPath = path.join(tempDir, 'output.mp4');

    try {
      fs.writeFileSync(inputPath, buffer);

      await new Promise<void>((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions('-c', 'copy', '-movflags', '+faststart')
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      const result = fs.readFileSync(outputPath);
      this.logger.log(
        `Faststart applied: ${buffer.length} → ${result.length} bytes`,
      );
      return result;
    } catch (error) {
      this.logger.warn(
        `Failed to apply faststart, uploading original: ${(error as Error).message}`,
      );
      return buffer;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Generates a thumbnail from an image URL, uploads it to S3 and returns its public URL.
   */
  async generateThumbnail(
    sourceUrl: string,
    folder: string,
    filename: string,
    width = 256,
    height?: number,
    preserveAspect = false,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      // preserveAspect: encaixa dentro da caixa width×height mantendo a proporção
      // original (sem recorte) — usado na galeria para respeitar 9:16, 16:9 etc.
      const thumbnail = await sharp(buffer)
        .resize(width, height ?? width, {
          fit: preserveAspect ? 'inside' : 'cover',
          withoutEnlargement: preserveAspect,
        })
        .webp({ quality: 70 })
        .toBuffer();

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: fileKey,
          Body: thumbnail,
          ContentType: 'image/webp',
        }),
      );

      this.logger.log(`Thumbnail uploaded ${fileKey} (${thumbnail.length} bytes)`);
      return this.getPublicUrl(fileKey);
    } catch (error) {
      this.logger.warn(`Failed to generate thumbnail: ${(error as Error).message}`);
      return sourceUrl;
    }
  }

  /**
   * Same as generateThumbnail but throws on failure instead of returning sourceUrl.
   */
  async generateThumbnailDirect(
    sourceUrl: string,
    folder: string,
    filename: string,
    width = 256,
    height?: number,
    preserveAspect = false,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const thumbnail = await sharp(buffer)
      .resize(width, height ?? width, {
        fit: preserveAspect ? 'inside' : 'cover',
        withoutEnlargement: preserveAspect,
      })
      .webp({ quality: 70 })
      .toBuffer();

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: thumbnail,
        ContentType: 'image/webp',
      }),
    );

    this.logger.log(`Thumbnail uploaded ${fileKey} (${thumbnail.length} bytes)`);
    return this.getPublicUrl(fileKey);
  }

  /**
   * Generates a thumbnail from a video URL by extracting the first frame with ffmpeg.
   * Downloads video → extracts frame at 0s → resizes with sharp → uploads to S3.
   */
  async generateVideoThumbnail(
    videoUrl: string,
    folder: string,
    filename: string,
    size = 256,
  ): Promise<string> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    const tempDir = path.join('/tmp', `vidthumb-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const videoPath = path.join(tempDir, 'input.mp4');
    const framePath = path.join(tempDir, 'frame.jpg');

    try {
      // Download video to temp file first (more reliable than streaming from URL)
      const response = await fetch(videoUrl);
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }
      const videoBuffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(videoPath, videoBuffer);

      // Extract first frame from local file
      await new Promise<void>((resolve, reject) => {
        ffmpeg(videoPath)
          .seekInput(0)
          .frames(1)
          .output(framePath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      // Resize with sharp and upload
      const frameBuffer = fs.readFileSync(framePath);
      const thumbnail = await sharp(frameBuffer)
        .resize(size, size, { fit: 'cover' })
        .webp({ quality: 70 })
        .toBuffer();

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: fileKey,
          Body: thumbnail,
          ContentType: 'image/webp',
        }),
      );

      this.logger.log(`Video thumbnail uploaded ${fileKey} (${thumbnail.length} bytes)`);
      return this.getPublicUrl(fileKey);
    } catch (error) {
      this.logger.warn(`Failed to generate video thumbnail: ${(error as Error).message}`);
      throw error;
    } finally {
      // Cleanup temp files
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  /**
   * Uploads raw buffer to S3 and returns both a public URL (for external APIs)
   * and a signed URL (for internal use / display).
   * With public bucket, both URLs are the same permanent public URL.
   */
  async uploadBufferPublic(
    buffer: Buffer,
    folder: string,
    filename: string,
    contentType: string,
  ): Promise<{ publicUrl: string; signedUrl: string }> {
    const fileKey = `${folder}/${randomUUID()}/${filename}`;

    if (!this.s3Client) {
      const mockUrl = `https://mock-s3.local/${this.bucketName}/${fileKey}`;
      return { publicUrl: mockUrl, signedUrl: mockUrl };
    }

    // For MP4 videos, move moov atom to the beginning for streaming playback
    let finalBuffer = buffer;
    if (contentType === 'video/mp4') {
      finalBuffer = await this.applyFaststart(buffer);
    }

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: fileKey,
        Body: finalBuffer,
        ContentType: contentType,
        ContentLength: finalBuffer.length,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );

    this.logger.log(`Uploaded (public) ${fileKey} (${finalBuffer.length} bytes)`);

    const publicUrl = this.getPublicUrl(fileKey);
    return { publicUrl, signedUrl: publicUrl };
  }

  /**
   * Generates a signed read URL for an S3 object.
   * Only used by backfill scripts to re-sign expired URLs from old data.
   */
  async getSignedReadUrl(fileKey: string): Promise<string> {
    if (!this.s3Client) {
      return `https://mock-s3.local/${this.bucketName}/${fileKey}`;
    }

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: fileKey,
    });

    return getSignedUrl(this.s3Client, command, {
      expiresIn: 7 * 24 * 60 * 60,
    });
  }

  /**
   * Deletes all S3 objects under a given prefix (folder).
   * E.g., deleteByPrefix('inputs/abc123/') removes all files in that folder.
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    if (!this.s3Client) {
      this.logger.warn('S3 not configured — skipping deleteByPrefix');
      return 0;
    }

    let totalDeleted = 0;
    let continuationToken: string | undefined;

    do {
      const listResult = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      const objects = listResult.Contents;
      if (!objects?.length) break;

      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
        }),
      );

      totalDeleted += objects.length;
      continuationToken = listResult.IsTruncated
        ? listResult.NextContinuationToken
        : undefined;
    } while (continuationToken);

    if (totalDeleted > 0) {
      this.logger.log(`Deleted ${totalDeleted} objects under prefix "${prefix}"`);
    }

    return totalDeleted;
  }

  /**
   * Generates a tiny blurred base64 data URL from an image buffer.
   * Used as LQIP (Low Quality Image Placeholder) for instant perceived loading.
   */
  async generateBlurDataUrl(imageBuffer: Buffer): Promise<string> {
    const tiny = await sharp(imageBuffer)
      .resize(16, 16, { fit: 'cover' })
      .blur(2)
      .webp({ quality: 20 })
      .toBuffer();
    return `data:image/webp;base64,${tiny.toString('base64')}`;
  }
}
