import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
})
class MigrateModule {}

const PUBLIC_BASE = process.env.S3_PUBLIC_URL!;
const BUCKET_NAME = process.env.S3_BUCKET_NAME ?? 'ai-generations';

/**
 * Extract the S3 key from a signed URL.
 * Signed URL format: https://xxx.supabase.co/storage/v1/s3/<bucket>/<key>?X-Amz-...
 */
function extractS3Key(url: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;

    // Supabase S3 signed URL pattern
    const s3Prefix = `/storage/v1/s3/${BUCKET_NAME}/`;
    const s3Idx = pathname.indexOf(s3Prefix);
    if (s3Idx !== -1) {
      return pathname.slice(s3Idx + s3Prefix.length);
    }

    // Already a public URL — extract key from /storage/v1/object/public/<bucket>/<key>
    const pubPrefix = `/storage/v1/object/public/${BUCKET_NAME}/`;
    const pubIdx = pathname.indexOf(pubPrefix);
    if (pubIdx !== -1) {
      return pathname.slice(pubIdx + pubPrefix.length);
    }

    // Generic fallback: after bucket name in path
    const bucketIdx = pathname.indexOf(`/${BUCKET_NAME}/`);
    if (bucketIdx !== -1) {
      return pathname.slice(bucketIdx + BUCKET_NAME.length + 2);
    }

    return null;
  } catch {
    return null;
  }
}

function isSignedUrl(url: string): boolean {
  return url.includes('X-Amz-') || url.includes('/storage/v1/s3/');
}

function toPublicUrl(key: string): string {
  return `${PUBLIC_BASE.replace(/\/$/, '')}/${key}`;
}

const BATCH_SIZE = 100;

async function main() {
  if (!PUBLIC_BASE) {
    console.error('S3_PUBLIC_URL env var is required');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(MigrateModule);
  const prisma = app.get(PrismaService);

  console.log(`Public base: ${PUBLIC_BASE}`);
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log('');

  // ── 1. Migrate generation_outputs.url ──────────────────────────────────────
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  console.log('=== Migrating generation_outputs.url ===');
  let offset = 0;
  while (true) {
    const outputs = await prisma.generationOutput.findMany({
      select: { id: true, url: true, thumbnailUrl: true },
      skip: offset,
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });
    if (outputs.length === 0) break;
    offset += outputs.length;

    for (const output of outputs) {
      const updates: Record<string, string> = {};

      // Migrate url
      if (output.url && isSignedUrl(output.url)) {
        const key = extractS3Key(output.url);
        if (key) {
          updates.url = toPublicUrl(key);
        } else {
          failed++;
          console.error(`  ✗ Could not extract key from output ${output.id} url`);
          continue;
        }
      }

      // Migrate thumbnailUrl
      if (output.thumbnailUrl && isSignedUrl(output.thumbnailUrl)) {
        const key = extractS3Key(output.thumbnailUrl);
        if (key) {
          updates.thumbnailUrl = toPublicUrl(key);
        }
      }

      if (Object.keys(updates).length > 0) {
        await prisma.generationOutput.update({
          where: { id: output.id },
          data: updates,
        });
        updated++;
      } else {
        skipped++;
      }
    }

    process.stdout.write(`\r  Processed ${offset} outputs (updated: ${updated}, skipped: ${skipped}, failed: ${failed})`);
  }
  console.log(`\n  Done: ${updated} updated, ${skipped} already public, ${failed} failed\n`);

  // ── 2. Migrate generation input images ─────────────────────────────────────
  console.log('=== Migrating generation_input_images.url ===');
  let inputUpdated = 0;
  let inputSkipped = 0;
  offset = 0;

  while (true) {
    const inputs = await prisma.generationInputImage.findMany({
      select: { id: true, url: true },
      skip: offset,
      take: BATCH_SIZE,
      orderBy: { createdAt: 'asc' },
    });
    if (inputs.length === 0) break;
    offset += inputs.length;

    for (const input of inputs) {
      if (input.url && isSignedUrl(input.url)) {
        const key = extractS3Key(input.url);
        if (key) {
          await prisma.generationInputImage.update({
            where: { id: input.id },
            data: { url: toPublicUrl(key) },
          });
          inputUpdated++;
        }
      } else {
        inputSkipped++;
      }
    }

    process.stdout.write(`\r  Processed ${offset} inputs (updated: ${inputUpdated}, skipped: ${inputSkipped})`);
  }
  console.log(`\n  Done: ${inputUpdated} updated, ${inputSkipped} already public\n`);

  console.log('=== Migration complete ===');
  await app.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
