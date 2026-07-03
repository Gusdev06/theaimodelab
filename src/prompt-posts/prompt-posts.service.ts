import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromptPostDto } from './dto/create-prompt-post.dto';
import { UpdatePromptPostDto } from './dto/update-prompt-post.dto';
import { PromptPostEvent } from './dto/track-event.dto';
import { Prisma } from '@prisma/client';

const POST_INCLUDE = {
  slides: { orderBy: { order: 'asc' as const } },
};

@Injectable()
export class PromptPostsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePromptPostDto, createdById?: string) {
    if (!dto.slides?.length) {
      throw new BadRequestException('Post precisa de pelo menos 1 slide');
    }

    const slug = dto.slug
      ? this.normalizeSlug(dto.slug)
      : await this.generateUniqueSlug(dto.slides[0].prompt);

    if (dto.slug) {
      const existing = await this.prisma.promptPost.findUnique({
        where: { slug },
      });
      if (existing) {
        throw new ConflictException(`Já existe um post com o slug "${slug}"`);
      }
    }

    return this.prisma.promptPost.create({
      data: {
        slug,
        caption: dto.caption,
        isPublished: dto.isPublished ?? true,
        createdById,
        slides: {
          create: dto.slides.map((s, i) => ({
            order: i,
            prompt: s.prompt,
            imageUrl: s.imageUrl,
            thumbnailUrl: s.thumbnailUrl,
            aspectRatio: s.aspectRatio,
            generationType: s.generationType,
            aiModel: s.aiModel,
          })),
        },
      },
      include: POST_INCLUDE,
    });
  }

  async findBySlug(slug: string) {
    const post = await this.prisma.promptPost.findUnique({
      where: { slug },
      include: POST_INCLUDE,
    });
    if (!post || !post.isPublished) {
      throw new NotFoundException('Post não encontrado');
    }
    return post;
  }

  async findById(id: string) {
    const post = await this.prisma.promptPost.findUnique({
      where: { id },
      include: POST_INCLUDE,
    });
    if (!post) throw new NotFoundException('Post não encontrado');
    return post;
  }

  async list(params: { page?: number; limit?: number; published?: boolean }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Prisma.PromptPostWhereInput =
      params.published !== undefined ? { isPublished: params.published } : {};

    const [data, total] = await Promise.all([
      this.prisma.promptPost.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: POST_INCLUDE,
      }),
      this.prisma.promptPost.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async update(id: string, dto: UpdatePromptPostDto) {
    const existing = await this.findById(id);

    return this.prisma.$transaction(async (tx) => {
      const data: Prisma.PromptPostUpdateInput = {};
      if (dto.caption !== undefined) data.caption = dto.caption;
      if (dto.isPublished !== undefined) data.isPublished = dto.isPublished;

      if (dto.slug) {
        const slug = this.normalizeSlug(dto.slug);
        const conflict = await tx.promptPost.findFirst({
          where: { slug, NOT: { id } },
        });
        if (conflict) {
          throw new ConflictException(`Já existe um post com o slug "${slug}"`);
        }
        data.slug = slug;
      }

      if (dto.slides !== undefined) {
        if (!dto.slides.length) {
          throw new BadRequestException('Post precisa de pelo menos 1 slide');
        }
        await tx.promptPostSlide.deleteMany({ where: { postId: id } });
        await tx.promptPostSlide.createMany({
          data: dto.slides.map((s, i) => ({
            postId: id,
            order: i,
            prompt: s.prompt,
            imageUrl: s.imageUrl,
            thumbnailUrl: s.thumbnailUrl,
            aspectRatio: s.aspectRatio,
            generationType: s.generationType,
            aiModel: s.aiModel,
          })),
        });
      }

      if (Object.keys(data).length > 0) {
        await tx.promptPost.update({ where: { id }, data });
      }

      return tx.promptPost.findUniqueOrThrow({
        where: { id },
        include: POST_INCLUDE,
      });
    });
  }

  async remove(id: string) {
    await this.findById(id);
    await this.prisma.promptPost.delete({ where: { id } });
    return { success: true };
  }

  async trackEvent(slug: string, event: PromptPostEvent, slideIndex?: number) {
    const post = await this.prisma.promptPost.findUnique({
      where: { slug },
      select: {
        id: true,
        isPublished: true,
        slides: {
          orderBy: { order: 'asc' },
          select: { id: true, order: true },
        },
      },
    });
    if (!post || !post.isPublished) {
      throw new NotFoundException('Post não encontrado');
    }

    const postField =
      event === PromptPostEvent.VIEW
        ? 'viewCount'
        : event === PromptPostEvent.COPY
          ? 'copyCount'
          : 'useCount';

    await this.prisma.$transaction(async (tx) => {
      await tx.promptPost.update({
        where: { id: post.id },
        data: { [postField]: { increment: 1 } },
      });

      if (
        slideIndex !== undefined &&
        event !== PromptPostEvent.VIEW &&
        post.slides[slideIndex]
      ) {
        const slideField =
          event === PromptPostEvent.COPY ? 'copyCount' : 'useCount';
        await tx.promptPostSlide.update({
          where: { id: post.slides[slideIndex].id },
          data: { [slideField]: { increment: 1 } },
        });
      }
    });

    return { success: true };
  }

  private normalizeSlug(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private async generateUniqueSlug(seed: string): Promise<string> {
    const base = this.normalizeSlug(seed) || 'post';
    let candidate = base;
    let suffix = 1;

    while (true) {
      const existing = await this.prisma.promptPost.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing) return candidate;
      suffix += 1;
      const truncated = base.slice(0, 60 - String(suffix).length - 1);
      candidate = `${truncated}-${suffix}`;
    }
  }
}
