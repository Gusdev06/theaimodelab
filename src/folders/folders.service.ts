import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationStatus } from '@prisma/client';
import { CreateFolderDto } from './dto/create-folder.dto';
import { UpdateFolderDto } from './dto/update-folder.dto';
import { FolderResponseDto } from './dto/folder-response.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { GenerationResponseDto } from '../generations/dto/generation-response.dto';

@Injectable()
export class FoldersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    dto: CreateFolderDto,
  ): Promise<FolderResponseDto> {
    const folder = await this.prisma.folder.create({
      data: {
        userId,
        name: dto.name,
        description: dto.description,
      },
      include: {
        _count: { select: { generationFolders: true } },
      },
    });

    return {
      id: folder.id,
      name: folder.name,
      description: folder.description ?? undefined,
      generationCount: folder._count.generationFolders,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    };
  }

  async findAll(
    userId: string,
    pagination: PaginationDto,
  ): Promise<PaginatedResponseDto<FolderResponseDto>> {
    const where = { userId };

    const [folders, total] = await Promise.all([
      this.prisma.folder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          _count: { select: { generationFolders: true } },
        },
      }),
      this.prisma.folder.count({ where }),
    ]);

    const data: FolderResponseDto[] = folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
      description: folder.description ?? undefined,
      generationCount: folder._count.generationFolders,
      createdAt: folder.createdAt,
      updatedAt: folder.updatedAt,
    }));

    return new PaginatedResponseDto(
      data,
      total,
      pagination.page,
      pagination.limit,
    );
  }

  async findOne(
    userId: string,
    folderId: string,
    pagination: PaginationDto,
  ): Promise<{
    folder: FolderResponseDto;
    generations: PaginatedResponseDto<GenerationResponseDto>;
  }> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
      include: {
        _count: { select: { generationFolders: true } },
      },
    });

    if (!folder) {
      throw new NotFoundException('Pasta nao encontrada');
    }
    if (folder.userId !== userId) {
      throw new ForbiddenException('Acesso negado');
    }

    const generationWhere = {
      generationFolders: { some: { folderId } },
      status: GenerationStatus.COMPLETED,
      isDeleted: false,
    };

    const [generations, total] = await Promise.all([
      this.prisma.generation.findMany({
        where: generationWhere,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          outputs: { orderBy: { order: 'asc' } },
        },
      }),
      this.prisma.generation.count({ where: generationWhere }),
    ]);

    const generationData: GenerationResponseDto[] = generations.map((gen) => ({
      id: gen.id,
      type: gen.type,
      status: gen.status,
      prompt: gen.prompt ?? undefined,
      negativePrompt: gen.negativePrompt ?? undefined,
      resolution: gen.resolution,
      durationSeconds: gen.durationSeconds ?? undefined,
      hasAudio: gen.hasAudio,
      modelUsed: gen.modelUsed ?? undefined,
      parameters: (gen.parameters as Record<string, unknown>) ?? undefined,
      outputs: gen.outputs.map((o) => ({
        id: o.id,
        url: o.url,
        thumbnailUrl: o.thumbnailUrl ?? undefined,
        mimeType: o.mimeType ?? undefined,
        order: o.order,
      })),
      inputImages: [],
      hasWatermark: gen.hasWatermark,
      creditsConsumed: gen.creditsConsumed,
      processingTimeMs: gen.processingTimeMs ?? undefined,
      errorMessage: gen.errorMessage ?? undefined,
      errorCode: gen.errorCode ?? undefined,
      isFavorited: gen.isFavorited,
      createdAt: gen.createdAt,
      completedAt: gen.completedAt ?? undefined,
    }));

    return {
      folder: {
        id: folder.id,
        name: folder.name,
        description: folder.description ?? undefined,
        generationCount: folder._count.generationFolders,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      },
      generations: new PaginatedResponseDto(
        generationData,
        total,
        pagination.page,
        pagination.limit,
      ),
    };
  }

  async update(
    userId: string,
    folderId: string,
    dto: UpdateFolderDto,
  ): Promise<FolderResponseDto> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });

    if (!folder) {
      throw new NotFoundException('Pasta nao encontrada');
    }
    if (folder.userId !== userId) {
      throw new ForbiddenException('Acesso negado');
    }

    const updated = await this.prisma.folder.update({
      where: { id: folderId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
      },
      include: {
        _count: { select: { generationFolders: true } },
      },
    });

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description ?? undefined,
      generationCount: updated._count.generationFolders,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async remove(userId: string, folderId: string): Promise<void> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });

    if (!folder) {
      throw new NotFoundException('Pasta nao encontrada');
    }
    if (folder.userId !== userId) {
      throw new ForbiddenException('Acesso negado');
    }

    await this.prisma.folder.delete({ where: { id: folderId } });
  }

  async addGenerations(
    userId: string,
    folderId: string,
    generationIds: string[],
  ): Promise<{ added: number }> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });

    if (!folder) {
      throw new NotFoundException('Pasta nao encontrada');
    }
    if (folder.userId !== userId) {
      throw new ForbiddenException('Acesso negado');
    }

    // Verify all generations belong to the user
    const generations = await this.prisma.generation.findMany({
      where: {
        id: { in: generationIds },
        userId,
        isDeleted: false,
      },
      select: { id: true },
    });

    const validIds = generations.map((g) => g.id);

    // Use skipDuplicates to avoid errors on already-added generations
    const result = await this.prisma.generationFolder.createMany({
      data: validIds.map((generationId) => ({
        generationId,
        folderId,
      })),
      skipDuplicates: true,
    });

    return { added: result.count };
  }

  async removeGenerations(
    userId: string,
    folderId: string,
    generationIds: string[],
  ): Promise<{ removed: number }> {
    const folder = await this.prisma.folder.findUnique({
      where: { id: folderId },
    });

    if (!folder) {
      throw new NotFoundException('Pasta nao encontrada');
    }
    if (folder.userId !== userId) {
      throw new ForbiddenException('Acesso negado');
    }

    const result = await this.prisma.generationFolder.deleteMany({
      where: {
        folderId,
        generationId: { in: generationIds },
      },
    });

    return { removed: result.count };
  }
}
