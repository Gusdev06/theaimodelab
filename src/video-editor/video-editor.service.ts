import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { FfmpegService, ClipInput } from './ffmpeg.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AddClipDto } from './dto/add-clip.dto';
import { UpdateClipDto } from './dto/update-clip.dto';
import { ProjectResponseDto, ClipResponseDto } from './dto/project-response.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { VideoProjectStatus } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

@Injectable()
export class VideoEditorService {
  private readonly logger = new Logger(VideoEditorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  async createProject(
    userId: string,
    dto: CreateProjectDto,
  ): Promise<ProjectResponseDto> {
    const project = await this.prisma.videoProject.create({
      data: {
        userId,
        ...(dto.name && { name: dto.name }),
      },
      include: { clips: { orderBy: { order: 'asc' } } },
    });

    return this.toProjectResponse(project);
  }

  async listProjects(
    userId: string,
    pagination: PaginationDto,
  ): Promise<PaginatedResponseDto<ProjectResponseDto>> {
    const where = { userId };

    const [projects, total] = await Promise.all([
      this.prisma.videoProject.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: { clips: { orderBy: { order: 'asc' } } },
      }),
      this.prisma.videoProject.count({ where }),
    ]);

    const data = projects.map((p) => this.toProjectResponse(p));
    return new PaginatedResponseDto(data, total, pagination.page, pagination.limit);
  }

  async getProject(
    userId: string,
    projectId: string,
  ): Promise<ProjectResponseDto> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
      include: { clips: { orderBy: { order: 'asc' } } },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');

    return this.toProjectResponse(project);
  }

  async updateProject(
    userId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<ProjectResponseDto> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');

    const updated = await this.prisma.videoProject.update({
      where: { id: projectId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
      },
      include: { clips: { orderBy: { order: 'asc' } } },
    });

    return this.toProjectResponse(updated);
  }

  async deleteProject(userId: string, projectId: string): Promise<void> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');

    await this.prisma.videoProject.delete({ where: { id: projectId } });
  }

  async addClip(
    userId: string,
    projectId: string,
    dto: AddClipDto,
  ): Promise<ClipResponseDto> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');

    let order = dto.order;
    if (order == null) {
      const lastClip = await this.prisma.videoProjectClip.findFirst({
        where: { projectId },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      order = (lastClip?.order ?? -1) + 1;
    }

    const clip = await this.prisma.videoProjectClip.create({
      data: {
        projectId,
        sourceUrl: dto.sourceUrl,
        thumbnailUrl: dto.thumbnailUrl,
        order,
        startMs: dto.startMs ?? 0,
        endMs: dto.endMs,
        durationMs: dto.durationMs,
      },
    });

    return this.toClipResponse(clip);
  }

  async updateClip(
    userId: string,
    projectId: string,
    clipId: string,
    dto: UpdateClipDto,
  ): Promise<ClipResponseDto> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');

    const clip = await this.prisma.videoProjectClip.findFirst({
      where: { id: clipId, projectId },
    });

    if (!clip) throw new NotFoundException('Clip nao encontrado');

    const updated = await this.prisma.videoProjectClip.update({
      where: { id: clipId },
      data: {
        ...(dto.startMs !== undefined && { startMs: dto.startMs }),
        ...(dto.endMs !== undefined && { endMs: dto.endMs }),
      },
    });

    return this.toClipResponse(updated);
  }

  async deleteClip(
    userId: string,
    projectId: string,
    clipId: string,
  ): Promise<void> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');

    const clip = await this.prisma.videoProjectClip.findFirst({
      where: { id: clipId, projectId },
    });

    if (!clip) throw new NotFoundException('Clip nao encontrado');

    await this.prisma.videoProjectClip.delete({ where: { id: clipId } });
  }

  async reorderClips(
    userId: string,
    projectId: string,
    clipIds: string[],
  ): Promise<ProjectResponseDto> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');

    // Update order based on array index
    await this.prisma.$transaction(
      clipIds.map((clipId, index) =>
        this.prisma.videoProjectClip.update({
          where: { id: clipId },
          data: { order: index },
        }),
      ),
    );

    const updated = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
      include: { clips: { orderBy: { order: 'asc' } } },
    });

    return this.toProjectResponse(updated!);
  }

  async render(userId: string, projectId: string): Promise<ProjectResponseDto> {
    const project = await this.prisma.videoProject.findUnique({
      where: { id: projectId },
      include: { clips: { orderBy: { order: 'asc' } } },
    });

    if (!project) throw new NotFoundException('Projeto nao encontrado');
    if (project.userId !== userId) throw new ForbiddenException('Acesso negado');
    if (project.clips.length === 0) {
      throw new BadRequestException('Projeto nao possui clips');
    }
    if (project.status === VideoProjectStatus.PROCESSING) {
      throw new BadRequestException('Projeto ja esta sendo processado');
    }

    // Set status to PROCESSING
    const updated = await this.prisma.videoProject.update({
      where: { id: projectId },
      data: { status: VideoProjectStatus.PROCESSING, errorMessage: null },
      include: { clips: { orderBy: { order: 'asc' } } },
    });

    // Fire and forget
    this.processRender(projectId, updated.clips).catch((err) => {
      this.logger.error(`Render failed for project ${projectId}: ${err.message}`);
    });

    return this.toProjectResponse(updated);
  }

  private async processRender(
    projectId: string,
    clips: Array<{
      id: string;
      sourceUrl: string;
      startMs: number;
      endMs: number | null;
      durationMs: number;
    }>,
  ): Promise<void> {
    const tempDir = path.join('/tmp', `render-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const downloadedFiles: string[] = [];

    try {
      // Download all clips
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const ext = '.mp4';
        const filePath = path.join(tempDir, `clip-${i}${ext}`);

        this.logger.log(`Downloading clip ${i}: ${clip.sourceUrl}`);
        const response = await fetch(clip.sourceUrl);
        if (!response.ok) {
          throw new Error(`Failed to download clip ${i}: ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        downloadedFiles.push(filePath);
      }

      // Prepare clip inputs
      const clipInputs: ClipInput[] = clips.map((clip, i) => ({
        filePath: downloadedFiles[i],
        startMs: clip.startMs,
        endMs: clip.endMs ?? undefined,
      }));

      // Process with ffmpeg
      const outputPath = path.join(tempDir, 'output.mp4');
      await this.ffmpegService.trimAndConcat(clipInputs, outputPath);

      // Get duration
      const durationMs = await this.ffmpegService.getVideoDuration(outputPath);

      // Upload to S3
      const outputBuffer = fs.readFileSync(outputPath);
      const outputUrl = await this.uploadsService.uploadBuffer(
        outputBuffer,
        'video-editor',
        `render-${projectId}.mp4`,
        'video/mp4',
      );

      // Update project
      await this.prisma.videoProject.update({
        where: { id: projectId },
        data: {
          status: VideoProjectStatus.COMPLETED,
          outputUrl,
          durationMs,
        },
      });

      this.logger.log(`Render completed for project ${projectId}`);
    } catch (error) {
      this.logger.error(`Render error for project ${projectId}: ${(error as Error).message}`);

      await this.prisma.videoProject.update({
        where: { id: projectId },
        data: {
          status: VideoProjectStatus.FAILED,
          errorMessage: (error as Error).message,
        },
      });
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        this.logger.warn(`Failed to clean up temp dir ${tempDir}: ${(e as Error).message}`);
      }
    }
  }

  private toProjectResponse(project: any): ProjectResponseDto {
    return {
      id: project.id,
      name: project.name,
      status: project.status,
      outputUrl: project.outputUrl ?? undefined,
      outputThumbnailUrl: project.outputThumbnailUrl ?? undefined,
      durationMs: project.durationMs ?? undefined,
      errorMessage: project.errorMessage ?? undefined,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      clips: project.clips?.map((c: any) => this.toClipResponse(c)),
    };
  }

  private toClipResponse(clip: any): ClipResponseDto {
    return {
      id: clip.id,
      sourceUrl: clip.sourceUrl,
      thumbnailUrl: clip.thumbnailUrl ?? undefined,
      order: clip.order,
      startMs: clip.startMs,
      endMs: clip.endMs ?? undefined,
      durationMs: clip.durationMs,
      createdAt: clip.createdAt,
    };
  }
}
