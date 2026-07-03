import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type CronStatus = 'RUNNING' | 'SUCCESS' | 'ERROR';

/**
 * Envelopa execução de cron jobs registrando RUNNING → SUCCESS|ERROR
 * na tabela `cron_executions`. Usada pela tela admin /admin/crons.
 *
 * Uso típico nos services:
 *
 *   @Cron('0 * * * *')
 *   async handleX() {
 *     await this.cronLogger.wrap(
 *       { cronName: 'MyService.handleX', schedule: '0 * * * *' },
 *       async () => {
 *         // ... lógica do job ...
 *         return { processed: 5 }; // metadata opcional
 *       },
 *     );
 *   }
 */
@Injectable()
export class CronLoggerService {
  private readonly logger = new Logger(CronLoggerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async wrap<T extends Record<string, unknown> | void>(
    opts: { cronName: string; schedule: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = new Date();
    let executionId: string | null = null;

    try {
      const exec = await this.prisma.cronExecution.create({
        data: {
          cronName: opts.cronName,
          schedule: opts.schedule,
          status: 'RUNNING',
          startedAt,
        },
        select: { id: true },
      });
      executionId = exec.id;
    } catch (err: any) {
      // Falha de logging não pode quebrar o cron — só avisa
      this.logger.warn(`Não foi possível registrar início de ${opts.cronName}: ${err.message}`);
    }

    try {
      const result = await fn();
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      if (executionId) {
        await this.prisma.cronExecution
          .update({
            where: { id: executionId },
            data: {
              status: 'SUCCESS',
              finishedAt,
              durationMs,
              metadata: (result ?? undefined) as any,
            },
          })
          .catch((err) => {
            this.logger.warn(`Não foi possível registrar SUCCESS de ${opts.cronName}: ${err.message}`);
          });
      }

      return result;
    } catch (err: any) {
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      if (executionId) {
        await this.prisma.cronExecution
          .update({
            where: { id: executionId },
            data: {
              status: 'ERROR',
              finishedAt,
              durationMs,
              error: this.serializeError(err),
            },
          })
          .catch((logErr) => {
            this.logger.warn(`Não foi possível registrar ERROR de ${opts.cronName}: ${logErr.message}`);
          });
      }

      throw err; // relança pra preservar comportamento original
    }
  }

  private serializeError(err: unknown): string {
    if (err instanceof Error) {
      return `${err.message}\n${err.stack ?? ''}`.slice(0, 4000);
    }
    try {
      return JSON.stringify(err).slice(0, 4000);
    } catch {
      return String(err).slice(0, 4000);
    }
  }
}
