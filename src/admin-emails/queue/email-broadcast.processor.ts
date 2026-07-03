import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EmailBroadcastDeliveryStatus, EmailBroadcastStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../../email/email.service';
import {
  EMAIL_BROADCAST_QUEUE,
  EmailBroadcastJobData,
  EmailBroadcastJobName,
  EMAIL_BROADCAST_BATCH_SIZE,
  EMAIL_BROADCAST_BATCH_DELAY_MS,
} from './email-broadcast.constants';
import {
  applyMergeTags,
  buildMergeVars,
} from '../helpers/merge-tags.helper';

@Processor(EMAIL_BROADCAST_QUEUE, {
  concurrency: 1, // 1 broadcast por vez — evita estourar rate limit do Resend
  lockDuration: 30 * 60 * 1000, // 30 min — broadcasts grandes demoram
})
export class EmailBroadcastProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailBroadcastProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {
    super();
  }

  async process(job: Job<EmailBroadcastJobData>): Promise<void> {
    if (job.name !== EmailBroadcastJobName.SEND) {
      this.logger.warn(`Job desconhecido: ${job.name}`);
      return;
    }
    await this.processBroadcast(job.data.broadcastId);
  }

  private async processBroadcast(broadcastId: string): Promise<void> {
    const broadcast = await this.prisma.emailBroadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, subject: true, bodyHtml: true, status: true },
    });

    if (!broadcast) {
      this.logger.error(`Broadcast ${broadcastId} não encontrado`);
      return;
    }

    if (
      broadcast.status === EmailBroadcastStatus.COMPLETED ||
      broadcast.status === EmailBroadcastStatus.PARTIAL_FAILURE
    ) {
      this.logger.warn(`Broadcast ${broadcastId} já processado (status=${broadcast.status})`);
      return;
    }

    await this.prisma.emailBroadcast.update({
      where: { id: broadcastId },
      data: { status: EmailBroadcastStatus.PROCESSING, startedAt: new Date() },
    });

    let sent = 0;
    let failed = 0;
    let cursor: string | null = null;

    try {
      while (true) {
        const batch = await this.prisma.emailBroadcastRecipient.findMany({
          where: {
            broadcastId,
            status: EmailBroadcastDeliveryStatus.PENDING,
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: EMAIL_BROADCAST_BATCH_SIZE,
          select: { id: true, email: true, name: true, plan: true },
        });

        if (!batch.length) break;
        cursor = batch[batch.length - 1].id;

        // Cada destinatário recebe um HTML/subject com seus próprios merge tags
        const payload = batch.map((r) => {
          const vars = buildMergeVars({
            email: r.email,
            name: r.name,
            plan: r.plan,
          });
          return {
            to: r.email,
            subject: applyMergeTags(broadcast.subject, vars),
            html: applyMergeTags(broadcast.bodyHtml, vars),
          };
        });

        const results = await this.emailService.sendBatchEmails(payload);

        // Atualiza cada recipient + contadores em paralelo dentro de uma transação
        const updates = batch.map((recipient, i) => {
          const result = results[i];
          if (result?.id) {
            sent++;
            return this.prisma.emailBroadcastRecipient.update({
              where: { id: recipient.id },
              data: {
                status: EmailBroadcastDeliveryStatus.SENT,
                resendEmailId: result.id,
              },
            });
          }
          failed++;
          return this.prisma.emailBroadcastRecipient.update({
            where: { id: recipient.id },
            data: {
              status: EmailBroadcastDeliveryStatus.FAILED,
              errorMessage: result?.error ?? 'unknown',
            },
          });
        });

        await this.prisma.$transaction(updates);

        await this.prisma.emailBroadcast.update({
          where: { id: broadcastId },
          data: { sentCount: sent, failedCount: failed },
        });

        this.logger.log(
          `Broadcast ${broadcastId} progresso — sent=${sent} failed=${failed}`,
        );

        if (EMAIL_BROADCAST_BATCH_DELAY_MS > 0) {
          await new Promise((res) => setTimeout(res, EMAIL_BROADCAST_BATCH_DELAY_MS));
        }
      }

      const finalStatus =
        failed === 0
          ? EmailBroadcastStatus.COMPLETED
          : sent === 0
            ? EmailBroadcastStatus.FAILED
            : EmailBroadcastStatus.PARTIAL_FAILURE;

      await this.prisma.emailBroadcast.update({
        where: { id: broadcastId },
        data: {
          status: finalStatus,
          sentCount: sent,
          failedCount: failed,
          completedAt: new Date(),
        },
      });

      this.logger.log(
        `Broadcast ${broadcastId} finalizado — status=${finalStatus} sent=${sent} failed=${failed}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Broadcast ${broadcastId} crashed: ${error.message}`,
        error.stack,
      );
      await this.prisma.emailBroadcast.update({
        where: { id: broadcastId },
        data: {
          status: EmailBroadcastStatus.FAILED,
          errorMessage: error.message ?? 'unknown error',
          completedAt: new Date(),
          sentCount: sent,
          failedCount: failed,
        },
      });
      throw error;
    }
  }
}
