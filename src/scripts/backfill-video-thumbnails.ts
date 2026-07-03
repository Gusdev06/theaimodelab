import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsModule } from '../uploads/uploads.module';
import { UploadsService } from '../uploads/uploads.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, UploadsModule],
})
class BackfillModule {}

const BATCH_SIZE = 5;
const CONCURRENCY = 1;

/**
 * Extract the S3 key from a signed URL.
 * URL format: https://xxx.supabase.co/storage/v1/s3/<bucket>/<key>?X-Amz-...
 */
function extractS3Key(signedUrl: string, bucketName: string): string | null {
  try {
    const url = new URL(signedUrl);
    const pathname = url.pathname; // /storage/v1/s3/ai-generations/generations/xxx/output.mp4
    const bucketPrefix = `/storage/v1/s3/${bucketName}/`;
    const idx = pathname.indexOf(bucketPrefix);
    if (idx !== -1) {
      return pathname.slice(idx + bucketPrefix.length);
    }
    // Fallback: try after bucket name anywhere in path
    const bucketIdx = pathname.indexOf(`/${bucketName}/`);
    if (bucketIdx !== -1) {
      return pathname.slice(bucketIdx + bucketName.length + 2);
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule);
  const prisma = app.get(PrismaService);
  const uploads = app.get(UploadsService);

  const bucketName = process.env.S3_BUCKET_NAME || 'ai-generations';

  // Video generation types
  const videoTypes = [
    'TEXT_TO_VIDEO',
    'IMAGE_TO_VIDEO',
    'MOTION_CONTROL',
    'REFERENCE_VIDEO',
  ] as const;

  const total = await prisma.generationOutput.count({
    where: {
      thumbnailUrl: null,
      generation: {
        type: { in: [...videoTypes] },
        status: 'COMPLETED',
        isDeleted: false,
      },
    },
  });

  console.log(`Found ${total} video outputs without thumbnails`);
  if (total === 0) {
    await app.close();
    return;
  }

  let processed = 0;
  let failed = 0;
  const failedIds = new Set<string>();

  while (true) {
    const batch = await prisma.generationOutput.findMany({
      where: {
        thumbnailUrl: null,
        id: { notIn: [...failedIds] },
        generation: {
          type: { in: [...videoTypes] },
          status: 'COMPLETED',
          isDeleted: false,
        },
      },
      select: { id: true, url: true, generationId: true },
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (output) => {
          try {
            // Generate a fresh signed URL from the S3 key
            const s3Key = extractS3Key(output.url, bucketName);
            let freshUrl: string;
            if (s3Key) {
              freshUrl = await uploads.getSignedReadUrl(s3Key);
            } else {
              // URL might not be a signed URL (e.g. public URL), use as-is
              freshUrl = output.url;
            }

            const thumbnailUrl = await uploads.generateVideoThumbnail(
              freshUrl,
              `thumbnails/${output.generationId}`,
              `thumb_${output.id}.webp`,
            );

            // Generate LQIP blur placeholder
            const vidRes = await fetch(freshUrl);
            const vidBuf = vidRes.ok ? Buffer.from(await vidRes.arrayBuffer()) : null;
            const blurDataUrl = vidBuf ? await uploads.generateBlurDataUrl(vidBuf).catch(() => null) : null;

            await prisma.generationOutput.update({
              where: { id: output.id },
              data: { thumbnailUrl, blurDataUrl },
            });

            processed++;
            console.log(`[${processed + failed}/${total}] ✓ ${output.id}`);
          } catch (err) {
            failed++;
            failedIds.add(output.id);
            console.error(
              `[${processed + failed}/${total}] ✗ ${output.id}: ${(err as Error).message}`,
            );
          }
        }),
      );
    }
  }

  console.log(`\nDone! Processed: ${processed}, Failed: ${failed}`);
  await app.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
