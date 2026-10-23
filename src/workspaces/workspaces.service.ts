import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, Workspace } from '@prisma/client';
import * as sharp from 'sharp';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { ImageSafetyService } from '../content-safety/image-safety/image-safety.service';
import type { RuledInputVerdict } from '../content-safety/image-safety/image-safety.rules';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

/**
 * Miniatura do quadro (passo 22 da segurança de geração). O site manda um JPEG do canvas em data URL; o canvas não
 * guarda as gerações (o estado de cada painel fica no navegador), então não há saída promovida de onde gerar a
 * miniatura no servidor sem trocar o que o card mostra. Por isso a miniatura continua vindo do site, mas:
 *  - só JPEG, PNG ou WebP pequeno, refeito no servidor como JPEG até 960 px e sem metadados (SVG, GIF e o resto saem;
 *    a CDN deixa de servir arquivo arbitrário do navegador). Vale em qualquer modo;
 *  - com a checagem de imagem ligada, o JPEG refeito passa pelo checkInput antes de ir ao público: o que age não é
 *    publicado (indisponível mantém a miniatura anterior; barrado também apaga a anterior);
 *  - qualquer valor que não seja data URL (URL externa, interna, de outra conta) é ignorado.
 * Nada disso derruba o autosave: miniatura recusada só não é gravada.
 */
const THUMBNAIL_DATA_URL =
  /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;
/** Teto do arquivo decodificado (o JPEG do site tem dezenas de KB). */
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_MAX_BASE64_CHARS = Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4;
const THUMBNAIL_MAX_EDGE = 960;
const THUMBNAIL_MAX_INPUT_PIXELS = 4096 * 4096;
const THUMBNAIL_JPEG_QUALITY = 75;
/** Intervalo mínimo entre miniaturas checadas do mesmo quadro (só com a checagem ligada). */
export const THUMBNAIL_CHECK_INTERVAL_MS = 2 * 60_000;
const THUMBNAIL_CHECK_TRACKED_MAX = 10_000;

type ThumbnailOutcome =
  | { kind: 'stored'; url: string }
  /** barrado pela checagem: a miniatura anterior sai e o campo fica vazio */
  | { kind: 'cleared' }
  /** nada muda (formato recusado, falha técnica, checagem indisponível) */
  | { kind: 'skip' };

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
  /** Última miniatura checada por quadro (só com a checagem ligada; memória do processo). */
  private readonly lastThumbnailCheck = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
    /** checagem de imagem (global); ausente ou com IMAGE_SAFETY_MODE=off = miniatura refeita e publicada sem checar */
    @Optional() private readonly imageSafety?: ImageSafetyService,
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
   * Com a checagem ligada, no máximo uma miniatura checada por quadro a cada THUMBNAIL_CHECK_INTERVAL_MS (o autosave
   * manda uma a cada mudança do canvas e cada checagem é paga); a do meio é ignorada e o card fica com a anterior.
   */
  private thumbnailThrottled(workspaceId: string): boolean {
    const now = Date.now();
    const last = this.lastThumbnailCheck.get(workspaceId);
    if (last !== undefined && now - last < THUMBNAIL_CHECK_INTERVAL_MS) {
      return true;
    }
    if (this.lastThumbnailCheck.size >= THUMBNAIL_CHECK_TRACKED_MAX) {
      // o mais antigo sai primeiro (Map guarda a ordem de inserção)
      const oldest = this.lastThumbnailCheck.keys().next().value;
      if (oldest !== undefined) this.lastThumbnailCheck.delete(oldest);
    }
    this.lastThumbnailCheck.delete(workspaceId);
    this.lastThumbnailCheck.set(workspaceId, now);
    return false;
  }

  /** JPEG refeito a partir do data URL do site; null quando o formato, o tamanho ou a imagem não servem. */
  private async normalizeThumbnail(dataUrl: string): Promise<Buffer | null> {
    if (dataUrl.length > THUMBNAIL_MAX_BASE64_CHARS + 64) return null;
    const match = THUMBNAIL_DATA_URL.exec(dataUrl);
    if (!match) return null;
    const decoded = Buffer.from(match[2], 'base64');
    if (decoded.length === 0 || decoded.length > THUMBNAIL_MAX_BYTES) {
      return null;
    }
    try {
      // sem withMetadata: EXIF, perfil e qualquer carga extra ficam de fora
      return await sharp(decoded, {
        limitInputPixels: THUMBNAIL_MAX_INPUT_PIXELS,
        failOn: 'error',
      })
        .rotate()
        .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: THUMBNAIL_JPEG_QUALITY })
        .toBuffer();
    } catch {
      return null;
    }
  }

  /** Checagem da miniatura (modo ligado): o veredito que age, ou null para publicar. Erro conta como indisponível. */
  private async thumbnailRefusal(
    userId: string,
    workspaceId: string,
    jpeg: Buffer,
  ): Promise<Pick<
    RuledInputVerdict,
    'verdict' | 'ruleId' | 'strength'
  > | null> {
    const safety = this.imageSafety;
    if (!safety?.imageEnabled) return null;
    let verdict: Pick<
      RuledInputVerdict,
      'verdict' | 'ruleId' | 'strength' | 'cause'
    >;
    try {
      verdict = await safety.checkInput(
        [{ kind: 'image', mimeType: 'image/jpeg', buffer: jpeg }],
        {
          userId,
          generationId: null,
          model: null,
          tool: 'generate',
          type: null,
          hasUserMedia: true,
          sexual: { classifier: null, inputNudity: null },
          prompt: null,
          negativePrompt: null,
        },
      );
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] miniatura do workspace ${workspaceId}: checagem falhou (${(error as Error).message?.slice(0, 200)})`,
      );
      verdict = {
        verdict: 'UNAVAILABLE',
        ruleId: 'UNAVAILABLE',
        strength: 'NONE',
      };
    }
    return safety.actsOn(verdict) ? verdict : null;
  }

  private async clearThumbnailFolder(
    workspaceId: string,
    folder: string,
  ): Promise<void> {
    try {
      // remove o snapshot anterior para não acumular órfãos no bucket
      await this.uploadsService.deleteByPrefix(`${folder}/`);
    } catch (error) {
      this.logger.warn(
        `Falha ao limpar thumbnail antiga do workspace ${workspaceId}: ${String(error)}`,
      );
    }
  }

  /**
   * O front envia a thumbnail como data URL: refeita no servidor, checada quando a checagem está ligada e só então
   * gravada no público (mantém a listagem leve). Nunca lança.
   */
  private async storeThumbnail(
    userId: string,
    workspaceId: string,
    dataUrl: string,
  ): Promise<ThumbnailOutcome> {
    if (
      this.imageSafety?.imageEnabled &&
      this.thumbnailThrottled(workspaceId)
    ) {
      return { kind: 'skip' };
    }
    const jpeg = await this.normalizeThumbnail(dataUrl);
    if (!jpeg) {
      this.logger.warn(
        `Thumbnail do workspace ${workspaceId} recusada (formato ou tamanho)`,
      );
      return { kind: 'skip' };
    }
    const folder = `workspaces/${workspaceId}/thumb`;

    const refusal = await this.thumbnailRefusal(userId, workspaceId, jpeg);
    if (refusal) {
      this.logger.warn(
        `[IMAGE_SAFETY] miniatura do workspace ${workspaceId} não publicada (${refusal.ruleId ?? 'sem-regra'}/${refusal.strength})`,
      );
      if (refusal.verdict === 'UNAVAILABLE') return { kind: 'skip' };
      await this.clearThumbnailFolder(workspaceId, folder);
      return { kind: 'cleared' };
    }

    await this.clearThumbnailFolder(workspaceId, folder);
    try {
      const url = await this.uploadsService.uploadBuffer(
        jpeg,
        folder,
        'thumbnail.jpg',
        'image/jpeg',
      );
      return { kind: 'stored', url };
    } catch (error) {
      this.logger.warn(
        `Falha ao subir thumbnail do workspace ${workspaceId}: ${String(error)}`,
      );
      return { kind: 'skip' };
    }
  }

  async update(
    userId: string,
    workspaceId: string,
    dto: UpdateWorkspaceDto,
  ): Promise<Workspace> {
    await this.get(userId, workspaceId);

    // undefined = não mexe; null = apaga (miniatura barrada). Só data URL vira miniatura.
    let thumbnailUrl: string | null | undefined;
    if (dto.thumbnailUrl?.startsWith('data:')) {
      const outcome = await this.storeThumbnail(
        userId,
        workspaceId,
        dto.thumbnailUrl,
      );
      thumbnailUrl =
        outcome.kind === 'stored'
          ? outcome.url
          : outcome.kind === 'cleared'
            ? null
            : undefined;
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
