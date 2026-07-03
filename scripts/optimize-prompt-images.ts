import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY!,
    secretAccessKey: process.env.S3_SECRET_KEY!,
  },
  forcePathStyle: true,
});

const BUCKET = process.env.S3_BUCKET_NAME || 'ai-generations';
const S3_PUBLIC_URL =
  process.env.S3_PUBLIC_URL ||
  `https://qwmnnkgejgjlpzofrxrl.supabase.co/storage/v1/object/public/${BUCKET}`;

const prisma = new PrismaClient();

const PROMPTS_JSON_PATH = path.resolve(
  __dirname,
  '../../teste/extracted/_all_prompts.json',
);

// Max width 500px (cards are ~200px, 2x for retina)
const MAX_WIDTH = 500;
const WEBP_QUALITY = 80;

interface PromptEntry {
  title: string;
  image_filename: string;
  image_path: string;
}

interface SectionEntry {
  section: string;
  slug: string;
  prompts: PromptEntry[];
}

interface AllPromptsData {
  sections: SectionEntry[];
}

async function optimizeAndUpload(
  localPath: string,
  s3Key: string,
): Promise<{ url: string; originalKB: number; optimizedKB: number }> {
  const originalBuffer = fs.readFileSync(localPath);
  const originalKB = originalBuffer.length / 1024;

  const optimizedBuffer = await sharp(originalBuffer)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  const optimizedKB = optimizedBuffer.length / 1024;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: optimizedBuffer,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );

  return { url: `${S3_PUBLIC_URL}/${s3Key}`, originalKB, optimizedKB };
}

async function main() {
  console.log('='.repeat(60));
  console.log('  Optimize Prompt Images → WebP 500px');
  console.log('='.repeat(60));

  const rawData = fs.readFileSync(PROMPTS_JSON_PATH, 'utf-8');
  const data: AllPromptsData = JSON.parse(rawData);

  await prisma.$connect();

  let totalOriginalKB = 0;
  let totalOptimizedKB = 0;
  let updated = 0;
  let failed = 0;

  for (const section of data.sections) {
    console.log(`\n── ${section.section} (${section.prompts.length} prompts)`);

    for (const prompt of section.prompts) {
      if (!prompt.image_path || !fs.existsSync(prompt.image_path)) {
        console.log(`  ⚠ skip: ${prompt.title} (no image)`);
        failed++;
        continue;
      }

      const webpFilename =
        path.basename(prompt.image_filename, path.extname(prompt.image_filename)) + '.webp';
      const s3Key = `prompts/${section.slug}/${webpFilename}`;

      try {
        const { url, originalKB, optimizedKB } = await optimizeAndUpload(
          prompt.image_path,
          s3Key,
        );

        totalOriginalKB += originalKB;
        totalOptimizedKB += optimizedKB;

        // Update DB record by matching title + section slug
        const result = await prisma.promptTemplate.updateMany({
          where: {
            title: prompt.title,
            category: {
              section: { slug: section.slug },
            },
          },
          data: { imageUrl: url },
        });

        if (result.count > 0) {
          updated++;
          const savings = ((1 - optimizedKB / originalKB) * 100).toFixed(0);
          process.stdout.write(
            `  ✓ ${prompt.title} — ${originalKB.toFixed(0)}KB → ${optimizedKB.toFixed(0)}KB (−${savings}%)\n`,
          );
        } else {
          console.log(`  ⚠ ${prompt.title} — uploaded but no DB match`);
          failed++;
        }
      } catch (err: any) {
        console.log(`  ✗ ${prompt.title} — ${err.message}`);
        failed++;
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('  DONE');
  console.log('='.repeat(60));
  console.log(`  Images optimized:  ${updated}`);
  console.log(`  Failed:            ${failed}`);
  console.log(
    `  Total original:    ${(totalOriginalKB / 1024).toFixed(1)} MB`,
  );
  console.log(
    `  Total optimized:   ${(totalOptimizedKB / 1024).toFixed(1)} MB`,
  );
  console.log(
    `  Savings:           ${((1 - totalOptimizedKB / totalOriginalKB) * 100).toFixed(0)}%`,
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  await prisma.$disconnect();
  process.exit(1);
});
