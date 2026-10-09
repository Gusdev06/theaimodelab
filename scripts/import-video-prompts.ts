/**
 * Importa exemplos de prompt de VÍDEO sensual para a Biblioteca de Prompts.
 *
 * Contexto: a biblioteca em produção tem 346 prompts, todos text_to_image —
 * nenhum de vídeo. As clientes que querem gerar vídeo não têm nenhum exemplo.
 * Este script adiciona exemplos de vídeo (tier sensual/editorial, não explícito),
 * organizados em seções, para ensinarem a usar o gerador de vídeo.
 *
 * Fonte: scripts/data/video-prompts-sensual.json (versionado no repo).
 * Alvo:  PromptSection -> PromptCategory -> PromptTemplate (type = text_to_video,
 *        que o web roteia para /video).
 *
 * Idempotente: re-rodar não duplica (upsert de seção por slug; template pulado
 * se já existir um com o mesmo título na categoria). Não mexe nos prompts de
 * imagem existentes. Não sobe imagem (thumbnails entram depois, por fora).
 *
 * Uso:   ts-node -r tsconfig-paths/register scripts/import-video-prompts.ts [--dry]
 *        (precisa de DATABASE_URL no .env; --dry só mostra o que faria)
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DATA_PATH = path.resolve(__dirname, 'data', 'video-prompts-sensual.json');
const DRY_RUN = process.argv.includes('--dry');
const PROMPT_TYPE = 'text_to_video';

interface VideoPrompt {
  title: string;
  prompt: string;
  /** descrição curta em PT (metadado da curadoria; não vai pro banco) */
  desc?: string;
}

interface VideoSection {
  slug: string;
  title: string;
  icon: string;
  prompts: VideoPrompt[];
}

interface VideoPromptsData {
  meta?: Record<string, unknown>;
  sections: VideoSection[];
}

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  The AI Model Lab — Import de prompts de VÍDEO (sensual)');
  console.log(DRY_RUN ? '  MODO DRY-RUN (nada é gravado)' : '  Gravando no banco');
  console.log('='.repeat(60));

  if (!fs.existsSync(DATA_PATH)) {
    console.error(`ERRO: arquivo não encontrado: ${DATA_PATH}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8')) as VideoPromptsData;
  const totalPrompts = data.sections.reduce((sum, s) => sum + s.prompts.length, 0);
  console.log(`\nSeções: ${data.sections.length} | Prompts: ${totalPrompts}\n`);

  // valida slugs/títulos únicos antes de tocar no banco
  const slugs = new Set<string>();
  for (const section of data.sections) {
    if (slugs.has(section.slug)) throw new Error(`slug duplicado no arquivo: ${section.slug}`);
    slugs.add(section.slug);
    const titles = new Set<string>();
    for (const prompt of section.prompts) {
      if (titles.has(prompt.title)) throw new Error(`título duplicado em ${section.slug}: ${prompt.title}`);
      titles.add(prompt.title);
      if (!prompt.prompt.trim()) throw new Error(`prompt vazio em ${section.slug}: ${prompt.title}`);
    }
  }

  if (!DRY_RUN) await prisma.$connect();

  let sectionsTouched = 0;
  let promptsCreated = 0;
  let promptsSkipped = 0;

  for (let sIdx = 0; sIdx < data.sections.length; sIdx++) {
    const section = data.sections[sIdx];
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${sIdx + 1}/${data.sections.length}] ${section.title}  (${section.prompts.length} prompts)`);

    if (DRY_RUN) {
      section.prompts.forEach((p) => console.log(`   + ${p.title}`));
      sectionsTouched++;
      promptsCreated += section.prompts.length;
      continue;
    }

    // seção após as de imagem já existentes
    const dbSection = await prisma.promptSection.upsert({
      where: { slug: section.slug },
      update: { title: section.title, icon: section.icon, sortOrder: 100 + sIdx, isActive: true },
      create: {
        slug: section.slug,
        title: section.title,
        description: null,
        icon: section.icon,
        sortOrder: 100 + sIdx,
        isActive: true,
      },
    });
    sectionsTouched++;

    let dbCategory = await prisma.promptCategory.findFirst({
      where: { sectionId: dbSection.id, title: section.title },
    });
    if (!dbCategory) {
      dbCategory = await prisma.promptCategory.create({
        data: { sectionId: dbSection.id, title: section.title, sortOrder: 0 },
      });
    }

    for (let pIdx = 0; pIdx < section.prompts.length; pIdx++) {
      const prompt = section.prompts[pIdx];
      const existing = await prisma.promptTemplate.findFirst({
        where: { categoryId: dbCategory.id, title: prompt.title },
        select: { id: true },
      });
      if (existing) {
        promptsSkipped++;
        continue;
      }
      await prisma.promptTemplate.create({
        data: {
          categoryId: dbCategory.id,
          title: prompt.title,
          type: PROMPT_TYPE,
          prompt: prompt.prompt,
          imageUrl: null,
          aiModel: null,
          sortOrder: pIdx,
          isActive: true,
        },
      });
      promptsCreated++;
    }
    console.log(`   criados: ${promptsCreated} | já existiam: ${promptsSkipped}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`  FIM — seções: ${sectionsTouched} | prompts novos: ${promptsCreated} | pulados: ${promptsSkipped}`);
  console.log('='.repeat(60));

  if (!DRY_RUN) await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nERRO FATAL:', err);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
