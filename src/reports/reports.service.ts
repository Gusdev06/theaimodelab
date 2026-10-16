import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentReportCategory, ContentReportStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import type { CreateReportDto, UpdateReportDto } from './dto/create-report.dto';

/** Categorias que pedem ação em horas, não em dias (menor e imagem íntima sem consentimento). */
export const URGENT_CATEGORIES: ReadonlySet<ContentReportCategory> = new Set([
  ContentReportCategory.MINOR,
  ContentReportCategory.NON_CONSENSUAL,
]);

/**
 * Denúncias de conteúdo (canal público exigido pela política de remoção e pelos processadores de pagamento).
 * Toda denúncia é gravada; as urgentes avisam a equipe na hora por e-mail (REPORTS_ALERT_EMAIL). A revisão e a
 * remoção são feitas pela equipe no admin. Conteúdo denunciado como envolvendo menor NÃO é apagado
 * automaticamente: é retirado do ar pela equipe e a evidência é preservada para as autoridades.
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private hashIp(ip: string | null | undefined): string | null {
    if (!ip) return null;
    const salt = this.config.get<string>('REPORTS_IP_SALT') || 'taml-reports';
    return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
  }

  async create(dto: CreateReportDto, meta: { ip?: string | null; userId?: string | null }) {
    // isca preenchida = robô: responde igual (não ensina o robô), mas não grava nem avisa
    if (dto.website && dto.website.trim()) {
      this.logger.warn('reports: isca preenchida, denúncia de robô descartada');
      return { ok: true as const, id: null };
    }
    const report = await this.prisma.contentReport.create({
      data: {
        category: dto.category,
        target: dto.target.trim(),
        description: dto.description.trim(),
        reporterEmail: dto.reporterEmail?.trim().toLowerCase() ?? null,
        reporterUserId: meta.userId ?? null,
        isDepictedPerson: dto.isDepictedPerson ?? false,
        ipHash: this.hashIp(meta.ip),
      },
    });

    const urgent = URGENT_CATEGORIES.has(report.category);
    const alertTo = this.config.get<string>('REPORTS_ALERT_EMAIL');
    if (alertTo) {
      const sent = await this.email.sendContentReportAlert(alertTo, {
        id: report.id, category: report.category, urgent, target: report.target, description: report.description,
        reporterEmail: report.reporterEmail, isDepictedPerson: report.isDepictedPerson, createdAt: report.createdAt,
      });
      if (!sent) this.logger.error(`reports: denúncia ${report.id} (${report.category}) gravada, mas o aviso por e-mail falhou`);
    } else {
      this.logger.warn(`reports: REPORTS_ALERT_EMAIL ausente; denúncia ${report.id} (${report.category}) só no admin`);
    }
    return { ok: true as const, id: report.id };
  }

  async listForAdmin(page = 1, limit = 50, status?: ContentReportStatus) {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const where = status ? { status } : {};
    const [data, total, open] = await Promise.all([
      this.prisma.contentReport.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], skip, take }),
      this.prisma.contentReport.count({ where }),
      this.prisma.contentReport.count({ where: { status: { in: [ContentReportStatus.OPEN, ContentReportStatus.IN_REVIEW] } } }),
    ]);
    return { data, total, open, page: Math.max(page, 1), limit: take };
  }

  async update(id: string, dto: UpdateReportDto, adminEmail: string) {
    const existing = await this.prisma.contentReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Denúncia não encontrada');
    const closing = dto.status === 'ACTIONED' || dto.status === 'DISMISSED';
    return this.prisma.contentReport.update({
      where: { id },
      data: {
        status: dto.status as ContentReportStatus,
        adminNote: dto.adminNote ?? existing.adminNote,
        handledBy: adminEmail,
        handledAt: closing ? new Date() : existing.handledAt,
      },
    });
  }
}
