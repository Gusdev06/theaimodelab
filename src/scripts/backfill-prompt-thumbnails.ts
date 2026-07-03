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
const THUMB_WIDTH = 400;
const THUMB_HEIGHT = 500;

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule);
  const prisma = app.get(PrismaService);
  const uploads = app.get(UploadsService);

  // Reset previously failed attempts stored as empty/equal-to-source
  const resetResult = await prisma.$executeRaw`
    UPDATE prompt_templates SET thumbnail_url = NULL
    WHERE thumbnail_url = '' OR thumbnail_url = image_url
  `;
  if (resetResult > 0) {
    console.log(`Reset ${resetResult} previously failed thumbnails`);
  }

  const total = await prisma.promptTemplate.count({
    where: {
      isActive: true,
      thumbnailUrl: null,
      imageUrl: { not: null },
    },
  });

  console.log(`Found ${total} prompt templates without thumbnails`);
  if (total === 0) {
    await app.close();
    return;
  }

  let processed = 0;
  let failed = 0;

  while (true) {
    const batch = await prisma.promptTemplate.findMany({
      where: {
        isActive: true,
        thumbnailUrl: null,
        imageUrl: { not: null },
      },
      select: { id: true, imageUrl: true },
      take: BATCH_SIZE,
    });

    if (batch.length === 0) break;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (template) => {
          if (!template.imageUrl) return;
          try {
            const thumbnailUrl = await uploads.generateThumbnailDirect(
              template.imageUrl,
              `thumbnails/prompts/${template.id}`,
              'thumb.webp',
              THUMB_WIDTH,
              THUMB_HEIGHT,
            );

            await prisma.promptTemplate.update({
              where: { id: template.id },
              data: { thumbnailUrl },
            });

            processed++;
            console.log(`[${processed + failed}/${total}] ✓ ${template.id}`);
          } catch (err) {
            failed++;
            console.error(
              `[${processed + failed}/${total}] ✗ ${template.id}: ${(err as Error).message}`,
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
