import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CommunityPostStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubmitCommunityPostDto } from './dto/community.dto';

function kindOf(type: string): 'image' | 'video' | null {
  const t = type.toUpperCase();
  if (t.includes('VIDEO') || t.includes('MOTION')) return 'video';
  if (t.includes('SPEECH') || t.includes('VOICE') || t.includes('AUDIO'))
    return null;
  return 'image';
}

@Injectable()
export class CommunityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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
        thumbnailUrl: output.thumbnailUrl,
        prompt: generation.prompt ?? '',
        settings: settings as Prisma.InputJsonValue,
      },
    });

    await this.notifications.create(userId, 'community-submitted', {
      postId: post.id,
    });

    return post;
  }

  /** Feed público (posts aprovados) com likedByMe. */
  async feed(userId: string, page = 1, limit = 30) {
    const where = { status: CommunityPostStatus.APPROVED };
    const [posts, total] = await Promise.all([
      this.prisma.communityPost.findMany({
        where,
        orderBy: { approvedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: { name: true, avatarUrl: true } } },
      }),
      this.prisma.communityPost.count({ where }),
    ]);

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
    if (!p || p.status !== 'APPROVED')
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

    const [followers, following, postsCount, follow] = await Promise.all([
      this.prisma.userFollow.count({ where: { followingId: targetId } }),
      this.prisma.userFollow.count({ where: { followerId: targetId } }),
      this.prisma.communityPost.count({
        where: { userId: targetId, status: 'APPROVED' },
      }),
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
    const where = { userId: targetId, status: CommunityPostStatus.APPROVED };
    const [posts, total, author, isFollowing] = await Promise.all([
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

  /** Posts do próprio usuário (com status/motivo). */
  async mine(userId: string) {
    return this.prisma.communityPost.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async like(userId: string, postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post || post.status !== 'APPROVED')
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
    return { data: posts, meta: { page, limit, total } };
  }

  async approve(postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post nao encontrado');

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

  /** Cria um post direto pelo admin (já aprovado, autoria do próprio admin). */
  async adminCreate(
    userId: string,
    dto: {
      kind: 'image' | 'video';
      mediaUrl: string;
      thumbnailUrl?: string;
      prompt?: string;
    },
  ) {
    return this.prisma.communityPost.create({
      data: {
        userId,
        kind: dto.kind,
        mediaUrl: dto.mediaUrl,
        thumbnailUrl: dto.thumbnailUrl,
        prompt: dto.prompt ?? '',
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });
  }

  async adminDelete(postId: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post nao encontrado');
    // likes caem em cascata (FK onDelete: Cascade)
    await this.prisma.communityPost.delete({ where: { id: postId } });
    return { success: true };
  }

  async reject(postId: string, reason?: string) {
    const post = await this.prisma.communityPost.findUnique({
      where: { id: postId },
    });
    if (!post) throw new NotFoundException('Post nao encontrado');

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
