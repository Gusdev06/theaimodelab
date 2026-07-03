import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationStatus } from '@prisma/client';
import { GalleryFiltersDto } from './dto/gallery-filters.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { GalleryItemDto } from './dto/gallery-item.dto';
import { GalleryStatsResponseDto } from './dto/gallery-stats-response.dto';

@Injectable()
export class GalleryService {
  constructor(private readonly prisma: PrismaService) {}

  async getGallery(
    userId: string,
    filters: GalleryFiltersDto,
  ): Promise<PaginatedResponseDto<GalleryItemDto>> {
    const where: any = {
      userId,
      status: GenerationStatus.COMPLETED,
      isDeleted: false,
    };

    const types = filters.typeArray;
    if (types && types.length > 0) {
      where.type = types.length === 1 ? types[0] : { in: types };
    }
    if (filters.favorited === true) {
      where.isFavorited = true;
    }
    if (filters.folderId) {
      where.generationFolders = { some: { folderId: filters.folderId } };
    }

    const [generations, total] = await Promise.all([
      this.prisma.generation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filters.skip,
        take: filters.limit,
        select: {
          id: true,
          type: true,
          status: true,
          prompt: true,
          resolution: true,
          durationSeconds: true,
          hasAudio: true,
          hasWatermark: true,
          creditsConsumed: true,
          isFavorited: true,
          createdAt: true,
          completedAt: true,
          outputs: {
            select: { url: true, thumbnailUrl: true, blurDataUrl: true },
            orderBy: { order: 'asc' },
            take: 1,
          },
          _count: { select: { outputs: true } },
          generationFolders: {
            take: 1,
            select: {
              folder: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.generation.count({ where }),
    ]);

    const data: GalleryItemDto[] = generations.map((gen) => ({
      id: gen.id,
      type: gen.type,
      status: gen.status,
      prompt: gen.prompt ?? undefined,
      resolution: gen.resolution,
      durationSeconds: gen.durationSeconds ?? undefined,
      hasAudio: gen.hasAudio,
      hasWatermark: gen.hasWatermark,
      creditsConsumed: gen.creditsConsumed,
      isFavorited: gen.isFavorited,
      thumbnailUrl: gen.outputs[0]?.thumbnailUrl ?? undefined,
      blurDataUrl: gen.outputs[0]?.blurDataUrl ?? undefined,
      outputUrl: gen.outputs[0]?.url ?? undefined,
      outputCount: gen._count.outputs,
      folder: gen.generationFolders?.[0]?.folder ?? undefined,
      createdAt: gen.createdAt,
      completedAt: gen.completedAt ?? undefined,
    }));

    return new PaginatedResponseDto(data, total, filters.page, filters.limit);
  }

  async getStats(userId: string): Promise<GalleryStatsResponseDto> {
    const baseWhere = {
      userId,
      status: GenerationStatus.COMPLETED,
      isDeleted: false,
    };

    const [totalGenerations, creditsAgg, favoriteCount, typeCounts] =
      await Promise.all([
        this.prisma.generation.count({ where: baseWhere }),
        this.prisma.generation.aggregate({
          where: baseWhere,
          _sum: { creditsConsumed: true },
        }),
        this.prisma.generation.count({
          where: { ...baseWhere, isFavorited: true },
        }),
        this.prisma.generation.groupBy({
          by: ['type'],
          where: baseWhere,
          _count: true,
        }),
      ]);

    const generationsByType = {
      TEXT_TO_IMAGE: 0,
      IMAGE_TO_IMAGE: 0,
      TEXT_TO_VIDEO: 0,
      IMAGE_TO_VIDEO: 0,
      MOTION_CONTROL: 0,
    };

    for (const entry of typeCounts) {
      generationsByType[entry.type] = entry._count;
    }

    return {
      totalGenerations,
      totalCreditsUsed: creditsAgg._sum.creditsConsumed ?? 0,
      generationsByType,
      favoriteCount,
    };
  }
}
