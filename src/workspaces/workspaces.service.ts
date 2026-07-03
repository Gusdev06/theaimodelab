import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Workspace } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

/** Campos leves retornados na listagem (sem o JSON do canvas). */
const SUMMARY_SELECT = {
  id: true,
  name: true,
  thumbnailUrl: true,
  favorite: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkspaceSelect;

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

  async list(userId: string) {
    return this.prisma.workspace.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: SUMMARY_SELECT,
    });
  }

  async create(userId: string, dto: CreateWorkspaceDto): Promise<Workspace> {
    return this.prisma.workspace.create({
      data: {
        userId,
        ...(dto.name && { name: dto.name }),
        ...(dto.nodes && { nodes: dto.nodes as Prisma.InputJsonValue }),
        ...(dto.edges && { edges: dto.edges as Prisma.InputJsonValue }),
        ...(dto.viewport && {
          viewport: dto.viewport as Prisma.InputJsonValue,
        }),
      },
    });
  }

  async get(userId: string, workspaceId: string): Promise<Workspace> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });

    if (!workspace) throw new NotFoundException('Workspace nao encontrado');
    if (workspace.userId !== userId)
      throw new ForbiddenException('Acesso negado');

    return workspace;
  }

  /**
   * O front envia a thumbnail como data URL; sobe pro R2 e devolve a URL
   * pública (mantém a listagem leve). Retorna null se a conversão falhar.
   */
  private async storeThumbnail(
    workspaceId: string,
    dataUrl: string,
  ): Promise<string | null> {
    const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) return null;
    const [, contentType, base64] = match;
    const buffer = Buffer.from(base64, 'base64');
    const ext = contentType === 'image/png' ? 'png' : 'jpg';
    const folder = `workspaces/${workspaceId}/thumb`;

    try {
      // remove o snapshot anterior para não acumular órfãos no bucket
      await this.uploadsService.deleteByPrefix(folder);
    } catch (error) {
      this.logger.warn(
        `Falha ao limpar thumbnail antiga do workspace ${workspaceId}: ${String(error)}`,
      );
    }

    try {
      return await this.uploadsService.uploadBuffer(
        buffer,
        folder,
        `thumbnail.${ext}`,
        contentType,
      );
    } catch (error) {
      this.logger.warn(
        `Falha ao subir thumbnail do workspace ${workspaceId}: ${String(error)}`,
      );
      return null;
    }
  }

  async update(
    userId: string,
    workspaceId: string,
    dto: UpdateWorkspaceDto,
  ): Promise<Workspace> {
    await this.get(userId, workspaceId);

    let thumbnailUrl = dto.thumbnailUrl;
    if (thumbnailUrl?.startsWith('data:')) {
      thumbnailUrl =
        (await this.storeThumbnail(workspaceId, thumbnailUrl)) ?? undefined;
    }

    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.favorite !== undefined && { favorite: dto.favorite }),
        ...(dto.nodes !== undefined && {
          nodes: dto.nodes as Prisma.InputJsonValue,
        }),
        ...(dto.edges !== undefined && {
          edges: dto.edges as Prisma.InputJsonValue,
        }),
        ...(dto.viewport !== undefined && {
          viewport: dto.viewport as Prisma.InputJsonValue,
        }),
        ...(thumbnailUrl !== undefined && { thumbnailUrl }),
      },
    });
  }

  async remove(userId: string, workspaceId: string): Promise<void> {
    await this.get(userId, workspaceId);
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
  }
}
