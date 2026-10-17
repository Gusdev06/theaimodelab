import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ContentSafetyEvent, ContentSafetyEventKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CURRENT_TERMS_VERSION } from '../users/terms.constants';
import type { PreflightStatus } from './preflight-status';

/** Nota da liberação de um bloqueio por menor: o jurídico explica por quê (fica na trilha). */
export const SAFETY_RELEASE_NOTE_MIN_LENGTH = 10;
export const SAFETY_RELEASE_NOTE_MAX_LENGTH = 1000;

export type SafetyEventWithRelease = ContentSafetyEvent & { released: boolean };
export type ReleasedSafetyEvent = SafetyEventWithRelease & {
  /** true quando o evento já estava liberado: nada mudou (data, autor e nota são os da 1ª liberação) */
  alreadyReleased: boolean;
};

function withRelease(event: ContentSafetyEvent): SafetyEventWithRelease {
  return {
    ...event,
    releasedAt: event.releasedAt ?? null,
    releasedBy: event.releasedBy ?? null,
    releaseNote: event.releaseNote ?? null,
    released: Boolean(event.releasedAt),
  };
}

export interface SafetyEventInput {
  userId: string | null;
  kind: ContentSafetyEventKind;
  route: string;
  match?: string | null;
  excerpt?: string | null;
  /** geração criada pelo pedido (atestado ligado à imagem) ou bloqueada pelo provedor */
  generationId?: string | null;
}

/**
 * Trilha de auditoria da segurança de conteúdo: cada pedido recusado por referência a menor e cada atestado de
 * consentimento das ferramentas de foto fica gravado com a versão do termo que o usuário tinha aceitado. É a
 * evidência que a plataforma precisa se uma imagem for contestada, e o que a equipe revisa para achar abuso.
 */
@Injectable()
export class ContentSafetyService {
  private readonly logger = new Logger(ContentSafetyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Versão do termo que o usuário aceitou (a evidência vale pelo que ele aceitou, não pelo que está vigente). */
  private async acceptedTermsVersion(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { termsVersion: true } });
    return user?.termsVersion ?? null;
  }

  private async create(event: SafetyEventInput): Promise<string> {
    const termsVersion = await this.acceptedTermsVersion(event.userId).catch(() => null);
    const row = await this.prisma.contentSafetyEvent.create({
      data: {
        userId: event.userId,
        kind: event.kind,
        route: event.route.slice(0, 200),
        match: event.match?.slice(0, 80) ?? null,
        excerpt: event.excerpt ? event.excerpt.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
        termsVersion: termsVersion ?? (event.userId ? null : CURRENT_TERMS_VERSION),
        generationId: event.generationId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Grava o evento de RECUSA (menor, falta de atestado). Falha ao gravar não libera o pedido: quem chama já
   * decidiu recusar; o erro do banco só vira log, para a recusa nunca depender do registro.
   */
  async record(event: SafetyEventInput): Promise<string | null> {
    try {
      return await this.create(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`content-safety: falha ao registrar ${event.kind} (${event.route}): ${message}`);
      return null;
    }
  }

  /**
   * Grava o ATESTADO de consentimento antes de liberar a ferramenta. Aqui o registro é a evidência: se não der
   * para gravar, o pedido não segue (503), para nunca existir troca de rosto/despir sem atestado guardado.
   */
  async recordOrThrow(event: SafetyEventInput): Promise<string> {
    try {
      return await this.create(event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`content-safety: atestado ${event.kind} não gravado (${event.route}): ${message}`);
      throw new ServiceUnavailableException('Não conseguimos registrar a autorização de imagem agora. Tente de novo em instantes.');
    }
  }

  /** Liga o atestado à geração criada pelo pedido. Melhor esforço: o atestado já está gravado. */
  async linkGeneration(eventId: string, generationId: string): Promise<void> {
    try {
      await this.prisma.contentSafetyEvent.update({ where: { id: eventId }, data: { generationId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`content-safety: atestado ${eventId} sem ligação com a geração ${generationId}: ${message}`);
    }
  }

  /** A geração nasceu de um pedido com atestado de imagem? (fallback para modelo sem censura com foto exige isso) */
  async hasConsentForGeneration(generationId: string): Promise<boolean> {
    const count = await this.prisma.contentSafetyEvent.count({
      where: { generationId, kind: ContentSafetyEventKind.CONSENT_ATTESTED },
    });
    return count > 0;
  }

  /**
   * Veredito do porteiro de imagem para a mídia de entrada da geração: ponto único de leitura para os desvios
   * depois de uma recusa do provedor. Ainda não existe checagem de imagem gravada, então devolve sempre
   * `unavailable` (todo desvio com foto do usuário encerra a geração). Onda 1: ler a tabela de checagens
   * (content_safety_scans, etapas de entrada) desta geração e passar o resultado por toPreflightStatus.
   */
  preflightStatusForGeneration(generationId: string): Promise<PreflightStatus> {
    void generationId;
    return Promise.resolve('unavailable');
  }

  /** Quantos pedidos com referência a menor o usuário teve recusados nas últimas `hours` horas (sem os liberados). */
  async recentMinorBlocks(userId: string, hours = 24): Promise<number> {
    return this.prisma.contentSafetyEvent.count({
      where: {
        userId,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        releasedAt: null,
        createdAt: { gte: new Date(Date.now() - hours * 3_600_000) },
      },
    });
  }

  /**
   * Para o admin: eventos mais recentes (reincidência aparece agrupada por usuário). Cada um traz a liberação pelo
   * jurídico (releasedAt, releasedBy, releaseNote) e `released`: bloqueio liberado não conta para a guarda legal.
   */
  async listForAdmin(page = 1, limit = 50, kind?: ContentSafetyEventKind) {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const where = kind ? { kind } : {};
    const [rows, total] = await Promise.all([
      this.prisma.contentSafetyEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.contentSafetyEvent.count({ where }),
    ]);
    const data = rows.map((event) => withRelease(event));
    return { data, total, page: Math.max(page, 1), limit: take };
  }

  /**
   * Libera um bloqueio por menor (MINOR_BLOCKED) a pedido do jurídico: falso positivo do filtro ou do provedor, ou
   * caso encerrado. Nada é apagado (o evento fica na trilha com quem liberou, quando e por quê); ele só deixa de contar
   * para a guarda legal da conta (exclusão LGPD e exclusão definitiva) e de segurar a geração ligada a ele.
   * Idempotente: liberar de novo devolve a liberação já gravada, sem mudar data, autor ou nota.
   */
  async releaseMinorBlock(
    eventId: string,
    note: string,
    admin: { id: string; email?: string | null },
  ): Promise<ReleasedSafetyEvent> {
    const text = typeof note === 'string' ? note.trim() : '';
    if (text.length < SAFETY_RELEASE_NOTE_MIN_LENGTH || text.length > SAFETY_RELEASE_NOTE_MAX_LENGTH) {
      throw new BadRequestException({
        code: 'CONTENT_SAFETY_RELEASE_NOTE',
        message: `Explique a liberação na nota (de ${SAFETY_RELEASE_NOTE_MIN_LENGTH} a ${SAFETY_RELEASE_NOTE_MAX_LENGTH} caracteres).`,
      });
    }
    const event = await this.prisma.contentSafetyEvent.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Evento de segurança não encontrado');
    if (event.kind !== ContentSafetyEventKind.MINOR_BLOCKED) {
      throw new BadRequestException({
        code: 'CONTENT_SAFETY_RELEASE_KIND',
        message: 'Só bloqueio por menor de idade (MINOR_BLOCKED) pode ser liberado.',
      });
    }
    if (event.releasedAt) return { ...withRelease(event), alreadyReleased: true };

    // a trava é a própria condição: dois admins liberando juntos gravam uma vez só (o 2º recebe a 1ª liberação)
    const { count } = await this.prisma.contentSafetyEvent.updateMany({
      where: { id: eventId, kind: ContentSafetyEventKind.MINOR_BLOCKED, releasedAt: null },
      data: { releasedAt: new Date(), releasedBy: admin.id, releaseNote: text },
    });
    const current = await this.prisma.contentSafetyEvent.findUnique({ where: { id: eventId } });
    if (!current) throw new NotFoundException('Evento de segurança não encontrado');
    if (count > 0) {
      this.logger.warn(
        `content-safety: bloqueio por menor ${eventId} (${event.route}, conta ${event.userId ?? 'sem conta'}) liberado por ` +
          `${admin.email || admin.id}: deixa de contar para a guarda legal`,
      );
    }
    return { ...withRelease(current), alreadyReleased: count === 0 };
  }
}

