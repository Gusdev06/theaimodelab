import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptSectionDto, PromptTemplateDto } from './dto/prompt-response.dto';

/**
 * Os títulos de categoria estão salvos "sujos" no banco (ex.: "25 Prompts
 * Influencer de Biquini", "3 prompts para Academia"). Normaliza na saída da
 * API pública: remove a contagem, a palavra "Prompts" e o conector inicial.
 * O admin continua vendo o título original para gerenciamento.
 */
function cleanCategoryTitle(title: string): string {
  const cleaned = title
    .replace(/^\s*\d+\s*/, '')
    .replace(/^prompts?\s*/i, '')
    .replace(/^(de|do|da|dos|das|para|em)\s+/i, '')
    .trim();
  if (!cleaned) return title.trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

@Injectable()
export class PromptsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAllSections(): Promise<PromptSectionDto[]> {
    const sections = await this.prisma.promptSection.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        icon: true,
        categories: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            title: true,
            prompts: {
              where: { isActive: true },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                title: true,
                type: true,
                prompt: true,
                imageUrl: true,
                thumbnailUrl: true,
                aiModel: true,
              },
            },
          },
        },
      },
    });

    return sections.map((section) => ({
      id: section.id,
      slug: section.slug,
      title: section.title,
      description: section.description ?? undefined,
      icon: section.icon ?? undefined,
      categories: section.categories.map((category) => ({
        id: category.id,
        title: cleanCategoryTitle(category.title),
        prompts: category.prompts.map((prompt) => ({
          id: prompt.id,
          title: prompt.title,
          type: prompt.type,
          prompt: prompt.prompt,
          imageUrl: prompt.imageUrl ?? undefined,
          thumbnailUrl: prompt.thumbnailUrl ?? undefined,
          aiModel: prompt.aiModel ?? undefined,
        })),
      })),
    }));
  }

  async getSectionBySlug(slug: string): Promise<PromptSectionDto> {
    const section = await this.prisma.promptSection.findUnique({
      where: { slug, isActive: true },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        icon: true,
        categories: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            title: true,
            prompts: {
              where: { isActive: true },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                title: true,
                type: true,
                prompt: true,
                imageUrl: true,
                thumbnailUrl: true,
                aiModel: true,
              },
            },
          },
        },
      },
    });

    if (!section) {
      throw new NotFoundException(`Secao com slug "${slug}" nao encontrada`);
    }

    return {
      id: section.id,
      slug: section.slug,
      title: section.title,
      description: section.description ?? undefined,
      icon: section.icon ?? undefined,
      categories: section.categories.map((category) => ({
        id: category.id,
        title: cleanCategoryTitle(category.title),
        prompts: category.prompts.map((prompt) => ({
          id: prompt.id,
          title: prompt.title,
          type: prompt.type,
          prompt: prompt.prompt,
          imageUrl: prompt.imageUrl ?? undefined,
          thumbnailUrl: prompt.thumbnailUrl ?? undefined,
          aiModel: prompt.aiModel ?? undefined,
        })),
      })),
    };
  }

  async searchPrompts(query: string): Promise<PromptTemplateDto[]> {
    const prompts = await this.prisma.promptTemplate.findMany({
      where: {
        isActive: true,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { prompt: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        title: true,
        type: true,
        prompt: true,
        imageUrl: true,
        thumbnailUrl: true,
        aiModel: true,
      },
    });

    return prompts.map((prompt) => ({
      id: prompt.id,
      title: prompt.title,
      type: prompt.type,
      prompt: prompt.prompt,
      imageUrl: prompt.imageUrl ?? undefined,
      thumbnailUrl: prompt.thumbnailUrl ?? undefined,
      aiModel: prompt.aiModel ?? undefined,
    }));
  }
}
