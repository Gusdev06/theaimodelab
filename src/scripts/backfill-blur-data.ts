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

const BATCH_SIZE = 20;
const CONCURRENCY = 5;

/**
 * Extract the S3 key from a signed URL.
 * URL format: https://xxx.supabase.co/storage/v1/s3/<bucket>/<key>?X-Amz-...
 */
function extractS3Key(signedUrl: string, bucketName: string): string | null {
  try {
    const url = new URL(signedUrl);
    const pathname = url.pathname;
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
  const bucketName = process.env.S3_BUCKET_NAME ?? 'ai-generations';

  // All completed outputs that have a thumbnail but no blur data
  const total = await prisma.generationOutput.count({
    where: {
      blurDataUrl: null,
      thumbnailUrl: { not: null },
      generation: {
        status: 'COMPLETED',
        isDeleted: false,
      },
    },
  });

  console.log(`Found ${total} outputs with thumbnail but no blur data`);
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
        blurDataUrl: null,
        thumbnailUrl: { not: null },
        id: { notIn: [...failedIds] },
        generation: {
          status: 'COMPLETED',
          isDeleted: false,
        },
      },
      select: { id: true, url: true, thumbnailUrl: true },
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (output) => {
          try {
            // Prefer thumbnail (smaller download) over full output
            const originalUrl = output.thumbnailUrl ?? output.url;

            // Try direct download first; if expired (400/403), re-sign the URL
            let res = await fetch(originalUrl);
            if (!res.ok && (res.status === 400 || res.status === 403)) {
              const s3Key = extractS3Key(originalUrl, bucketName);
              if (s3Key) {
                const freshUrl = await uploads.getSignedReadUrl(s3Key);
                res = await fetch(freshUrl);
              }
            }
            if (!res.ok) throw new Error(`Download failed: ${res.status}`);

            const buf = Buffer.from(await res.arrayBuffer());
            const blurDataUrl = await uploads.generateBlurDataUrl(buf);

            await prisma.generationOutput.update({
              where: { id: output.id },
              data: { blurDataUrl },
            });

            processed++;
            console.log(`[${processed + failed}/${total}] ✓ ${output.id}`);
          } catch (err) {
            failed++;
            failedIds.add(output.id);
            console.error(`[${processed + failed}/${total}] ✗ ${output.id}: ${(err as Error).message}`);
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
