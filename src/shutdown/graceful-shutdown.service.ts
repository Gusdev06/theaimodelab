import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { InflightRunsService } from './inflight-runs.service';

/** Padrão: 4 min 30 s. Precisa ficar abaixo do stop_grace_period do container. */
const DEFAULT_DRAIN_MS = 270_000;

export function resolveDrainMs(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DRAIN_MS;
}

/**
 * No SIGTERM do redeploy, termina o que está gerando antes de a API cair.
 *
 * Fica no AppModule de propósito: o Nest chama `onModuleDestroy` do módulo raiz
 * primeiro, então a espera acontece enquanto Prisma, Redis e o canal de eventos
 * (módulos mais fundos) ainda estão abertos.
 *
 * - Workers do BullMQ: `close()` para de pegar job novo (o container novo pega) e
 *   espera o job ativo terminar.
 * - Execuções diretas (fora da fila): espera pelo InflightRunsService.
 *
 * Tudo limitado por SHUTDOWN_DRAIN_MS. Passou disso, segue o desligamento como antes.
 */
@Injectable()
export class GracefulShutdownService implements OnModuleDestroy {
  private readonly logger = new Logger(GracefulShutdownService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly inflightRuns: InflightRunsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    const drainMs = resolveDrainMs(process.env.SHUTDOWN_DRAIN_MS);
    const deadlineAt = Date.now() + drainMs;
    const workers = this.collectWorkers();
    const activeDirect = this.inflightRuns.size;

    this.logger.log(
      `[shutdown] esperando até ${Math.round(drainMs / 1000)} s: ${workers.length} worker(s) da fila + ${activeDirect} execução(ões) direta(s)`,
    );
    const startedAt = Date.now();

    const workersClosed = Promise.allSettled(workers.map((worker) => worker.close()));
    let timer: NodeJS.Timeout | undefined;
    const workersDeadline = new Promise<'prazo'>((resolve) => {
      timer = setTimeout(() => resolve('prazo'), drainMs);
    });

    const [workersResult, leftDirect] = await Promise.all([
      Promise.race([workersClosed.then(() => 'ok' as const), workersDeadline]),
      this.inflightRuns.drain(deadlineAt),
    ]);
    if (timer) clearTimeout(timer);

    this.logger.log(
      `[shutdown] fim da espera em ${Math.round((Date.now() - startedAt) / 1000)} s · fila=${workersResult} · diretas restantes=${leftDirect}`,
    );
  }

  private collectWorkers(): Array<WorkerHost['worker']> {
    return this.discovery
      .getProviders()
      .map((wrapper) => wrapper.instance as unknown)
      .filter((instance): instance is WorkerHost => instance instanceof WorkerHost)
      .map((host) => {
        try {
          return host.worker;
        } catch {
          return undefined; // worker ainda não criado (processador sem fila ativa)
        }
      })
      .filter((worker): worker is WorkerHost['worker'] => Boolean(worker));
  }
}
