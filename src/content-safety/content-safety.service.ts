import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ContentSafetyEvent, ContentSafetyEventKind, GenerationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CURRENT_TERMS_VERSION } from '../users/terms.constants';
import type { PreflightStatus } from './preflight-status';
import {
  RELEASABLE_SAFETY_EVENT_KINDS,
  SAFETY_REVIEWER_FORBIDDEN,
  releaseNeedsReviewer,
} from './safety-event-kinds';
import {
  PREFLIGHT_STATUS_READER,
  type PreflightStatusReader,
  type PreflightStatusTarget,
} from './image-safety/image-safety.tokens';

/** Nota da liberação de um bloqueio por menor: o jurídico explica por quê (fica na trilha). */
export const SAFETY_RELEASE_NOTE_MIN_LENGTH = 10;
export const SAFETY_RELEASE_NOTE_MAX_LENGTH = 1000;

/** Quem libera um evento: o admin do token, o IP para o registro e se está em SAFETY_REVIEWER_IDS. */
export interface ReleaseActor {
  id: string;
  email?: string | null;
  ip?: string | null;
  /** está na lista de revisores designados (só ele libera evidência de imagem e caso confirmado pelo revisor) */
  reviewer?: boolean;
}

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

  constructor(
    private readonly prisma: PrismaService,
    /** status do preflight lido de content_safety_scans (módulo de segurança de imagem); ausente = 'unavailable' */
    @Optional()
    @Inject(PREFLIGHT_STATUS_READER)
    private readonly preflightReader: PreflightStatusReader | null = null,
  ) {}

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
   * O desvio depois de uma recusa do provedor depende da checagem da mídia do usuário? Só com o porteiro de imagem
   * ligado (IMAGE_SAFETY_MODE shadow ou enforce). Com off ou sem o leitor registrado, false: vale a regra de antes da
   * checagem (safetyFallbackVerdict: menor encerra; o sem censura com foto só pede o atestado).
   */
  enforcesMediaPreflight(): boolean {
    return this.preflightReader?.enforcesMediaPreflight === true;
  }

  /**
   * Veredito do porteiro de imagem para a mídia de entrada da geração: ponto único de leitura para os desvios
   * depois de uma recusa do provedor. Lê as checagens de entrada gravadas (content_safety_scans) pelo leitor do módulo
   * de segurança de imagem; com IMAGE_SAFETY_MODE=off, sem checagem ou sem o leitor registrado, devolve `unavailable`
   * (com o porteiro ligado, o desvio com foto do usuário encerra a geração; desligado, a guarda nem lê o veredito).
   * `target: 'uncensored'` reavalia a entrada como pedido sexual (o destino não tem filtro).
   */
  preflightStatusForGeneration(
    generationId: string,
    target?: PreflightStatusTarget,
  ): Promise<PreflightStatus> {
    if (!this.preflightReader) return Promise.resolve('unavailable');
    return this.preflightReader.statusFor(generationId, target);
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
   * Libera um bloqueio por menor (MINOR_BLOCKED, ou os de imagem: IMAGE_MINOR_BLOCKED, OUTPUT_MINOR_BLOCKED,
   * INPUT_HELD, OUTPUT_HELD) a pedido do jurídico: falso positivo do filtro ou do provedor, ou caso encerrado. Nada é
   * apagado (o evento fica na trilha com quem liberou, quando e por quê); ele só deixa de contar para a guarda legal da
   * conta (exclusão LGPD e exclusão definitiva) e de segurar a geração ligada a ele.
   * O bloqueio de texto/provedor sai por qualquer ADMIN (o jurídico, no cockpit); evidência de imagem e caso confirmado
   * pelo revisor, só pelo revisor designado (403 para o resto). Entrada ou resultado ainda segurado (geração IN_REVIEW)
   * = 409: a decisão é pela checagem. Toda liberação vai para content_safety_access_log ANTES de agir (sem o registro,
   * 503 e nada muda).
   * Idempotente: liberar de novo devolve a liberação já gravada, sem mudar data, autor ou nota.
   */
  async releaseMinorBlock(
    eventId: string,
    note: string,
    admin: ReleaseActor,
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
    if (!RELEASABLE_SAFETY_EVENT_KINDS.has(event.kind)) {
      throw new BadRequestException({
        code: 'CONTENT_SAFETY_RELEASE_KIND',
        message: 'Só bloqueio ou retenção por segurança de conteúdo (menor de idade, foto ou resultado segurado) pode ser liberado.',
      });
    }
    // evidência de imagem e caso confirmado pelo revisor: só o revisor designado (camada 7), nunca qualquer ADMIN
    if (releaseNeedsReviewer(event) && admin.reviewer !== true) {
      this.logger.warn(
        `content-safety: admin ${admin.id} fora de SAFETY_REVIEWER_IDS tentou liberar o evento ${eventId} (${event.kind})`,
      );
      throw new ForbiddenException(SAFETY_REVIEWER_FORBIDDEN);
    }
    if (event.releasedAt) return { ...withRelease(event), alreadyReleased: true };
    // geração ainda segurada: liberar só o evento a deixaria presa na revisão (a decisão é do fluxo do revisor)
    if (
      (event.kind === ContentSafetyEventKind.INPUT_HELD || event.kind === ContentSafetyEventKind.OUTPUT_HELD) &&
      event.generationId
    ) {
      const generation = await this.prisma.generation.findUnique({
        where: { id: event.generationId },
        select: { status: true },
      });
      if (generation?.status === GenerationStatus.IN_REVIEW) {
        throw new ConflictException({
          code: 'CONTENT_SAFETY_RELEASE_USE_REVIEW',
          message:
            'A geração ainda está em revisão: decida pela checagem (POST /api/v1/admin/content-safety/scans/:id/decision).',
        });
      }
    }

    // registro ANTES de agir: sem ele, nada é liberado
    try {
      await this.prisma.contentSafetyAccessLog.create({
        data: {
          actorId: admin.id,
          action: 'release',
          targetType: 'event',
          targetId: eventId,
          reason: text,
          ip: admin.ip ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`content-safety: registro da liberação de ${eventId} não gravado: ${message.slice(0, 200)}`);
      throw new ServiceUnavailableException('Não foi possível registrar a liberação; nada foi alterado.');
    }

    // a trava é a própria condição: dois admins liberando juntos gravam uma vez só (o 2º recebe a 1ª liberação)
    const { count } = await this.prisma.contentSafetyEvent.updateMany({
      where: { id: eventId, kind: event.kind, releasedAt: null },
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

