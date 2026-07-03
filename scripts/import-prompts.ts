import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ============================================
// S3 Client (same pattern as upload-utils-images.ts)
// ============================================

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
const S3_PUBLIC_URL = process.env.S3_PUBLIC_URL || `https://qwmnnkgejgjlpzofrxrl.supabase.co/storage/v1/object/public/${BUCKET}`;

// ============================================
// Prisma Client
// ============================================

const prisma = new PrismaClient();

// ============================================
// Path to extracted prompts JSON
// ============================================

const PROMPTS_JSON_PATH = path.resolve(
  __dirname,
  '../../teste/extracted/_all_prompts.json',
);

// ============================================
// Icon mapping based on section name keywords
// ============================================

function getIconForSection(sectionName: string): string {
  const name = sectionName.toLowerCase();

  if (name.includes('influencer') && !name.includes('biquini') && !name.includes('corredora') && !name.includes('podcast') && !name.includes('rolê') && !name.includes('noite') && !name.includes('produto')) {
    return 'Camera';
  }
  if (name.includes('realismo') || name.includes('rostos')) {
    return 'Sparkles';
  }
  if (name.includes('gym') || name.includes('academia')) {
    return 'Dumbbell';
  }
  if (name.includes('biquini')) {
    return 'Sun';
  }
  if (name.includes('macro') || name.includes('zoom')) {
    return 'ZoomIn';
  }
  if (name.includes('podcast')) {
    return 'Mic';
  }
  if (name.includes('noite') || name.includes('rolê')) {
    return 'Moon';
  }
  if (name.includes('corredora')) {
    return 'PersonStanding';
  }
  if (name.includes('produto')) {
    return 'Package';
  }
  return 'Image';
}

// ============================================
// Types for the JSON structure
// ============================================

interface PromptEntry {
  title: string;
  ai_model: string;
  prompt_json: Record<string, unknown> | null;
  prompt_text: string | null;
  image_filename: string;
  image_path: string;
}

interface SectionEntry {
  section: string;
  slug: string;
  prompt_count: number;
  prompts: PromptEntry[];
}

interface AllPromptsData {
  total_sections: number;
  total_prompts: number;
  total_images: number;
  sections: SectionEntry[];
}

// ============================================
// Upload image to S3
// ============================================

async function uploadImageToS3(
  localPath: string,
  s3Key: string,
): Promise<string> {
  const fileBuffer = fs.readFileSync(localPath);

  // Determine content type from extension
  const ext = path.extname(localPath).toLowerCase();
  let contentType = 'image/jpeg';
  if (ext === '.png') contentType = 'image/png';
  else if (ext === '.webp') contentType = 'image/webp';

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: fileBuffer,
      ContentType: contentType,
    }),
  );

  return `${S3_PUBLIC_URL}/${s3Key}`;
}

// ============================================
// Determine prompt text from entry
// ============================================

function getPromptText(entry: PromptEntry): string {
  if (entry.prompt_json) {
    return JSON.stringify(entry.prompt_json);
  }
  if (entry.prompt_text) {
    return entry.prompt_text;
  }
  return '';
}

// ============================================
// Determine prompt type from entry
// ============================================

function getPromptType(entry: PromptEntry): string {
  if (entry.prompt_json) {
    return 'json';
  }
  return 'text';
}

// ============================================
// Main import function
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('  The AI Model Lab — Prompt Import Script');
  console.log('='.repeat(60));
  console.log();

  // 1. Load JSON
  console.log(`Loading prompts from: ${PROMPTS_JSON_PATH}`);
  if (!fs.existsSync(PROMPTS_JSON_PATH)) {
    console.error(`ERROR: File not found: ${PROMPTS_JSON_PATH}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(PROMPTS_JSON_PATH, 'utf-8');
  const data: AllPromptsData = JSON.parse(rawData);

  console.log(`  Total sections: ${data.total_sections}`);
  console.log(`  Total prompts:  ${data.total_prompts}`);
  console.log(`  Total images:   ${data.total_images}`);
  console.log();

  // 2. Connect to DB
  console.log('Connecting to database...');
  await prisma.$connect();
  console.log('  Connected.\n');

  // Counters
  let sectionsCreated = 0;
  let categoriesCreated = 0;
  let promptsCreated = 0;
  let imagesUploaded = 0;
  let imagesFailed = 0;

  // 3. Process each section
  for (let sIdx = 0; sIdx < data.sections.length; sIdx++) {
    const section = data.sections[sIdx];
    const sectionIcon = getIconForSection(section.section);

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Section ${sIdx + 1}/${data.sections.length}: "${section.section}"`);
    console.log(`  slug: ${section.slug}  |  icon: ${sectionIcon}  |  prompts: ${section.prompt_count}`);
    console.log(`${'─'.repeat(60)}`);

    // 3a. Create PromptSection (upsert to be safe on re-runs)
    const dbSection = await prisma.promptSection.upsert({
      where: { slug: section.slug },
      update: {
        title: section.section,
        icon: sectionIcon,
        sortOrder: sIdx,
      },
      create: {
        slug: section.slug,
        title: section.section,
        description: null,
        icon: sectionIcon,
        sortOrder: sIdx,
        isActive: true,
      },
    });
    sectionsCreated++;
    console.log(`  [DB] PromptSection created/updated: ${dbSection.id}`);

    // 3b. Create ONE PromptCategory per section
    // Check if a category with this title already exists for this section
    let dbCategory = await prisma.promptCategory.findFirst({
      where: {
        sectionId: dbSection.id,
        title: section.section,
      },
    });

    if (!dbCategory) {
      dbCategory = await prisma.promptCategory.create({
        data: {
          sectionId: dbSection.id,
          title: section.section,
          sortOrder: 0,
        },
      });
      console.log(`  [DB] PromptCategory created: ${dbCategory.id}`);
    } else {
      console.log(`  [DB] PromptCategory already exists: ${dbCategory.id}`);
    }
    categoriesCreated++;

    // 3c. Process each prompt in the section
    for (let pIdx = 0; pIdx < section.prompts.length; pIdx++) {
      const prompt = section.prompts[pIdx];
      const promptText = getPromptText(prompt);
      const promptType = getPromptType(prompt);

      process.stdout.write(`  [${pIdx + 1}/${section.prompts.length}] "${prompt.title}" — `);

      // Upload image to S3
      let imageUrl: string | null = null;

      if (prompt.image_path && fs.existsSync(prompt.image_path)) {
        const s3Key = `prompts/${section.slug}/${prompt.image_filename}`;
        try {
          const fileSize = fs.statSync(prompt.image_path).size;
          process.stdout.write(
            `uploading ${(fileSize / 1024).toFixed(1)}KB... `,
          );
          imageUrl = await uploadImageToS3(prompt.image_path, s3Key);
          process.stdout.write('OK — ');
          imagesUploaded++;
        } catch (err: any) {
          process.stdout.write(`UPLOAD FAILED (${err.message}) — `);
          imagesFailed++;
        }
      } else {
        process.stdout.write('image not found, skipping upload — ');
        imagesFailed++;
      }

      // Create PromptTemplate in DB
      try {
        await prisma.promptTemplate.create({
          data: {
            categoryId: dbCategory.id,
            title: prompt.title,
            type: promptType,
            prompt: promptText,
            imageUrl: imageUrl,
            aiModel: prompt.ai_model,
            sortOrder: pIdx,
            isActive: true,
          },
        });
        console.log('saved to DB');
        promptsCreated++;
      } catch (err: any) {
        console.log(`DB FAILED (${err.message})`);
      }
    }
  }

  // 4. Print summary
  console.log('\n' + '='.repeat(60));
  console.log('  IMPORT COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Sections created/updated:  ${sectionsCreated}`);
  console.log(`  Categories created:        ${categoriesCreated}`);
  console.log(`  Prompts created:           ${promptsCreated}`);
  console.log(`  Images uploaded to S3:     ${imagesUploaded}`);
  console.log(`  Images failed:             ${imagesFailed}`);
  console.log('='.repeat(60));

  // 5. Disconnect
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nFATAL ERROR:', err);
  await prisma.$disconnect();
  process.exit(1);
});
