import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  holdAccountEmail,
  loadLegalHold,
  minorBlockedGenerationIds,
  readHoldAccount,
  scanReportsCitingAccount,
} from '../../users/account-erasure.service';

/** Geração a conferir: id e dona. */
export interface RetentionSubject {
  id: string;
  userId: string;
}

/**
 * Guarda legal na remoção: a mesma régua da exclusão LGPD e do cron da galeria (PR #4), para a remoção nunca apagar
 * evidência. A geração fica guardada (o arquivo vai para o bucket de evidência em vez de ser apagado) quando:
 *  - a conta dona está sob guarda (denúncia de menor, crime, imagem íntima, "sou a pessoa da imagem" ou texto que cita
 *    menor, não descartada e sem a evidência liberada; recusa do provedor por menor com mídia; 3+ tentativas por
 *    menor em 90 dias). Como na exclusão, a guarda segura tudo da conta;
 *  - há bloqueio por menor ou checagem de imagem ligada à geração sem liberação do jurídico;
 *  - alguma checagem da geração já tem evidência guardada;
 *  - o revisor pediu para preservar.
 * Erro ao ler a guarda = preserva (fecha para o lado que não perde evidência).
 */
@Injectable()
export class LegalRetentionReader {
  private readonly logger = new Logger(LegalRetentionReader.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Motivo da guarda por geração (null = sem guarda: o arquivo pode ser apagado). */
  async reasonsFor(
    generations: RetentionSubject[],
    options: { preserveEvidence?: boolean; now?: Date } = {},
  ): Promise<Map<string, string | null>> {
    const reasons = new Map<string, string | null>(
      generations.map((generation) => [generation.id, null]),
    );
    if (!generations.length) return reasons;
    const keep = (id: string, reason: string): void => {
      if (!reasons.get(id)) reasons.set(id, reason);
    };
    if (options.preserveEvidence) {
      for (const generation of generations) {
        keep(generation.id, 'o revisor pediu para preservar');
      }
    }
    const ids = generations.map((generation) => generation.id);

    try {
      const blocked = await minorBlockedGenerationIds(this.prisma, ids);
      for (const id of blocked) {
        keep(id, 'bloqueio por menor ou checagem de imagem ligada à geração');
      }
    } catch (error) {
      this.failClosed(ids, keep, 'bloqueios da geração', error);
    }

    try {
      const withEvidence = await this.prisma.contentSafetyScan.findMany({
        where: { generationId: { in: ids }, evidenceKey: { not: null } },
        select: { generationId: true },
      });
      for (const row of withEvidence) {
        if (row.generationId) {
          keep(row.generationId, 'checagem com evidência guardada');
        }
      }
    } catch (error) {
      this.failClosed(ids, keep, 'checagens da geração', error);
    }

    const byOwner = new Map<string, string[]>();
    for (const generation of generations) {
      const own = byOwner.get(generation.userId) ?? [];
      own.push(generation.id);
      byOwner.set(generation.userId, own);
    }
    const now = options.now ?? new Date();
    for (const [userId, ownIds] of byOwner) {
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, email: true },
        });
        if (!user) {
          // geração sem conta (não deveria existir: a conta apaga em cascata): sem como conferir, preserva
          for (const id of ownIds) keep(id, 'conta dona não encontrada');
          continue;
        }
        const account = await readHoldAccount(
          this.prisma,
          user.id,
          holdAccountEmail(user),
        );
        const scan = await scanReportsCitingAccount(this.prisma, account);
        const hold = await loadLegalHold(this.prisma, {
          account,
          scan,
          now,
          ignoreSafetyEvents: false,
        });
        if (hold.active) {
          for (const id of ownIds) {
            keep(id, `guarda legal da conta (${hold.kinds.join(', ')})`);
          }
        }
      } catch (error) {
        this.failClosed(ownIds, keep, 'guarda legal da conta', error);
      }
    }
    return reasons;
  }

  private failClosed(
    ids: string[],
    keep: (id: string, reason: string) => void,
    what: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `Remoção: não deu para ler ${what} (${ids.length} geração(ões)); o arquivo será preservado: ${message.slice(0, 200)}`,
    );
    for (const id of ids)
      keep(id, `guarda não conferida (${what}): preservado`);
  }
}
