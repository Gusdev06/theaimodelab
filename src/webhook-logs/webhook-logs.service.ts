import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WebhookLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    provider: string,
    eventType: string,
    externalId: string | null,
    payload: Prisma.InputJsonValue,
  ) {
    return this.prisma.webhookLog.create({
      data: {
        provider,
        eventType,
        externalId,
        payload,
      },
    });
  }

  async markProcessed(id: string) {
    return this.prisma.webhookLog.update({
      where: { id },
      data: { processed: true },
    });
  }

  async markFailed(id: string, error: string) {
    return this.prisma.webhookLog.update({
      where: { id },
      data: { error },
    });
  }

  async findByExternalId(externalId: string) {
    return this.prisma.webhookLog.findFirst({
      where: { externalId },
    });
  }

  async findProcessedByExternalId(externalId: string) {
    return this.prisma.webhookLog.findFirst({
      where: { externalId, processed: true },
    });
  }
}
