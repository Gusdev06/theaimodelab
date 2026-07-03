import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma, EmailBroadcastRecipientType, EmailBroadcastStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import {
  EMAIL_BROADCAST_QUEUE,
  EmailBroadcastJobName,
  EmailBroadcastJobData,
} from './queue/email-broadcast.constants';
import { renderMarkdownToEmailHtml } from './helpers/markdown.helper';
import { wrapInBroadcastTemplate } from './helpers/email-template.helper';
import {
  applyMergeTags,
  buildMergeVars,
  MergeTagVars,
} from './helpers/merge-tags.helper';

const MAX_RECIPIENTS_PER_BROADCAST = 50_000;

export interface RecipientFilter {
  planSlug?: string;
  emails?: string[];
  email?: string;
}

export interface ResolvedRecipient {
  email: string;
  userId: string | null;
  name: string | null;
  plan: string | null;
}

interface CreateBroadcastInput {
  triggeredByUserId: string;
  subject: string;
  bodyMarkdown: string;
  recipientType: EmailBroadcastRecipientType;
  recipientFilter?: RecipientFilter;
  format?: 'markdown' | 'html';
}

interface SendTestInput {
  triggeredByUserId: string;
  triggeredByEmail: string;
  subject: string;
  bodyMarkdown: string;
  format?: 'markdown' | 'html';
}

@Injectable()
export class AdminEmailsService {
  private readonly logger = new Logger(AdminEmailsService.name);
  private readonly logoUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    @InjectQueue(EMAIL_BROADCAST_QUEUE)
    private readonly broadcastQueue: Queue<EmailBroadcastJobData>,
  ) {
    this.logoUrl = this.configService.get<string>('LOGO_URL') || '';
  }

  // ─── Resolver destinatários ──────────────────────────────────────────────
  async resolveRecipients(
    type: EmailBroadcastRecipientType,
    filter?: RecipientFilter,
  ): Promise<ResolvedRecipient[]> {
    switch (type) {
      case EmailBroadcastRecipientType.ALL: {
        const users = await this.prisma.user.findMany({
          where: { isActive: true, emailVerified: true },
          select: {
            id: true,
            email: true,
            name: true,
            subscriptions: {
              where: { status: 'ACTIVE' },
              select: { plan: { select: { name: true } } },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        });
        return users.map((u) => ({
          email: u.email,
          userId: u.id,
          name: u.name,
          plan: u.subscriptions[0]?.plan?.name ?? null,
        }));
      }

      case EmailBroadcastRecipientType.ALL_PAID: {
        const subs = await this.prisma.subscription.findMany({
          where: {
            status: 'ACTIVE',
            plan: { slug: { not: 'free' } },
            user: { isActive: true, emailVerified: true },
          },
          select: {
            user: { select: { id: true, email: true, name: true } },
            plan: { select: { name: true } },
          },
        });
        const dedup = new Map<string, ResolvedRecipient>();
        for (const s of subs) {
          dedup.set(s.user.email, {
            email: s.user.email,
            userId: s.user.id,
            name: s.user.name,
            plan: s.plan.name,
          });
        }
        return Array.from(dedup.values());
      }

      case EmailBroadcastRecipientType.BY_PLAN: {
        if (!filter?.planSlug) {
          throw new BadRequestException('planSlug obrigatório para BY_PLAN');
        }
        const subs = await this.prisma.subscription.findMany({
          where: {
            status: 'ACTIVE',
            plan: { slug: filter.planSlug },
            user: { isActive: true, emailVerified: true },
          },
          select: {
            user: { select: { id: true, email: true, name: true } },
            plan: { select: { name: true } },
          },
        });
        const dedup = new Map<string, ResolvedRecipient>();
        for (const s of subs) {
          dedup.set(s.user.email, {
            email: s.user.email,
            userId: s.user.id,
            name: s.user.name,
            plan: s.plan.name,
          });
        }
        return Array.from(dedup.values());
      }

      case EmailBroadcastRecipientType.CUSTOM_LIST: {
        if (!filter?.emails?.length) {
          throw new BadRequestException('emails obrigatório para CUSTOM_LIST');
        }
        const normalized = Array.from(
          new Set(
            filter.emails
              .map((e) => e.trim().toLowerCase())
              .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
          ),
        );
        if (!normalized.length) {
          throw new BadRequestException('Nenhum email válido na lista');
        }
        const users = await this.prisma.user.findMany({
          where: { email: { in: normalized } },
          select: {
            id: true,
            email: true,
            name: true,
            subscriptions: {
              where: { status: 'ACTIVE' },
              select: { plan: { select: { name: true } } },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        });
        const userByEmail = new Map(
          users.map((u) => [
            u.email.toLowerCase(),
            { id: u.id, name: u.name, plan: u.subscriptions[0]?.plan?.name ?? null },
          ]),
        );
        return normalized.map((email) => {
          const u = userByEmail.get(email);
          return {
            email,
            userId: u?.id ?? null,
            name: u?.name ?? null,
            plan: u?.plan ?? null,
          };
        });
      }

      case EmailBroadcastRecipientType.SINGLE: {
        if (!filter?.email) {
          throw new BadRequestException('email obrigatório para SINGLE');
        }
        const email = filter.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new BadRequestException('Email inválido');
        }
        const user = await this.prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            name: true,
            subscriptions: {
              where: { status: 'ACTIVE' },
              select: { plan: { select: { name: true } } },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        });
        return [
          {
            email,
            userId: user?.id ?? null,
            name: user?.name ?? null,
            plan: user?.subscriptions[0]?.plan?.name ?? null,
          },
        ];
      }

      default:
        throw new BadRequestException(`Tipo de destinatário inválido: ${String(type)}`);
    }
  }

  // ─── Preview de contagem ─────────────────────────────────────────────────
  async previewRecipientCount(
    type: EmailBroadcastRecipientType,
    filter?: RecipientFilter,
  ): Promise<{ count: number }> {
    const recipients = await this.resolveRecipients(type, filter);
    return { count: recipients.length };
  }

  // ─── Renderização do HTML completo ───────────────────────────────────────
  /**
   * `format='markdown'` (default): passa pelo parser markdown + inline styles
   * + wrapper de template padrão (logo, padding, etc.).
   * `format='html'`: assume que o body já é um HTML completo (do `<!DOCTYPE>`
   * até `</html>` ou um fragmento standalone) — usa direto, sem template.
   */
  async renderHtml(body: string, format: 'markdown' | 'html' = 'markdown'): Promise<string> {
    if (format === 'html') {
      return body;
    }
    const innerHtml = await renderMarkdownToEmailHtml(body);
    return wrapInBroadcastTemplate(innerHtml, this.logoUrl);
  }

  /**
   * Render usado pelo preview do composer — aplica merge tags com dados de
   * exemplo (geralmente do próprio admin logado) pra mostrar como o email
   * vai ficar no destinatário.
   */
  async renderPreview(input: {
    bodyMarkdown: string;
    subject?: string;
    mergeVars?: MergeTagVars;
    format?: 'markdown' | 'html';
  }): Promise<{ html: string; subject?: string }> {
    let html = await this.renderHtml(input.bodyMarkdown ?? '', input.format);
    const vars = input.mergeVars ?? {};
    if (Object.keys(vars).length > 0) {
      html = applyMergeTags(html, vars);
    }
    const subject =
      input.subject != null ? applyMergeTags(input.subject, vars) : undefined;
    return { html, subject };
  }

  // ─── Criar broadcast e enfileirar ────────────────────────────────────────
  async createAndDispatch(input: CreateBroadcastInput) {
    const recipients = await this.resolveRecipients(
      input.recipientType,
      input.recipientFilter,
    );

    if (!recipients.length) {
      throw new BadRequestException('Nenhum destinatário encontrado');
    }
    if (recipients.length > MAX_RECIPIENTS_PER_BROADCAST) {
      throw new BadRequestException(
        `Limite excedido: ${recipients.length} destinatários (máx ${MAX_RECIPIENTS_PER_BROADCAST})`,
      );
    }

    const bodyHtml = await this.renderHtml(input.bodyMarkdown, input.format);

    const broadcast = await this.prisma.emailBroadcast.create({
      data: {
        subject: input.subject,
        bodyMarkdown: input.bodyMarkdown,
        bodyHtml,
        recipientType: input.recipientType,
        recipientFilter: (input.recipientFilter ?? null) as Prisma.InputJsonValue,
        totalRecipients: recipients.length,
        status: EmailBroadcastStatus.PENDING,
        triggeredById: input.triggeredByUserId,
        recipients: {
          create: recipients.map((r) => ({
            email: r.email,
            userId: r.userId,
            name: r.name,
            plan: r.plan,
          })),
        },
      },
    });

    await this.broadcastQueue.add(
      EmailBroadcastJobName.SEND,
      { broadcastId: broadcast.id },
      { attempts: 1, removeOnComplete: { age: 7 * 24 * 3600 } },
    );

    this.logger.log(
      `Broadcast ${broadcast.id} enfileirado — ${recipients.length} destinatários · admin=${input.triggeredByUserId}`,
    );

    return broadcast;
  }

  // ─── Enviar teste pra si mesmo ───────────────────────────────────────────
  async sendTest(input: SendTestInput): Promise<void> {
    // Pega name + plan do admin pra renderizar com seus próprios dados
    const adminUser = await this.prisma.user.findUnique({
      where: { id: input.triggeredByUserId },
      select: {
        name: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          select: { plan: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const vars = buildMergeVars({
      name: adminUser?.name ?? null,
      plan: adminUser?.subscriptions[0]?.plan?.name ?? null,
      email: input.triggeredByEmail,
    });

    const renderedHtml = await this.renderHtml(input.bodyMarkdown, input.format);
    const finalHtml = applyMergeTags(renderedHtml, vars);
    const finalSubject = `[TESTE] ${applyMergeTags(input.subject, vars)}`;

    await this.emailService.sendRawEmail({
      to: input.triggeredByEmail,
      subject: finalSubject,
      html: finalHtml,
    });
    this.logger.log(`Email de teste enviado para ${input.triggeredByEmail}`);
  }

  // ─── Histórico ───────────────────────────────────────────────────────────
  async listBroadcasts(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
      this.prisma.emailBroadcast.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          subject: true,
          recipientType: true,
          totalRecipients: true,
          sentCount: true,
          failedCount: true,
          status: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          triggeredBy: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.emailBroadcast.count(),
    ]);
    return { items, total, page, limit };
  }

  async getBroadcast(id: string) {
    const broadcast = await this.prisma.emailBroadcast.findUnique({
      where: { id },
      include: {
        triggeredBy: { select: { id: true, name: true, email: true } },
        recipients: {
          take: 200,
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            email: true,
            status: true,
            errorMessage: true,
            deliveredAt: true,
            openedAt: true,
            clickedAt: true,
            bouncedAt: true,
          },
        },
      },
    });
    if (!broadcast) throw new NotFoundException('Broadcast não encontrado');
    return broadcast;
  }
}
