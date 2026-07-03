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
// REGEN_ALL=1 reprocessa TODOS os thumbnails de imagem (não só os ausentes) —
// usado para corrigir thumbnails antigos que foram gerados quadrados (cover).
const REGEN_ALL = process.env.REGEN_ALL === '1';
const thumbWhere = REGEN_ALL ? {} : { thumbnailUrl: null };

async function main() {
  const app = await NestFactory.createApplicationContext(BackfillModule);
  const prisma = app.get(PrismaService);
  const uploads = app.get(UploadsService);

  // Reset previously failed attempts (empty string or same as url)
  const resetResult = await prisma.$executeRaw`
    UPDATE generation_outputs SET thumbnail_url = NULL
    WHERE thumbnail_url = '' OR thumbnail_url = url
  `;
  if (resetResult > 0) {
    console.log(`Reset ${resetResult} previously failed thumbnails`);
  }

  // Only image generation outputs without thumbnails
  const total = await prisma.generationOutput.count({
    where: {
      ...thumbWhere,
      generation: {
        type: { in: ['TEXT_TO_IMAGE', 'IMAGE_TO_IMAGE'] },
        status: 'COMPLETED',
      },
    },
  });

  console.log(`Found ${total} outputs without thumbnails`);
  if (total === 0) {
    await app.close();
    return;
  }

  let processed = 0;
  let failed = 0;
  // No modo REGEN_ALL os itens reprocessados continuam casando com o filtro,
  // então paginamos por cursor de id; no modo padrão o próprio update (thumb != null)
  // já remove o item do filtro, então não precisa de cursor.
  let cursorId: string | undefined;

  while (true) {
    const batch = await prisma.generationOutput.findMany({
      where: {
        ...thumbWhere,
        generation: {
          type: { in: ['TEXT_TO_IMAGE', 'IMAGE_TO_IMAGE'] },
          status: 'COMPLETED',
        },
      },
      select: { id: true, url: true, generationId: true },
      take: BATCH_SIZE,
      ...(REGEN_ALL
        ? {
            orderBy: { id: 'asc' as const },
            ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
          }
        : {}),
    });

    if (batch.length === 0) break;
    if (REGEN_ALL) cursorId = batch[batch.length - 1].id;

    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (output) => {
          try {
            const thumbnailUrl = await uploads.generateThumbnailDirect(
              output.url,
              `thumbnails/${output.generationId}`,
              `thumb_${output.id}.webp`,
              512,
              undefined,
              true,
            );

            // Generate LQIP blur placeholder
            const imgRes = await fetch(output.url);
            const imgBuf = imgRes.ok ? Buffer.from(await imgRes.arrayBuffer()) : null;
            const blurDataUrl = imgBuf ? await uploads.generateBlurDataUrl(imgBuf) : null;

            await prisma.generationOutput.update({
              where: { id: output.id },
              data: { thumbnailUrl, blurDataUrl },
            });

            processed++;
            console.log(`[${processed + failed}/${total}] ✓ ${output.id}`);
          } catch (err) {
            failed++;
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
