import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WebPushService } from '../web-push/web-push.service';

const LIST_LIMIT = 30;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly webPush?: WebPushService,
  ) {}

  /** Cria uma notificação para o usuário (usado por outros módulos). */
  async create(userId: string, type: string, data?: Record<string, unknown>) {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        type,
        ...(data && { data: data as Prisma.InputJsonValue }),
      },
    });
    // L16: a mesma notificação vira push no aparelho inscrito. Desligado sem WEB_PUSH_ENABLED=on + chaves VAPID
    // (aí nem lê o banco); sem await, para o push lento nunca segurar quem criou o aviso.
    if (this.webPush?.isEnabled()) void this.webPush.notifyFromBell(userId, type, data);
    return notification;
  }

  /** Últimas notificações + total de não lidas. */
  async list(userId: string) {
    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: LIST_LIMIT,
      }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    return { data: items, unreadCount };
  }

  /** Marca todas como lidas. */
  async readAll(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true };
  }

  /** Remove todas as notificações do usuário. */
  async clearAll(userId: string) {
    await this.prisma.notification.deleteMany({ where: { userId } });
    return { success: true };
  }
}
