import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateAnnouncementDto,
  UpdateAnnouncementDto,
} from './dto/announcement.dto';

type LocaleText = {
  badge?: string;
  title?: string;
  description?: string;
  ctaLabel?: string;
};

@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Avisos ativos já no idioma pedido. pt-BR é a base; en/es sobrescrevem os
   * campos que tiverem tradução (vazios caem no pt-BR). O campo `translations`
   * é removido da resposta pública.
   */
  async listActive(locale?: string) {
    const rows = await this.prisma.announcement.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const lang = locale === 'en' || locale === 'es' ? locale : null;
    return rows.map(({ translations, ...a }) => {
      if (!lang) return a;
      const tr = (translations as Record<string, LocaleText> | null)?.[lang];
      if (!tr) return a;
      return {
        ...a,
        badge: tr.badge?.trim() || a.badge,
        title: tr.title?.trim() || a.title,
        description: tr.description?.trim() || a.description,
        ctaLabel: tr.ctaLabel?.trim() || a.ctaLabel,
      };
    });
  }

  async listAll() {
    return this.prisma.announcement.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async getById(id: string) {
    const found = await this.prisma.announcement.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Aviso não encontrado');
    return found;
  }

  async create(dto: CreateAnnouncementDto) {
    try {
      return await this.prisma.announcement.create({
        data: {
          slug: dto.slug,
          variant: dto.variant ?? null,
          badge: dto.badge ?? null,
          title: dto.title,
          description: dto.description,
          imageUrl: dto.imageUrl ?? null,
          ctaLabel: dto.ctaLabel ?? null,
          ctaAction: (dto.ctaAction as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
          translations: (dto.translations as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
          isActive: dto.isActive ?? true,
          sortOrder: dto.sortOrder ?? 0,
        },
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        throw new ConflictException('Já existe um aviso com esse slug');
      }
      throw err;
    }
  }

  async update(id: string, dto: UpdateAnnouncementDto) {
    await this.getById(id);

    const data: Prisma.AnnouncementUpdateInput = {};
    if (dto.variant !== undefined) data.variant = dto.variant;
    if (dto.badge !== undefined) data.badge = dto.badge;
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl;
    if (dto.ctaLabel !== undefined) data.ctaLabel = dto.ctaLabel;
    if (dto.ctaAction !== undefined) {
      data.ctaAction = (dto.ctaAction as Prisma.InputJsonValue | null) ?? Prisma.JsonNull;
    }
    if (dto.translations !== undefined) {
      data.translations = (dto.translations as Prisma.InputJsonValue | null) ?? Prisma.JsonNull;
    }
    if (dto.isActive !== undefined) data.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;

    return this.prisma.announcement.update({ where: { id }, data });
  }

  async toggle(id: string) {
    const current = await this.getById(id);
    return this.prisma.announcement.update({
      where: { id },
      data: { isActive: !current.isActive },
    });
  }

  async delete(id: string) {
    await this.getById(id);
    await this.prisma.announcement.delete({ where: { id } });
  }
}
