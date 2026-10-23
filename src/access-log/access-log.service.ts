import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeIp, validPort } from './client-address';
import { safeId } from './access-log.routes';

/** Um acesso a gravar (horário do pedido, não da gravação). */
export interface AccessLogEntry {
  userId: string | null;
  route: string;
  generationId: string | null;
  ip: string | null;
  port: number | null;
  userAgent: string | null;
  at: Date;
}

/** Gravações em andamento; acima disso o acesso é descartado com aviso (enxurrada não derruba o banco nem a API). */
export const MAX_IN_FLIGHT_WRITES = 500;
export const MAX_USER_AGENT_LENGTH = 512;
export const MAX_ROUTE_LENGTH = 200;
/** Espera máxima pelas gravações em andamento quando a API desliga. */
export const SHUTDOWN_FLUSH_MS = 5_000;
/** Um aviso por minuto, no máximo, com a soma das falhas e descartes do período. */
const WARN_INTERVAL_MS = 60_000;
const UNKNOWN_ROUTE = 'desconhecida';

/** Texto de cabeçalho sem caractere de controle, aparado e cortado; vazio vira null. */
export function cleanHeaderText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
}

/** Linha pronta para o banco: tudo validado de novo aqui (quem chama pode mandar lixo; o banco nunca recebe). */
export function toAccessLogRow(
  entry: AccessLogEntry,
): Prisma.AccessLogCreateManyInput {
  const at =
    entry.at instanceof Date && Number.isFinite(entry.at.getTime())
      ? entry.at
      : new Date();
  return {
    userId: safeId(entry.userId),
    route: cleanHeaderText(entry.route, MAX_ROUTE_LENGTH) ?? UNKNOWN_ROUTE,
    generationId: safeId(entry.generationId),
    ip: normalizeIp(entry.ip),
    port: validPort(entry.port),
    userAgent: cleanHeaderText(entry.userAgent, MAX_USER_AGENT_LENGTH),
    createdAt: at,
  };
}

/**
 * Grava o registro de acesso (tabela access_log) fora do caminho da resposta: `record` nunca espera nem lança. Falha
 * do banco vira aviso (com o código do erro, nunca IP nem user agent) e o pedido segue. É obrigação legal (Marco Civil,
 * art. 15) e roda em qualquer modo da trava de imagem.
 */
@Injectable()
export class AccessLogService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(AccessLogService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private failed = 0;
  private dropped = 0;
  private lastFailureCode: string | null = null;
  private lastWarnAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** Agenda a gravação de um ou mais acessos e volta na hora. */
  record(entries: AccessLogEntry | readonly AccessLogEntry[]): void {
    try {
      const list: readonly AccessLogEntry[] = Array.isArray(entries)
        ? entries
        : [entries as AccessLogEntry];
      if (list.length === 0) return;
      if (this.inFlight.size >= MAX_IN_FLIGHT_WRITES) {
        this.dropped += list.length;
        this.warnThrottled();
        return;
      }
      const rows = list.map(toAccessLogRow);
      const write: Promise<void> = this.write(rows).finally(() => {
        this.inFlight.delete(write);
      });
      this.inFlight.add(write);
    } catch (error) {
      this.failed += 1;
      this.lastFailureCode = failureCode(error);
      this.warnThrottled();
    }
  }

  /** Espera as gravações em andamento (com teto de tempo). Usado no desligamento e nos testes. */
  async flush(timeoutMs = SHUTDOWN_FLUSH_MS): Promise<void> {
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([
        Promise.allSettled([...this.inFlight]).then(() => undefined),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.flush();
    if (this.inFlight.size > 0) {
      this.logger.warn(
        `registro de acesso: ${this.inFlight.size} gravação(ões) ainda em andamento no desligamento`,
      );
    }
  }

  private async write(rows: Prisma.AccessLogCreateManyInput[]): Promise<void> {
    try {
      if (rows.length === 1) {
        await this.prisma.accessLog.create({ data: rows[0] });
      } else {
        await this.prisma.accessLog.createMany({ data: rows });
      }
    } catch (error) {
      this.failed += rows.length;
      this.lastFailureCode = failureCode(error);
      this.warnThrottled();
    }
  }

  private warnThrottled(): void {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    const parts: string[] = [];
    if (this.failed)
      parts.push(
        `${this.failed} acesso(s) não gravado(s) (erro ${this.lastFailureCode ?? 'desconhecido'})`,
      );
    if (this.dropped)
      parts.push(
        `${this.dropped} descartado(s) por excesso de gravações em andamento`,
      );
    if (!parts.length) return;
    this.lastWarnAt = now;
    this.logger.warn(`registro de acesso: ${parts.join('; ')}`);
    this.failed = 0;
    this.dropped = 0;
  }
}

/** Código do erro (P2002, ECONNREFUSED...) ou o nome da classe: a mensagem do Prisma pode trazer os valores gravados. */
function failureCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code))
      return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(name))
      return name;
  }
  return 'desconhecido';
}
