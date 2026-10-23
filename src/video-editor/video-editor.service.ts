import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService, contentTypeOfKey } from '../uploads/uploads.service';
import { FfmpegService, ClipInput } from './ffmpeg.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { AddClipDto } from './dto/add-clip.dto';
import { UpdateClipDto } from './dto/update-clip.dto';
import { ProjectResponseDto, ClipResponseDto } from './dto/project-response.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { GenerationType, VideoProjectStatus } from '@prisma/client';
import { ImageSafetyService } from '../content-safety/image-safety/image-safety.service';
import type { RuledInputVerdict } from '../content-safety/image-safety/image-safety.rules';
import type { RequestContext } from '../content-safety/image-safety/types';
import { isUncensoredModel } from '../content-safety/content-safety.interceptor';
import {
  IMAGE_SAFETY_BLOCKED_MESSAGE,
  SAFETY_CHECK_UNAVAILABLE_MESSAGE,
} from '../generations/errors/failure-reason';
import {
  findOwnPromotedOutput,
  hiddenGenerationIds,
  type OwnPromotedOutput,
} from '../community/promoted-output';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

/**
 * Recusa do clipe: o mesmo código e o mesmo texto para URL externa, interna, de metadados de nuvem, de outra conta,
 * em revisão ou que não é vídeo (o motivo não vira oráculo).
 */
export const VIDEO_SOURCE_NOT_ALLOWED = 'VIDEO_SOURCE_NOT_ALLOWED';
export const VIDEO_SOURCE_NOT_ALLOWED_MESSAGE =
  'Escolha um vídeo gerado na sua conta.';
/** Falha técnica do render: o detalhe (caminho, status, provedor) fica só no log. */
export const RENDER_FAILED_MESSAGE =
  'Não foi possível montar o vídeo. Tente de novo.';

/** Teto de leitura de cada clipe no bucket (vídeo gerado fica bem abaixo disso). */
const CLIP_READ_MAX_BYTES = 250 * 1024 * 1024;
/** Prazo da checagem dos quadros do render (roda em segundo plano, não na requisição). */
const RENDER_CHECK_TIMEOUT_MS = 120_000;
/** Teto do texto dos pedidos de origem que vai para as regras (só pistas de pedido sexual). */
const SOURCE_PROMPTS_MAX_CHARS = 20_000;

const VIDEO_GENERATION_TYPES: ReadonlySet<GenerationType> = new Set([
  GenerationType.TEXT_TO_VIDEO,
  GenerationType.IMAGE_TO_VIDEO,
  GenerationType.MOTION_CONTROL,
  GenerationType.REFERENCE_VIDEO,
  GenerationType.SPOKEN_VIDEO,
  GenerationType.AVATAR_VIDEO,
]);

function sourceNotAllowed(): BadRequestException {
  return new BadRequestException({
    code: VIDEO_SOURCE_NOT_ALLOWED,
    message: VIDEO_SOURCE_NOT_ALLOWED_MESSAGE,
  });
}

/** O resultado é vídeo? Tipo gravado ou extensão da chave; sem nenhum dos dois, o tipo da geração decide. */
function isVideoOutput(output: OwnPromotedOutput): boolean {
  const declared = (output.mimeType ?? '').toLowerCase();
  if (declared.startsWith('video/')) return true;
  if (declared.startsWith('image/') || declared.startsWith('audio/')) {
    return false;
  }
  const byKey = contentTypeOfKey(output.location.key);
  if (byKey.startsWith('video/')) return true;
  if (byKey.startsWith('image/') || byKey.startsWith('audio/')) return false;
  return VIDEO_GENERATION_TYPES.has(output.generation.type);
}

@Injectable()
export class VideoEditorService {
  private readonly logger = new Logger(VideoEditorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
    private readonly ffmpegService: FfmpegService,
    /** checagem de imagem (global); ausente ou com IMAGE_SAFETY_MODE=off = render publicado sem checar, como antes */
    @Optional() private readonly imageSafety?: ImageSafetyService,
  ) {}

  /**
   * Fonte de um clipe: só saída promovida (pública, de geração concluída, fora de revisão) da PRÓPRIA conta e em vídeo.
   * Fecha o SSRF do TKT-050 e a CDN como hospedagem de vídeo externo. Vale em qualquer modo.
   */
  private async resolveSource(
    userId: string,
    sourceUrl: string,
  ): Promise<OwnPromotedOutput> {
    const output = await findOwnPromotedOutput(
      this.prisma,
      this.uploadsService,
      userId,
      sourceUrl,
    );
    if (!output || !isVideoOutput(output)) throw sourceNotAllowed();
    return output;
  }

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

    const source = await this.resolveSource(userId, dto.sourceUrl);

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
        sourceUrl: source.url,
        // miniatura do próprio resultado (a do site é ignorada: só vale mídia do nosso bucket)
        thumbnailUrl: source.thumbnailUrl,
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

    // só clipes deste projeto (antes, um id de clipe de outro projeto era reordenado também)
    const own = new Set(
      (
        await this.prisma.videoProjectClip.findMany({
          where: { projectId },
          select: { id: true },
        })
      ).map((clip) => clip.id),
    );
    if (clipIds.some((clipId) => !own.has(clipId))) {
      throw new BadRequestException('Clip nao pertence ao projeto');
    }

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

    // cada clipe é conferido de novo: clipe antigo pode ter URL livre e a geração pode ter ido para revisão depois
    const sources: OwnPromotedOutput[] = [];
    for (const clip of project.clips) {
      sources.push(await this.resolveSource(userId, clip.sourceUrl));
    }

    // Set status to PROCESSING
    const updated = await this.prisma.videoProject.update({
      where: { id: projectId },
      data: { status: VideoProjectStatus.PROCESSING, errorMessage: null },
      include: { clips: { orderBy: { order: 'asc' } } },
    });

    // Fire and forget
    this.processRender(projectId, userId, updated.clips, sources).catch(
      (err: Error) => {
        this.logger.error(
          `Render failed for project ${projectId}: ${err.message}`,
        );
      },
    );

    return this.toProjectResponse(updated);
  }

  /**
   * Monta o vídeo: lê cada clipe PELA CHAVE no bucket público (nunca por HTTP: sem SSRF), corta e junta com ffmpeg e,
   * com a checagem de imagem ligada, passa os quadros do render pela régua ANTES de gravar no público. Barrado ou sem
   * checagem = nada publicado e mensagem genérica no projeto (o motivo fica no registro da checagem).
   */
  private async processRender(
    projectId: string,
    userId: string,
    clips: Array<{
      id: string;
      sourceUrl: string;
      startMs: number;
      endMs: number | null;
      durationMs: number;
    }>,
    sources: OwnPromotedOutput[],
  ): Promise<void> {
    const tempDir = path.join(os.tmpdir(), `render-${randomUUID()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const downloadedFiles: string[] = [];

    try {
      if (sources.length !== clips.length) {
        throw new Error('clipes e fontes conferidas não batem');
      }
      // Read all clips from the public bucket
      for (let i = 0; i < clips.length; i++) {
        const filePath = path.join(tempDir, `clip-${i}.mp4`);
        const body = await this.uploadsService.readObject(
          'public',
          sources[i].location.key,
          CLIP_READ_MAX_BYTES,
        );
        fs.writeFileSync(filePath, body);
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

      const outputBuffer = fs.readFileSync(outputPath);
      const refusal = await this.checkRender(
        projectId,
        userId,
        outputBuffer,
        sources,
      );
      if (refusal) {
        await this.prisma.videoProject.update({
          where: { id: projectId },
          data: { status: VideoProjectStatus.FAILED, errorMessage: refusal },
        });
        return;
      }

      // Upload to S3 (só depois da checagem)
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
          errorMessage: RENDER_FAILED_MESSAGE,
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

  /**
   * Mensagem de recusa do render, ou null para publicar. Antes de publicar: nenhuma geração de origem pode ter ido para
   * revisão ou evidência durante o render (vale em qualquer modo). Com a checagem de imagem ligada, os quadros do vídeo
   * montado passam pela régua (checkInput, ferramenta video_editor: o render não tem geração, então o checkOutput, que
   * lê e segura uma geração, não se aplica). Vale o que AGE no modo (isRuleEnforced); erro na checagem conta como
   * indisponível. Com o modo off, nada é lido nem chamado.
   */
  private async checkRender(
    projectId: string,
    userId: string,
    video: Buffer,
    sources: OwnPromotedOutput[],
  ): Promise<string | null> {
    const hidden = await hiddenGenerationIds(
      this.prisma,
      sources.map((source) => source.generationId),
    );
    if (hidden.size > 0) {
      this.logger.warn(
        `[VIDEO_EDITOR] projeto ${projectId}: geração de origem foi para revisão durante o render — não publicado`,
      );
      return VIDEO_SOURCE_NOT_ALLOWED_MESSAGE;
    }
    const safety = this.imageSafety;
    if (!safety?.imageEnabled) return null;

    let verdict: Pick<
      RuledInputVerdict,
      'verdict' | 'ruleId' | 'strength' | 'cause'
    >;
    try {
      verdict = await safety.checkInput(
        [{ kind: 'video', mimeType: 'video/mp4', buffer: video }],
        this.renderContext(userId, sources),
        { timeoutMs: RENDER_CHECK_TIMEOUT_MS },
      );
    } catch (error) {
      this.logger.error(
        `[VIDEO_EDITOR] projeto ${projectId}: checagem do render falhou (${(error as Error).message?.slice(0, 200)})`,
      );
      verdict = {
        verdict: 'UNAVAILABLE',
        ruleId: 'UNAVAILABLE',
        strength: 'NONE',
      };
    }
    if (!safety.actsOn(verdict)) return null;
    this.logger.warn(
      `[VIDEO_EDITOR] projeto ${projectId}: render não publicado (${verdict.ruleId ?? 'sem-regra'}/${verdict.strength})`,
    );
    return verdict.verdict === 'UNAVAILABLE'
      ? SAFETY_CHECK_UNAVAILABLE_MESSAGE
      : IMAGE_SAFETY_BLOCKED_MESSAGE;
  }

  /**
   * Contexto das regras para o render, montado no servidor a partir das gerações de origem: modelo sem censura de
   * qualquer clipe torna o pedido sexual; os pedidos de origem entram só como pista de texto adulto.
   */
  private renderContext(
    userId: string,
    sources: OwnPromotedOutput[],
  ): Omit<RequestContext, 'surface'> {
    const models = sources.map((source) => source.generation.modelUsed);
    const prompts = [
      ...new Set(
        sources
          .map((source) => source.generation.prompt)
          .filter((prompt): prompt is string => !!prompt),
      ),
    ]
      .join('\n')
      .slice(0, SOURCE_PROMPTS_MAX_CHARS);
    return {
      userId,
      generationId: null,
      model:
        models.find((model) => isUncensoredModel(model)) ?? models[0] ?? null,
      tool: 'video_editor',
      type: sources[0]?.generation.type ?? null,
      hasUserMedia: true,
      sexual: { classifier: null, inputNudity: null },
      prompt: prompts || null,
      negativePrompt: null,
    };
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
