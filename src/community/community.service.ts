import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CommunityPostStatus,
  Prisma,
  type CommunityPost,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadsService } from '../uploads/uploads.service';
import { ImageSafetyService } from '../content-safety/image-safety/image-safety.service';
import type { RuledInputVerdict } from '../content-safety/image-safety/image-safety.rules';
import { ErrorCodes } from '../common/constants/error-codes';
import { LEGAL_HOLD_POST_REJECTION_REASON } from '../users/account-erasure.service';
import { SAFETY_SUSPENSION_POST_REJECTION_REASON } from '../content-safety/strikes/strikes.types';
import { SubmitCommunityPostDto } from './dto/community.dto';
import {
  heldGenerationIdsWithApprovedPosts,
  hiddenGenerationIds,
  publicLocationOf,
} from './promoted-output';

function kindOf(type: string): 'image' | 'video' | null {
  const t = type.toUpperCase();
  if (t.includes('VIDEO') || t.includes('MOTION')) return 'video';
  if (t.includes('SPEECH') || t.includes('VOICE') || t.includes('AUDIO'))
    return null;
  return 'image';
}

/** Recusa do envio: o mesmo texto para mídia fora do bucket público, geração em revisão ou em evidência. */
export const COMMUNITY_MEDIA_NOT_ALLOWED = 'COMMUNITY_MEDIA_NOT_ALLOWED';
const COMMUNITY_MEDIA_NOT_ALLOWED_MESSAGE =
  'Esta mídia não pode ser publicada na comunidade.';
/** Post de geração em revisão de segurança ou sob guarda legal: o admin não aprova, não rejeita de novo nem apaga. */
export const COMMUNITY_POST_UNDER_REVIEW = 'COMMUNITY_POST_UNDER_REVIEW';

/**
 * Marcadores do que a comunidade devolve com mídia:
 *  - `safetyHold`: geração em revisão de segurança ou em evidência; a URL da mídia NUNCA vai junto (null);
 *  - `mediaBlurred` (lista do admin): a tela de aprovação mostra borrado por padrão.
 */
export type SafetyMarkedPost<T> = Omit<T, 'mediaUrl' | 'thumbnailUrl'> & {
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  safetyHold: boolean;
};

function heldPostConflict(): ConflictException {
  return new ConflictException({
    code: COMMUNITY_POST_UNDER_REVIEW,
    message:
      'Esta publicação está em revisão de segurança ou sob guarda legal e não pode ser alterada.',
  });
}

function markPost<T extends Pick<CommunityPost, 'mediaUrl' | 'thumbnailUrl'>>(
  post: T,
  hidden: boolean,
): SafetyMarkedPost<T> {
  return hidden
    ? { ...post, mediaUrl: null, thumbnailUrl: null, safetyHold: true }
    : { ...post, safetyHold: false };
}

@Injectable()
export class CommunityService {
  private readonly logger = new Logger(CommunityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly uploads: UploadsService,
    /** checagem de imagem (global); ausente ou com IMAGE_SAFETY_MODE=off = post do admin sem checagem, como antes */
    @Optional() private readonly imageSafety?: ImageSafetyService,
  ) {}

  /** A geração do post está em revisão de segurança ou em evidência? Post sem geração (do admin) nunca está. */
  private async isHidden(generationId: string | null): Promise<boolean> {
    if (!generationId) return false;
    return (await hiddenGenerationIds(this.prisma, [generationId])).has(
      generationId,
    );
  }

  /**
   * Filtro dos posts aprovados que podem aparecer: sem geração ou com a geração fora de revisão e de evidência. Lido a
   * cada consulta, então o post sai do feed na hora em que a geração vira IN_REVIEW ou ganha evento de evidência, e
   * volta se o revisor liberar. Lido pelo lado pequeno (casos em aberto), não varrendo todos os posts aprovados; o
   * status raro fora de COMPLETED é conferido na página (visiblePage).
   */
  private async visibleApprovedWhere(scope: {
    userId?: string;
  }): Promise<Prisma.CommunityPostWhereInput> {
    const base: Prisma.CommunityPostWhereInput = {
      ...scope,
      status: CommunityPostStatus.APPROVED,
    };
    const hidden = await heldGenerationIdsWithApprovedPosts(this.prisma, base);
    if (hidden.size === 0) return base;
    // NOT IN sozinho também tiraria os posts sem geração (NULL não passa no NOT IN): por isso o OR
    return {
      ...base,
      OR: [{ generationId: null }, { generationId: { notIn: [...hidden] } }],
    };
  }

  /**
   * Conferência da página já lida: tira o post cuja geração saiu de COMPLETED por outro caminho (raro; o filtro do
   * banco só cobre evento em aberto e IN_REVIEW). Custa uma leitura do tamanho da página; a página sai menor e o total
   * não muda (melhor faltar um item que mostrar mídia escondida).
   */
  private async visiblePage<T extends { generationId: string | null }>(
    posts: T[],
  ): Promise<T[]> {
    const hidden = await hiddenGenerationIds(
      this.prisma,
      posts.map((post) => post.generationId),
    );
    if (hidden.size === 0) return posts;
    return posts.filter(
      (post) => !post.generationId || !hidden.has(post.generationId),
    );
  }

  /** Envia uma geração para aprovação na comunidade. */
  async submit(userId: string, dto: SubmitCommunityPostDto) {
    const generation = await this.prisma.generation.findUnique({
      where: { id: dto.generationId },
      include: { outputs: { orderBy: { order: 'asc' } } },
    });

    if (!generation || generation.isDeleted)
      throw new NotFoundException('Geracao nao encontrada');
    if (generation.userId !== userId)
      throw new ForbiddenException('Acesso negado');
    if (generation.status !== 'COMPLETED')
      throw new BadRequestException('A geracao ainda nao foi concluida');

    const kind = kindOf(generation.type);
    if (!kind)
      throw new BadRequestException(
        'Apenas imagens e videos podem ser publicados na comunidade',
      );

    const output = dto.outputUrl
      ? generation.outputs.find((o) => o.url === dto.outputUrl)
      : generation.outputs[0];
    if (!output) throw new BadRequestException('Geracao sem midia disponivel');

    // só saída promovida: no bucket público e com a geração fora de revisão e de evidência (vale em qualquer modo)
    if (
      !publicLocationOf(this.uploads, output.url) ||
      (await this.isHidden(generation.id))
    ) {
      throw new BadRequestException({
        code: COMMUNITY_MEDIA_NOT_ALLOWED,
        message: COMMUNITY_MEDIA_NOT_ALLOWED_MESSAGE,
      });
    }
    const thumbnailUrl = publicLocationOf(this.uploads, output.thumbnailUrl)
      ? output.thumbnailUrl
      : null;

    // evita reenvio do mesmo conteúdo enquanto pendente/aprovado
    const existing = await this.prisma.communityPost.findFirst({
      where: {
        generationId: generation.id,
        mediaUrl: output.url,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (existing)
      throw new BadRequestException(
        'Este conteudo ja foi enviado para a comunidade',
      );

    const params = (generation.parameters ?? {}) as Record<string, unknown>;
    const settings = [
      generation.aspectRatio ?? (params.aspect_ratio as string | undefined),
      generation.modelUsed,
    ].filter(Boolean);

    const post = await this.prisma.communityPost.create({
      data: {
        userId,
        generationId: generation.id,
        kind,
        mediaUrl: output.url,
        thumbnailUrl,
        prompt: generation.prompt ?? '',
        settings: settings as Prisma.InputJsonValue,
      },
    });

    await this.notifications.create(userId, 'community-submitted', {
      postId: post.id,
    });

    return post;
  }

  /** Feed público (posts aprovados) com likedByMe. Post de geração em revisão ou evidência não aparece. */
  async feed(userId: string, page = 1, limit = 30) {
    const where = await this.visibleApprovedWhere({});
    const [pagePosts, total] = await Promise.all([
      this.prisma.communityPost.findMany({
        where,
        orderBy: { approvedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { name: true, avatarUrl: true } } },
      }),
      this.prisma.communityPost.count({ where }),
    ]);
    const posts = await this.visiblePage(pagePosts);

    const likedIds = new Set(
      (
        await this.prisma.communityPostLike.findMany({
          where: { userId, postId: { in: posts.map((p) => p.id) } },
          select: { postId: true },
        })
      ).map((l) => l.postId),
    );

    // de quais autores o usuário atual já é seguidor
    const authorIds = [...new Set(posts.map((p) => p.userId))];
    const followingIds = new Set(
      (
        await this.prisma.userFollow.findMany({
          where: { followerId: userId, followingId: { in: authorIds } },
          select: { followingId: true },
        })
      ).map((f) => f.followingId),
    );

    return {
      data: posts.map((p) => ({
        id: p.id,
        kind: p.kind,
        mediaUrl: p.mediaUrl,
        thumbnailUrl: p.thumbnailUrl,
        prompt: p.prompt,
        settings: p.settings,
        likesCount: p.likesCount,
        likedByMe: likedIds.has(p.id),
        createdAt: p.createdAt,
        author: {
          id: p.userId,
          name: p.user.name,
          avatarUrl: p.user.avatarUrl,
          isFollowing: followingIds.has(p.userId),
          isMe: p.userId === userId,
        },
      })),
      meta: { page, limit, total },
    };
  }

  async follow(followerId: string, followingId: string) {
    if (followerId === followingId)
      throw new BadRequestException('Voce nao pode seguir a si mesmo');

    const target = await this.prisma.user.findUnique({
      where: { id: followingId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('Usuario nao encontrado');

    try {
      await this.prisma.userFollow.create({ data: { followerId, followingId } });
      const follower = await this.prisma.user.findUnique({
        where: { id: followerId },
        select: { name: true },
      });
      await this.notifications.create(followingId, 'user-followed', {
        followerId,
        followerName: follower?.name ?? '',
      });
    } catch (error) {
      // já segue (unique) — idempotente
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { following: true };
      }
      throw error;
    }
    return { following: true };
  }

  async unfollow(followerId: string, followingId: string) {
    await this.prisma.userFollow.deleteMany({
      where: { followerId, followingId },
    });
    return { following: false };
  }

  /** Seguidores e seguindo de um usuário. */
  async followStats(userId: string) {
    const [followers, following] = await Promise.all([
      this.prisma.userFollow.count({ where: { followingId: userId } }),
      this.prisma.userFollow.count({ where: { followerId: userId } }),
    ]);
    return { followers, following };
  }

  /** Marca, para cada usuário da lista, se o usuário atual já o segue. */
  private async markFollowing(
    userId: string,
    users: { id: string; name: string; avatarUrl: string | null }[],
  ) {
    const ids = users.map((u) => u.id);
    const iFollow = new Set(
      (
        await this.prisma.userFollow.findMany({
          where: { followerId: userId, followingId: { in: ids } },
          select: { followingId: true },
        })
      ).map((f) => f.followingId),
    );
    return users.map((u) => ({
      ...u,
      isFollowing: iFollow.has(u.id),
      isMe: u.id === userId,
    }));
  }

  /** Quem segue o usuário. */
  async listFollowers(userId: string) {
    const rows = await this.prisma.userFollow.findMany({
      where: { followingId: userId },
      orderBy: { createdAt: 'desc' },
      include: { follower: { select: { id: true, name: true, avatarUrl: true } } },
    });
    return this.markFollowing(
      userId,
      rows.map((r) => r.follower),
    );
  }

  /** Quem o usuário segue. */
  async listFollowing(userId: string) {
    const rows = await this.prisma.userFollow.findMany({
      where: { followerId: userId },
      orderBy: { createdAt: 'desc' },
      include: { following: { select: { id: true, name: true, avatarUrl: true } } },
    });
    return this.markFollowing(
      userId,
      rows.map((r) => r.following),
    );
  }

  /** Um post aprovado (para link compartilhado). */
  async getPost(viewerId: string, postId: string) {
    const p = await this.prisma.communityPost.findUnique({
      where: { id: postId },
      include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    });
    if (!p || p.status !== 'APPROVED' || (await this.isHidden(p.generationId)))
      throw new NotFoundException('Publicacao nao encontrada');

    const [liked, follow] = await Promise.all([
      this.prisma.communityPostLike.findUnique({
        where: { postId_userId: { postId, userId: viewerId } },
        select: { id: true },
      }),
      viewerId === p.userId
        ? Promise.resolve(null)
        : this.prisma.userFollow.findFirst({
            where: { followerId: viewerId, followingId: p.userId },
            select: { id: true },
          }),
    ]);

    return {
      id: p.id,
      kind: p.kind,
      mediaUrl: p.mediaUrl,
      thumbnailUrl: p.thumbnailUrl,
      prompt: p.prompt,
      settings: p.settings,
      likesCount: p.likesCount,
      likedByMe: !!liked,
      createdAt: p.createdAt,
      author: {
        id: p.user.id,
        name: p.user.name,
        avatarUrl: p.user.avatarUrl,
        isFollowing: !!follow,
        isMe: viewerId === p.userId,
      },
    };
  }

  /** Perfil público de um usuário (contadores + se o visitante o segue). */
  async publicProfile(viewerId: string, targetId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, avatarUrl: true },
    });
    if (!user) throw new NotFoundException('Usuario nao encontrado');

    const visible = await this.visibleApprovedWhere({ userId: targetId });
    const [followers, following, postsCount, follow] = await Promise.all([
      this.prisma.userFollow.count({ where: { followingId: targetId } }),
      this.prisma.userFollow.count({ where: { followerId: targetId } }),
      this.prisma.communityPost.count({ where: visible }),
      viewerId === targetId
        ? Promise.resolve(null)
        : this.prisma.userFollow.findFirst({
            where: { followerId: viewerId, followingId: targetId },
            select: { id: true },
          }),
    ]);

    return {
      id: user.id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      followers,
      following,
      postsCount,
      isFollowing: !!follow,
      isMe: viewerId === targetId,
    };
  }

  /** Publicações aprovadas de um usuário (mesmo formato do feed). */
  async userPosts(viewerId: string, targetId: string, page = 1, limit = 30) {
    const where = await this.visibleApprovedWhere({ userId: targetId });
    const [pagePosts, total, author, isFollowing] = await Promise.all([
      this.prisma.communityPost.findMany({
        where,
        orderBy: { approvedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.communityPost.count({ where }),
      this.prisma.user.findUnique({
        where: { id: targetId },
        select: { name: true, avatarUrl: true },
      }),
      viewerId === targetId
        ? Promise.resolve(false)
        : this.prisma.userFollow
            .findFirst({
              where: { followerId: viewerId, followingId: targetId },
              select: { id: true },
            })
            .then(Boolean),
    ]);
    const posts = await this.visiblePage(pagePosts);

    const likedIds = new Set(
      (
        await this.prisma.communityPostLike.findMany({
          where: { userId: viewerId, postId: { in: posts.map((p) => p.id) } },
          select: { postId: true },
        })
      ).map((l) => l.postId),
    );

    return {
      data: posts.map((p) => ({
        id: p.id,
        kind: p.kind,
        mediaUrl: p.mediaUrl,
        thumbnailUrl: p.thumbnailUrl,
        prompt: p.prompt,
        settings: p.settings,
        likesCount: p.likesCount,
        likedByMe: likedIds.has(p.id),
        createdAt: p.createdAt,
        author: {
          id: targetId,
          name: author?.name ?? '',
          avatarUrl: author?.avatarUrl ?? null,
          isFollowing,
          isMe: viewerId === targetId,
        },
      })),
      meta: { page, limit, total },
    };
  }

  /** Posts do próprio usuário (com status/motivo). Geração em revisão ou evidência: o post vem sem a mídia. */
  async mine(userId: string) {
    const posts = await this.prisma.communityPost.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    const hidden = await hiddenGenerationIds(
      this.prisma,
      posts.map((post) => post.generationId),
    );
    return posts.map((post) =>
      markPost(post, !!post.generationId && hidden.has(post.generationId)),
    );
  }

  async like(userId: string, postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (
      !post ||
      post.status !== 'APPROVED' ||
      (await this.isHidden(post.generationId))
    )
      throw new NotFoundException('Post nao encontrado');

    try {
      await this.prisma.$transaction([
        this.prisma.communityPostLike.create({ data: { postId, userId } }),
        this.prisma.communityPost.update({
          where: { id: postId },
          data: { likesCount: { increment: 1 } },
        }),
      ]);
    } catch (error) {
      // like duplicado (unique post+user) — idempotente
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { liked: true, likesCount: post.likesCount };
      }
      throw error;
    }

    return { liked: true, likesCount: post.likesCount + 1 };
  }

  async unlike(userId: string, postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post nao encontrado');

    const { count } = await this.prisma.communityPostLike.deleteMany({
      where: { postId, userId },
    });
    if (count > 0) {
      await this.prisma.communityPost.update({
        where: { id: postId },
        data: { likesCount: { decrement: 1 } },
      });
    }
    return { liked: false, likesCount: Math.max(0, post.likesCount - count) };
  }

  // ─── Admin ──────────────────────────────────────────────────────────────────

  /**
   * Fila de aprovação: toda mídia vem com `mediaBlurred: true` (a tela borra por padrão) e o `blurDataUrl` do resultado
   * quando houver; post de geração em revisão ou evidência vem com `safetyHold: true` e SEM URL nenhuma.
   */
  async adminList(
    status: CommunityPostStatus = 'PENDING',
    page = 1,
    limit = 30,
  ) {
    const where = { status };
    const [posts, total] = await Promise.all([
      this.prisma.communityPost.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      this.prisma.communityPost.count({ where }),
    ]);
    const hidden = await hiddenGenerationIds(
      this.prisma,
      posts.map((post) => post.generationId),
    );
    const isHidden = (post: CommunityPost) =>
      !!post.generationId && hidden.has(post.generationId);
    const blurs = await this.blurDataUrls(
      posts.filter((post) => !isHidden(post)),
    );
    const data = posts.map((post) => {
      const held = isHidden(post);
      return {
        ...markPost(post, held),
        mediaBlurred: true,
        blurDataUrl: held
          ? null
          : (blurs.get(`${post.generationId}\n${post.mediaUrl}`) ?? null),
      };
    });
    return { data, meta: { page, limit, total } };
  }

  /** Placeholder borrado de cada resultado (generation_outputs.blur_data_url), por geração e URL. */
  private async blurDataUrls(
    posts: Array<Pick<CommunityPost, 'generationId'>>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        posts
          .map((post) => post.generationId)
          .filter((id): id is string => !!id),
      ),
    ];
    const blurs = new Map<string, string>();
    if (ids.length === 0) return blurs;
    const outputs = await this.prisma.generationOutput.findMany({
      where: { generationId: { in: ids }, blurDataUrl: { not: null } },
      select: { generationId: true, url: true, blurDataUrl: true },
    });
    for (const output of outputs) {
      if (output.blurDataUrl) {
        blurs.set(`${output.generationId}\n${output.url}`, output.blurDataUrl);
      }
    }
    return blurs;
  }

  /**
   * Post de geração em revisão ou evidência, tirado do ar pela guarda legal ou pela suspensão da conta (enquanto ela
   * estiver suspensa): o admin não mexe.
   */
  private async assertNotHeld(
    post: Pick<CommunityPost, 'userId' | 'generationId' | 'rejectionReason'>,
  ): Promise<void> {
    if (
      post.rejectionReason === LEGAL_HOLD_POST_REJECTION_REASON ||
      (await this.heldBySuspension(post)) ||
      (await this.isHidden(post.generationId))
    ) {
      throw heldPostConflict();
    }
  }

  /**
   * Tirado do ar pela suspensão (camada 6) e a conta ainda inativa: não volta ao feed, não sai da trilha nem perde o
   * motivo antes da revisão. Reativada a conta, o admin decide o post como qualquer outro.
   */
  private async heldBySuspension(
    post: Pick<CommunityPost, 'userId' | 'rejectionReason'>,
  ): Promise<boolean> {
    if (post.rejectionReason !== SAFETY_SUSPENSION_POST_REJECTION_REASON) {
      return false;
    }
    const owner = await this.prisma.user.findUnique({
      where: { id: post.userId },
      select: { isActive: true },
    });
    return owner?.isActive !== true;
  }

  async approve(postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post nao encontrado');
    await this.assertNotHeld(post);

    const updated = await this.prisma.communityPost.update({
      where: { id: postId },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
        rejectionReason: null,
      },
    });

    await this.notifications.create(post.userId, 'community-approved', {
      postId: post.id,
    });

    return updated;
  }

  /**
   * Cria um post direto pelo admin (já aprovado, autoria do próprio admin). A mídia tem de estar no nosso bucket
   * público (o post guarda a URL canônica dele, nunca um host de fora); com a checagem ligada, passa pela régua antes
   * de ir ao feed.
   */
  async adminCreate(
    userId: string,
    dto: {
      kind: 'image' | 'video';
      mediaUrl: string;
      thumbnailUrl?: string;
      prompt?: string;
    },
  ) {
    const media = publicLocationOf(this.uploads, dto.mediaUrl);
    if (!media) {
      throw new BadRequestException({
        code: COMMUNITY_MEDIA_NOT_ALLOWED,
        message: COMMUNITY_MEDIA_NOT_ALLOWED_MESSAGE,
      });
    }
    const thumbnail = publicLocationOf(this.uploads, dto.thumbnailUrl);
    await this.checkAdminMedia(userId, dto, [
      { kind: dto.kind, key: media.key },
      ...(thumbnail ? [{ kind: 'image' as const, key: thumbnail.key }] : []),
    ]);

    return this.prisma.communityPost.create({
      data: {
        userId,
        kind: dto.kind,
        mediaUrl: this.uploads.getPublicUrl(media.key),
        thumbnailUrl: thumbnail
          ? this.uploads.getPublicUrl(thumbnail.key)
          : null,
        prompt: dto.prompt ?? '',
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
  }

  /**
   * Checagem da mídia do post do admin (modo ligado), lida pela chave no bucket público: barrado = 422, indisponível =
   * 503, mesmo código e texto das rotas sem fila.
   */
  private async checkAdminMedia(
    userId: string,
    dto: { prompt?: string },
    media: Array<{ kind: 'image' | 'video'; key: string }>,
  ): Promise<void> {
    const safety = this.imageSafety;
    if (!safety?.imageEnabled) return;
    let verdict: Pick<
      RuledInputVerdict,
      'verdict' | 'ruleId' | 'strength' | 'cause'
    >;
    try {
      verdict = await safety.checkInput(
        media.map((item) => ({
          kind: item.kind,
          mimeType: null,
          area: 'public' as const,
          key: item.key,
        })),
        {
          userId,
          generationId: null,
          model: null,
          tool: 'generate',
          type: null,
          hasUserMedia: true,
          sexual: { classifier: null, inputNudity: null },
          prompt: dto.prompt ?? null,
          negativePrompt: null,
        },
      );
    } catch (error) {
      this.logger.warn(
        `[IMAGE_SAFETY] post do admin: checagem falhou (${(error as Error).message?.slice(0, 200)})`,
      );
      verdict = {
        verdict: 'UNAVAILABLE',
        ruleId: 'UNAVAILABLE',
        strength: 'NONE',
      };
    }
    if (!safety.actsOn(verdict)) return;
    this.logger.warn(
      `[IMAGE_SAFETY] post do admin não publicado (${verdict.ruleId ?? 'sem-regra'}/${verdict.strength})`,
    );
    if (verdict.verdict === 'UNAVAILABLE') {
      throw new ServiceUnavailableException({
        code: ErrorCodes.SAFETY_CHECK_UNAVAILABLE.code,
        message: ErrorCodes.SAFETY_CHECK_UNAVAILABLE.message,
      });
    }
    throw new UnprocessableEntityException({
      code: ErrorCodes.IMAGE_SAFETY_BLOCKED.code,
      message: ErrorCodes.IMAGE_SAFETY_BLOCKED.message,
    });
  }

  async adminDelete(postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post nao encontrado');
    // a linha do post é evidência na guarda legal e na revisão: não sai
    await this.assertNotHeld(post);
    // likes caem em cascata (FK onDelete: Cascade)
    await this.prisma.communityPost.delete({ where: { id: postId } });
    return { success: true };
  }

  async reject(postId: string, reason?: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post nao encontrado');
    // o motivo da guarda legal (ou da suspensão, com a conta ainda suspensa) não pode ser trocado: é ele que segura o
    // post fora do ar; rejeitar post em revisão pode
    if (
      post.rejectionReason === LEGAL_HOLD_POST_REJECTION_REASON ||
      (await this.heldBySuspension(post))
    ) {
      throw heldPostConflict();
    }

    const updated = await this.prisma.communityPost.update({
      where: { id: postId },
      data: {
        status: 'REJECTED',
        ...(reason !== undefined && { rejectionReason: reason }),
      },
    });

    await this.notifications.create(post.userId, 'community-rejected', {
      postId: post.id,
      ...(reason && { reason }),
    });

    return updated;
  }
}
