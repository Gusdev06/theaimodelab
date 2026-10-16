import { Injectable, Logger } from '@nestjs/common';
import { ContentSafetyEventKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CURRENT_TERMS_VERSION } from '../users/terms.constants';

export interface SafetyEventInput {
  userId: string | null;
  kind: ContentSafetyEventKind;
  route: string;
  match?: string | null;
  excerpt?: string | null;
}

/**
 * Trilha de auditoria da segurança de conteúdo: cada pedido recusado por referência a menor e cada atestado de
 * consentimento das ferramentas de foto (troca de rosto, despir) fica gravado com a versão do termo vigente.
 * É a evidência que a plataforma precisa se uma imagem for contestada, e o que a equipe revisa para achar abuso.
 */
@Injectable()
export class ContentSafetyService {
  private readonly logger = new Logger(ContentSafetyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Grava o evento. Falha ao gravar NÃO libera o pedido: quem chama já decidiu recusar (ou aceitar o atestado);
   * o erro do banco só vira log, para a recusa nunca depender do registro.
   */
  async record(event: SafetyEventInput): Promise<void> {
    try {
      await this.prisma.contentSafetyEvent.create({
        data: {
          userId: event.userId,
          kind: event.kind,
          route: event.route.slice(0, 200),
          match: event.match?.slice(0, 80) ?? null,
          excerpt: event.excerpt ? event.excerpt.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
          termsVersion: CURRENT_TERMS_VERSION,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`content-safety: falha ao registrar ${event.kind} (${event.route}): ${message}`);
    }
  }

  /** Quantos pedidos com referência a menor o usuário teve recusados nas últimas `hours` horas. */
  async recentMinorBlocks(userId: string, hours = 24): Promise<number> {
    return this.prisma.contentSafetyEvent.count({
      where: { userId, kind: ContentSafetyEventKind.MINOR_BLOCKED, createdAt: { gte: new Date(Date.now() - hours * 3_600_000) } },
    });
  }

  /** Para o admin: eventos mais recentes (reincidência aparece agrupada por usuário). */
  async listForAdmin(page = 1, limit = 50, kind?: ContentSafetyEventKind) {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const where = kind ? { kind } : {};
    const [data, total] = await Promise.all([
      this.prisma.contentSafetyEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.contentSafetyEvent.count({ where }),
    ]);
    return { data, total, page: Math.max(page, 1), limit: take };
  }
}
