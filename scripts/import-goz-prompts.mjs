/**
 * Import goz prompts into theaimodelab's prompt library.
 *
 * Source: /tmp/goz_db_prompts.json  (346 rows dumped from the shared Supabase
 *         `prompts` table — same project this API already points to).
 * Target: theaimodelab prompt_sections / prompt_categories / prompt_templates.
 *
 * Decisions (confirmed with the user):
 *   - One flat library: section "Prompts" -> category "Prompts".
 *   - Generic numbered titles: "Prompt 1" .. "Prompt N" ordered by goz sort_order.
 *   - type = 'text_to_image' for all (clean label + routes to image workspace).
 *   - Keep each prompt's image_url, thumbnail_url and ai_model as-is; images
 *     already live in this project's storage, so no re-hosting is needed.
 *
 * Connection: uses theaimodelab-api/.env DATABASE_URL (falls back to DIRECT_URL).
 * Idempotent: creates tables IF NOT EXISTS and clears the category before insert.
 *
 *   node scripts/import-goz-prompts.mjs
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// The platform .env points at Supabase's session pooler (:5432, pool_size 15),
// which is easily exhausted. Route this one-off migration through the
// transaction pooler (:6543, pgbouncer) using the same credentials.
{
  const base = process.env.DATABASE_URL || process.env.DIRECT_URL || '';
  let url = base.replace(':5432/', ':6543/');
  if (url && !/pgbouncer=true/.test(url)) url += (url.includes('?') ? '&' : '?') + 'pgbouncer=true';
  process.env.DATABASE_URL = url;
}

const DUMP_PATH = process.env.GOZ_DUMP || '/tmp/goz_db_prompts.json';

const prisma = new PrismaClient();

const DDL = [
  `CREATE TABLE IF NOT EXISTS "prompt_sections" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "prompt_sections_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "prompt_categories" (
    "id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prompt_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prompt_categories_section_id_fkey" FOREIGN KEY ("section_id")
      REFERENCES "prompt_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "prompt_templates" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "image_url" TEXT,
    "thumbnail_url" TEXT,
    "ai_model" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prompt_templates_category_id_fkey" FOREIGN KEY ("category_id")
      REFERENCES "prompt_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "prompt_sections_slug_key" ON "prompt_sections"("slug")`,
  `CREATE INDEX IF NOT EXISTS "prompt_categories_section_id_idx" ON "prompt_categories"("section_id")`,
  `CREATE INDEX IF NOT EXISTS "prompt_templates_category_id_idx" ON "prompt_templates"("category_id")`,
  `CREATE INDEX IF NOT EXISTS "prompt_templates_is_active_idx" ON "prompt_templates"("is_active")`,
];

async function main() {
  console.log('1) Ensuring prompt tables exist (idempotent)...');
  for (const stmt of DDL) await prisma.$executeRawUnsafe(stmt);
  console.log('   tables ready.');

  const rows = JSON.parse(fs.readFileSync(DUMP_PATH, 'utf8'))
    .filter((r) => r.active !== false)
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        String(a.created_at || '').localeCompare(String(b.created_at || '')),
    );
  console.log(`2) Loaded ${rows.length} prompts from ${DUMP_PATH}.`);

  const section = await prisma.promptSection.upsert({
    where: { slug: 'prompts' },
    update: { title: 'Prompts', icon: 'Image', sortOrder: 0, isActive: true },
    create: { slug: 'prompts', title: 'Prompts', description: null, icon: 'Image', sortOrder: 0, isActive: true },
  });
  let category = await prisma.promptCategory.findFirst({
    where: { sectionId: section.id, title: 'Prompts' },
  });
  if (!category)
    category = await prisma.promptCategory.create({
      data: { sectionId: section.id, title: 'Prompts', sortOrder: 0 },
    });
  console.log(`3) Section ${section.id} / Category ${category.id} ready.`);

  const del = await prisma.promptTemplate.deleteMany({ where: { categoryId: category.id } });
  if (del.count) console.log(`   cleared ${del.count} pre-existing templates.`);

  console.log('4) Inserting templates...');
  let n = 0;
  for (const r of rows) {
    n++;
    await prisma.promptTemplate.create({
      data: {
        categoryId: category.id,
        title: `Prompt ${n}`,
        type: 'text_to_image',
        prompt: r.prompt ?? '',
        imageUrl: r.image_url ?? null,
        thumbnailUrl: r.thumbnail_url ?? null,
        aiModel: r.ai_model ?? null,
        sortOrder: n - 1,
        isActive: true,
      },
    });
    if (n % 50 === 0) console.log(`   ${n}/${rows.length}`);
  }

  const total = await prisma.promptTemplate.count({ where: { categoryId: category.id } });
  const withImg = await prisma.promptTemplate.count({
    where: { categoryId: category.id, imageUrl: { not: null } },
  });
  console.log(`\nDONE. Templates in "Prompts": ${total} (with image: ${withImg})`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FATAL:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
