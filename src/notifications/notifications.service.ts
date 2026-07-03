import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const LIST_LIMIT = 30;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Cria uma notificação para o usuário (usado por outros módulos). */
  async create(userId: string, type: string, data?: Record<string, unknown>) {
    return this.prisma.notification.create({
      data: {
        userId,
        type,
        ...(data && { data: data as Prisma.InputJsonValue }),
      },
    });
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
